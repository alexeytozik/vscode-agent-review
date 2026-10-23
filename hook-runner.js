'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createPatch } = require('diff');
const { assertSafe, decode } = require('./files');
const patchInput = require('./patch-input');
const MAX = 20 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
}
async function snapshot(root, cwd, name) {
  const full = path.resolve(cwd, name), relative = path.relative(root, full);
  await assertSafe(root, relative);
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
async function handle(store, event) {
  const config = JSON.parse(await fs.readFile(path.join(store, 'connection.json'), 'utf8'));
  if (Date.now() - config.updated > 30000 || !path.isAbsolute(config.root) || !path.isAbsolute(event.cwd || '')) return {};
  try { process.kill(config.pid, 0); } catch { return {}; }
  const cwd = await fs.realpath(event.cwd), relative = path.relative(config.root, cwd);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return {};
  for (const key of ['session_id', 'turn_id']) if (typeof event[key] !== 'string' || !event[key] || event[key].length > 512) return {};
  const common = { threadId: event.session_id, turnId: event.turn_id, skipReview: !config.enabled };
  const emit = records => {
    if (Buffer.byteLength(JSON.stringify(records)) > MAX) records = [{ ...common, method: 'item/completed', type: 'externalTool', itemId: event.tool_use_id || 'limit' }];
    return atomic(path.join(store, 'events', process.hrtime.bigint().toString().padStart(24, '0') + '-' + randomUUID() + '.json'), { version: 1, records });
  };
  const hook = event.hook_event_name;
  if (hook === 'UserPromptSubmit') {
    await emit([{ ...common, method: 'turn/started' }]);
    const feedback = path.join(store, 'feedback', hash(event.session_id));
    const names = await fs.readdir(feedback).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const decisions = [];
    for (const name of names.filter(name => /^[\w-]+\.json$/.test(name)).sort().slice(0, 2000)) {
      const file = path.join(feedback, name); decisions.push(JSON.parse(await fs.readFile(file, 'utf8'))); await fs.unlink(file);
    }
    if (decisions?.length) {
      const files = [...new Set(decisions.filter(d => d.action === 'reject').map(d => path.relative(config.root, d.path)))];
      return { hookSpecificOutput: { hookEventName: hook, additionalContext: `The user reviewed local changes: ${decisions.filter(d => d.action === 'accept').length} kept, ${decisions.filter(d => d.action === 'reject').length} undone.${files.length ? ' Re-read these files before editing: ' + JSON.stringify(files).slice(0, 4000) : ''}` } };
    }
    return {};
  }
  if (['Stop', 'Interrupt'].includes(hook)) { await emit([{ ...common, method: 'turn/completed', status: hook === 'Stop' ? 'completed' : 'interrupted' }]); return {}; }
  if (hook === 'PostToolUse' && (event.tool_name === 'Bash' || /^mcp__/.test(event.tool_name || ''))) {
    await emit([{ ...common, method: 'item/completed', type: event.tool_name === 'Bash' ? 'commandExecution' : 'externalTool', itemId: event.tool_use_id || 'external', readOnly: false }]);
    return {};
  }
  if (!['PreToolUse', 'PostToolUse'].includes(hook) || event.tool_name !== 'apply_patch' || typeof event.tool_use_id !== 'string' || !event.tool_use_id || event.tool_use_id.length > 512) return {};
  const pending = path.join(store, 'pending', hash(event.session_id + '/' + event.tool_use_id) + '.json');
  if (hook === 'PreToolUse') {
    let capture = { ignored: !config.enabled };
    if (config.enabled) try {
      const operations = patchInput.parse(event.tool_input?.command ?? event.tool_input);
      const files = [];
      for (const operation of operations) {
        const source = await snapshot(config.root, cwd, operation.path);
        const expected = patchInput.apply(operation, source.snapshot.disk);
        files.push({ ...source, expected: operation.move ? null : expected });
        if (operation.move) {
          const destination = await snapshot(config.root, cwd, operation.move);
          if (destination.snapshot.disk !== null) throw new Error('Rename destination already exists.');
          files.push({ ...destination, expected });
        }
      }
      if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate patch targets.');
      if (Buffer.byteLength(JSON.stringify(files)) > MAX) throw new Error('The patch exceeds the review limits.');
      capture = { files, turn: event.turn_id };
    } catch { capture = { unsupported: true, turn: event.turn_id }; }
    await atomic(pending, capture);
    return {};
  }
  let before;
  try { before = JSON.parse(await fs.readFile(pending, 'utf8')); await fs.unlink(pending); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (before.ignored || !config.enabled) return {};
  if (before.turn !== event.turn_id || before.unsupported) { await emit([{ ...common, method: 'item/completed', type: 'externalTool', itemId: event.tool_use_id }]); return {}; }
  const changes = [], starts = [];
  for (const file of before.files) {
    const after = await snapshot(config.root, cwd, file.path);
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
  return {};
}
async function run(store) {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > MAX) throw new Error('Hook input exceeds the review limit.'); }
    const result = await handle(store, JSON.parse(input));
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write('Agent Review could not record this operation; review its changes manually.\n');
    process.stdout.write(JSON.stringify({ systemMessage: 'Agent Review could not record this operation; review its changes manually.' }));
  }
}
module.exports = { handle, run, snapshot, atomic, hash };
if (require.main === module) run(process.argv[2]);
