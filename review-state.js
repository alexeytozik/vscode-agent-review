'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { InvalidRecord, readRecord } = require('./hook-queue');
const MAX_STATE_BYTES = 40 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const strings = (value, length) => Array.isArray(value) && value.every(v => string(v, length));
const absolute = value => string(value, 32768) && path.isAbsolute(value) && path.normalize(value) === value;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

function validateState(saved, { root, aliases = [], recover = false } = {}) {
  const issues = [], fail = reason => { if (!recover) throw new Error('Invalid saved state: ' + reason); issues.push(reason); };
  // One byte budget bounds all active arrays and matches the writer. Small valid
  // pending files/operation IDs must not disappear on a later restart.
  if (!object(saved) || saved.version !== 2 || !Array.isArray(saved.turns) || Buffer.byteLength(JSON.stringify(saved)) > MAX_STATE_BYTES) {
    fail('envelope'); return { state: { version: 2, turns: [] }, issues };
  }
  function inside(full) {
    if (!absolute(full)) return false;
    if (root === undefined) return true;
    if (!root) return false;
    return [root, ...aliases].some(base => {
      const relative = path.relative(base, full);
      return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
  }
  const turnCounts = new Map();
  for (const turn of saved.turns) if (object(turn)) turnCounts.set(turn.key, (turnCounts.get(turn.key) || 0) + 1);
  const turns = [];
  for (const turn of saved.turns) {
    if (!object(turn) || !string(turn.id, 512) || !string(turn.threadId, 512) || turn.key !== turn.threadId + '/' + turn.id || turnCounts.get(turn.key) !== 1 ||
        !Number.isSafeInteger(turn.created) || turn.created < 0 || !strings(turn.warnings, 4096) || !strings(turn.seen, 512) ||
        new Set(turn.seen).size !== turn.seen.length || (turn.running !== undefined && typeof turn.running !== 'boolean') || !Array.isArray(turn.files)) {
      fail('request metadata'); continue;
    }
    const counts = new Map(), files = [];
    for (const file of turn.files) if (object(file)) counts.set(file.path, (counts.get(file.path) || 0) + 1);
    for (const file of turn.files) {
      if (!object(file) || !inside(file.path) || counts.get(file.path) !== 1 || ![file.baseline, file.expected].every(t => t === null || typeof t === 'string' && Buffer.byteLength(t) <= 1024 * 1024 && Buffer.from(t).toString('utf8') === t) ||
          !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || (file.canonical !== undefined && !inside(file.canonical)) ||
          (file.error !== undefined && !string(file.error, 4096)) || (file.diffError !== undefined && (!object(file.diffError) || !digest(file.diffError.revision) || !string(file.diffError.message, 4096))) ||
          (file.decision !== undefined && (!object(file.decision) || !digest(file.decision.id) || !digest(file.decision.revision) || !string(file.decision.hunk, 4096) || !['accept', 'reject'].includes(file.decision.action) || typeof file.decision.wasDirty !== 'boolean' || !inside(file.decision.canonical) || file.decision.created !== undefined && !timestamp(file.decision.created)))) {
        fail('file snapshot'); continue;
      }
      files.push({ path: file.path, baseline: file.baseline, expected: file.expected, mode: file.mode,
        ...(file.canonical !== undefined ? { canonical: file.canonical } : {}), ...(file.error !== undefined ? { error: file.error } : {}),
        ...(file.diffError !== undefined ? { diffError: { revision: file.diffError.revision, message: file.diffError.message } } : {}),
        ...(file.decision !== undefined ? { decision: { id: file.decision.id, action: file.decision.action, revision: file.decision.revision, hunk: file.decision.hunk, wasDirty: file.decision.wasDirty, canonical: file.decision.canonical, ...(file.decision.created !== undefined ? { created: file.decision.created } : {}) } } : {}) });
    }
    turns.push({ key: turn.key, id: turn.id, threadId: turn.threadId, created: turn.created, running: false, warnings: [...turn.warnings], seen: [...turn.seen], files });
  }
  const retired = [];
  if (saved.retired !== undefined) {
    if (!Array.isArray(saved.retired) || saved.retired.length > 512) fail('completed request metadata');
    else {
      const checked = validateState({ version: 2, turns: saved.retired.map(t => object(t) ? { ...t, files: [] } : t) }, { root, aliases, recover });
      issues.push(...checked.issues);
      let ids = 0;
      for (const turn of checked.state.turns) {
        if (turns.some(t => t.key === turn.key) || ids + turn.seen.length > 4096) { fail('completed request metadata'); continue; }
        ids += turn.seen.length;
        const { files, ...metadata } = turn; retired.push(metadata);
      }
    }
  }
  const feedback = [];
  if (saved.feedback !== undefined) {
    if (!Array.isArray(saved.feedback) || saved.feedback.length > 10000) fail('feedback queue');
    else {
      const ids = new Map(); for (const record of saved.feedback) if (object(record)) ids.set(record.id, (ids.get(record.id) || 0) + 1);
      for (const record of saved.feedback) {
        if (!object(record) || !digest(record.id) || ids.get(record.id) !== 1 || !string(record.turn, 1025) || !record.turn.includes('/') || !inside(record.path) || !['accept', 'reject'].includes(record.action) || record.created !== undefined && !timestamp(record.created)) { fail('feedback record'); continue; }
        feedback.push({ id: record.id, turn: record.turn, path: record.path, action: record.action, ...(record.created !== undefined ? { created: record.created } : {}) });
      }
    }
  }
  return { state: { version: 2, turns, ...(retired.length ? { retired } : {}), ...(feedback.length ? { feedback } : {}) }, issues };
}

function createStateStore(file) {
  let preserve, backup, issue, retry = false;
  async function load(legacy, options) {
    let source = file;
    try { await fs.lstat(file); }
    catch (error) {
      if (error.code !== 'ENOENT') { retry = true; issue = 'Could not read the saved queue; retry its original before saving.'; throw error; }
      if (!legacy) { retry = false; return { state: { version: 2, turns: [] }, issues: [] }; }
      source = legacy;
    }
    try {
      const saved = await readRecord(source, MAX_STATE_BYTES);
      const result = validateState(saved, { ...options, recover: true });
      retry = false;
      if (result.issues.length) { preserve = source; issue = 'Some saved queue records were invalid and were not restored.'; }
      return { ...result, migrated: source !== file };
    } catch (error) {
      if (error.code === 'ENOENT') { retry = false; return { state: { version: 2, turns: [] }, issues: [] }; }
      if (!(error instanceof InvalidRecord)) {
        retry = true; issue = 'Could not read the saved queue; retry its original before saving.'; throw error;
      }
      // Keep the original before any subsequent write, including unreadable JSON.
      retry = false; preserve = source; issue = 'The saved queue could not be restored; its original must be preserved before saving.';
      throw error;
    }
  }
  async function save(state) {
    if (retry) throw new Error('The original saved queue must be read successfully before saving.');
    const data = JSON.stringify(state);
    if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw new Error('Saved snapshots exceed 40 MiB. Finish reviewing older requests.');
    validateState(state);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if (preserve) {
      const original = await fs.lstat(preserve);
      if (!original.isFile() || original.isSymbolicLink()) throw new Error('The saved queue is not a regular file. It was left unchanged.');
      const destination = path.join(path.dirname(file), 'request-review.corrupt-' + randomUUID() + '.json');
      await fs.copyFile(preserve, destination, constants.COPYFILE_EXCL);
      await fs.chmod(destination, 0o600);
      backup = destination; preserve = undefined;
    }
    const existing = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('The saved queue is not a regular file. It was left unchanged.');
    const temp = file + '.' + process.pid + '-' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { load, save, status: () => ({ issue, backup, blocked: Boolean(preserve) || retry, retry }) };
}

module.exports = { validateState, createStateStore, MAX_STATE_BYTES };
