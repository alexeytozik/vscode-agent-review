'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createPatch } = require('diff');
const { assertSafe, decode, createPathPolicy, allowedFull } = require('./files');
const patchInput = require('./patch-input');
const { InvalidRecord, readRecord, quarantine, CONNECTION_LIMIT } = require('./hook-queue');
const { withCaptureLock } = require('./file-lock');
const { filterEvent } = require('./capture-policy');
const MAX = 20 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const feedbackCommit = Symbol('feedbackCommit');
function validatePrepared(record, root) {
  const text = value => value === null || typeof value === 'string' && Buffer.byteLength(value) <= 1024 * 1024 && Buffer.from(value).toString('utf8') === value;
  const inside = full => {
    if (typeof full !== 'string' || !path.isAbsolute(full) || full.includes('\0') || path.normalize(full) !== full) return false;
    const relative = path.relative(root, full); return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.created !== undefined && (!Number.isSafeInteger(record.created) || record.created < 0)) throw new InvalidRecord('Invalid prepared snapshot metadata.');
  if (record.ignored === true) return;
  if (typeof record.turn !== 'string' || !record.turn || record.turn.length > 512 || record.turn.includes('\0')) throw new InvalidRecord('Invalid prepared request.');
  if (record.unsupported === true) return;
  if (!Array.isArray(record.files) || record.files.length > 2000 || record.files.some(file => !file || !inside(file.path) || !text(file.expected) || !file.snapshot || !text(file.snapshot.disk) || !text(file.snapshot.text) ||
      file.snapshot.mode !== undefined && (!Number.isInteger(file.snapshot.mode) || file.snapshot.mode < 0 || file.snapshot.mode > 0o777) || file.snapshot.canonical !== undefined && !inside(file.snapshot.canonical))) throw new InvalidRecord('Invalid prepared file snapshot.');
}
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '-' + randomUUID() + '.tmp';
  let failed;
  try { await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
  catch (error) { failed = error; throw error; }
  finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT' && !failed) throw error; }); }
}
async function snapshot(root, cwd, name, policy) {
  const full = path.resolve(cwd, name), relative = path.relative(root, full);
  await assertSafe(root, relative, policy);
  try {
    const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular files can be reviewed.');
    if (stat.size > 1024 * 1024) throw new Error('File exceeds 1 MiB.');
    const disk = decode(await fs.readFile(full));
    return { path: full, snapshot: { disk, text: disk, dirty: false, mode: stat.mode & 0o777, canonical: await fs.realpath(full) } };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { path: full, snapshot: { disk: null, text: null, dirty: false, mode: 0o644, canonical: full } };
  }
}
async function prepareFeedback(store, session, root, hook, policy) {
  const directory = path.join(store, 'feedback', hash(session));
  const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const decisions = [], files = [];
  for (const name of names.filter(name => /^[\w-]+\.json$/.test(name)).sort()) {
    if (decisions.length === 2000) break;
    const file = path.join(directory, name);
    try {
      const decision = await readRecord(file, 16 * 1024);
      if (!decision || !['accept', 'reject'].includes(decision.action) || typeof decision.path !== 'string' || !path.isAbsolute(decision.path) || decision.path.includes('\0')) throw new InvalidRecord('Invalid feedback action or path.');
      if (decision.created !== undefined && (!Number.isSafeInteger(decision.created) || decision.created < 0)) throw new InvalidRecord('Invalid feedback timestamp.');
      const relative = path.relative(root, decision.path);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new InvalidRecord('Feedback path is outside this workspace.');
      if (!allowedFull(root, decision.path, policy)) { await fs.unlink(file); continue; }
      decisions.push(decision); files.push(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (!(error instanceof InvalidRecord)) throw error;
      await quarantine(path.join(store, 'feedback-quarantine'), file, error.message);
    }
  }
  if (!decisions.length) return {};
  const reread = [...new Set(decisions.filter(d => d.action === 'reject').map(d => path.relative(root, d.path)))];
  const batch = hash(JSON.stringify(files.map((file, index) => [path.basename(file), { action: decisions[index].action, path: decisions[index].path }]))).slice(0, 16);
  const response = { hookSpecificOutput: { hookEventName: hook, additionalContext: `The user reviewed local changes: ${decisions.filter(d => d.action === 'accept').length} kept, ${decisions.filter(d => d.action === 'reject').length} undone.${reread.length ? ' Re-read these files before editing: ' + JSON.stringify(reread).slice(0, 4000) : ''} Review batch: ${batch}; repeated delivery of this batch is the same set of decisions.` } };
  // Preparation is non-destructive. Only a successful local output write consumes
  // this batch; it is not an acknowledgement from the context recipient.
  Object.defineProperty(response, feedbackCommit, { value: async () => {
    for (const file of files) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } });
  return response;
}

async function deliver(response, write) {
  const output = JSON.stringify(response);
  await write(output);
  await response[feedbackCommit]?.();
}

async function handle(store, event) {
  const config = await readRecord(path.join(store, 'connection.json'), CONNECTION_LIMIT);
  const policy = createPathPolicy(config.exclude);
  if (Date.now() - config.updated > 30000 || !path.isAbsolute(config.root) || !path.isAbsolute(event.cwd || '')) return {};
  try { process.kill(config.pid, 0); } catch { return {}; }
  const cwd = await fs.realpath(event.cwd), relative = path.relative(config.root, cwd);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return {};
  for (const key of ['session_id', 'turn_id']) if (typeof event[key] !== 'string' || !event[key] || event[key].length > 512 || event[key].includes('\0')) return {};
  const common = { threadId: event.session_id, turnId: event.turn_id, skipReview: !config.enabled };
  async function commit(work) {
    return withCaptureLock(store, async () => {
      let current;
      try { current = await readRecord(path.join(store, 'connection.json'), CONNECTION_LIMIT); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (current.root !== config.root || current.instance !== config.instance || current.pid !== config.pid || !Number.isSafeInteger(current.updated) || Math.abs(Date.now() - current.updated) > 30000) return;
      return work(current, createPathPolicy(current.exclude));
    });
  }
  const emit = records => commit(async (current, currentPolicy) => {
    if (!current.enabled && records.some(record => record.type === 'fileChange')) return;
    records = records.map(record => filterEvent({ ...record, skipReview: record.skipReview || !current.enabled }, config.root, currentPolicy));
    if (Buffer.byteLength(JSON.stringify(records)) > MAX) records = [{ ...common, method: 'item/completed', type: 'externalTool', itemId: event.tool_use_id || 'limit' }];
    return atomic(path.join(store, 'events', process.hrtime.bigint().toString().padStart(24, '0') + '-' + randomUUID() + '.json'), { version: 1, created: Date.now(), records });
  });
  const hook = event.hook_event_name;
  if (hook === 'UserPromptSubmit') {
    await emit([{ ...common, method: 'turn/started' }]);
    return prepareFeedback(store, event.session_id, config.root, hook, policy);
  }
  if (['Stop', 'Interrupt'].includes(hook)) { await emit([{ ...common, method: 'turn/completed', status: hook === 'Stop' ? 'completed' : 'interrupted' }]); return {}; }
  const commandTool = /^(Bash|exec|exec_command|functions\.exec|functions\.exec_command)$/.test(event.tool_name || '');
  if (hook === 'PostToolUse' && (commandTool || /^mcp__/.test(event.tool_name || ''))) {
    await emit([{ ...common, method: 'item/completed', type: commandTool ? 'commandExecution' : 'externalTool', itemId: event.tool_use_id || 'external', readOnly: false }]);
    return {};
  }
  if (!['PreToolUse', 'PostToolUse'].includes(hook) || event.tool_name !== 'apply_patch' || typeof event.tool_use_id !== 'string' || !event.tool_use_id || event.tool_use_id.length > 512 || event.tool_use_id.includes('\0')) return {};
  let pending = path.join(store, 'pending', hash(event.session_id + '/' + event.turn_id + '/' + event.tool_use_id) + '.json');
  if (hook === 'PreToolUse') {
    let capture = { ignored: !config.enabled };
    if (config.enabled) try {
      const operations = patchInput.parse(event.tool_input?.command ?? event.tool_input);
      const files = [];
      for (const operation of operations) {
        const source = await snapshot(config.root, cwd, operation.path, policy);
        const expected = patchInput.apply(operation, source.snapshot.disk);
        files.push({ ...source, expected: operation.move ? null : expected });
        if (operation.move) {
          const destination = await snapshot(config.root, cwd, operation.move, policy);
          if (destination.snapshot.disk !== null) throw new Error('Rename destination already exists.');
          files.push({ ...destination, expected });
        }
      }
      if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate patch targets.');
      if (Buffer.byteLength(JSON.stringify(files)) > MAX) throw new Error('The patch exceeds the review limits.');
      capture = { files, turn: event.turn_id };
    } catch (error) { capture = { unsupported: true, turn: event.turn_id, ...(error.code === 'REVIEW_EXCLUDED' ? { reason: 'excluded' } : {}) }; }
    await commit(async (current, currentPolicy) => {
      if (!current.enabled) capture = { ignored: true };
      else if (capture.files?.some(file => !allowedFull(config.root, file.path, currentPolicy) || !allowedFull(config.root, file.snapshot.canonical, currentPolicy))) capture = { unsupported: true, turn: event.turn_id, reason: 'excluded' };
      await atomic(pending, { created: Date.now(), ...capture });
    });
    return {};
  }
  let before;
  try {
    try { before = await readRecord(pending, 25 * 1024 * 1024); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      pending = path.join(store, 'pending', hash(event.session_id + '/' + event.tool_use_id) + '.json');
      before = await readRecord(pending, 25 * 1024 * 1024);
    }
    validatePrepared(before, config.root);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (!(error instanceof InvalidRecord)) throw error;
    await quarantine(path.join(store, 'pending-quarantine'), pending, 'Invalid prepared tool snapshot.');
    await emit([{ ...common, method: 'item/completed', type: 'externalTool', itemId: event.tool_use_id }]); return {};
  }
  if (before.ignored || !config.enabled) { await fs.unlink(pending); return {}; }
  if (before.files?.some(file => !allowedFull(config.root, file.path, policy) || file.snapshot.canonical && !allowedFull(config.root, file.snapshot.canonical, policy))) {
    before = { created: before.created, unsupported: true, turn: before.turn, reason: 'excluded' }; await atomic(pending, before);
  }
  if (before.turn !== event.turn_id || before.unsupported) { await emit([{ ...common, method: 'item/completed', type: 'externalTool', itemId: event.tool_use_id, ...(before.reason === 'excluded' ? { skipReason: 'excluded' } : {}) }]); if (before.turn === event.turn_id) await fs.unlink(pending); return {}; }
  const changes = [], starts = [];
  for (const file of before.files) {
    const after = await snapshot(config.root, cwd, file.path, policy);
    if (file.snapshot.canonical !== after.snapshot.canonical) throw new Error('The file path changed during the operation.');
    if (after.snapshot.disk !== file.expected) { await emit([{ ...common, method: 'item/completed', type: 'externalTool', itemId: event.tool_use_id }]); continue; }
    if (file.snapshot.disk === after.snapshot.disk) continue;
    const kind = { type: file.snapshot.disk === null ? 'add' : after.snapshot.disk === null ? 'delete' : 'update' };
    changes.push({ ...after, kind, diff: (file.snapshot.disk ?? '') === (after.snapshot.disk ?? '') ? '' : createPatch(after.path, file.snapshot.disk ?? '', after.snapshot.disk ?? '') });
    starts.push(file);
  }
  if (changes.length) await emit([
    { ...common, method: 'item/started', type: 'fileChange', itemId: event.tool_use_id, changes: starts },
    { ...common, method: 'item/completed', type: 'fileChange', status: 'completed', itemId: event.tool_use_id, changes }
  ]);
  await fs.unlink(pending);
  return {};
}
function writeOutput(stream, output) {
  return new Promise((resolve, reject) => {
    const failed = error => reject(error);
    stream.once('error', failed);
    stream.write(output, error => {
      if (error) { reject(error); return; }
      stream.removeListener('error', failed); resolve();
    });
  });
}
async function run(store, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  let outputStarted = false;
  try {
    let input = '';
    for await (const chunk of stdin) { input += chunk; if (Buffer.byteLength(input) > MAX) throw new Error('Hook input exceeds the review limit.'); }
    const result = await handle(store, JSON.parse(input));
    await deliver(result, output => { outputStarted = true; return writeOutput(stdout, output); });
    return true;
  } catch (error) {
    stderr.write('Agent Review could not record this operation or deliver review feedback; review its changes manually.\n');
    // Never append another JSON object after a partial or successful response.
    if (!outputStarted) await writeOutput(stdout, JSON.stringify({ systemMessage: 'Agent Review could not record this operation or deliver review feedback; review its changes manually.' })).catch(() => {});
    return false;
  }
}
module.exports = { handle, run, snapshot, atomic, hash, deliver };
if (require.main === module) run(process.argv[2]);
