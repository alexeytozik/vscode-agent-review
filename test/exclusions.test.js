'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { handle, atomic, deliver, hash } = require('../hook-runner');
async function fixture(t, excludes = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-exclude.'))), workspace = path.join(root, 'workspace'), store = path.join(root, 'store');
  await fs.mkdir(workspace); await atomic(path.join(store, 'connection.json'), { root: workspace, enabled: true, pid: process.pid, updated: Date.now(), exclude: excludes });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const call = (hook, name, patch) => handle(store, { cwd: workspace, hook_event_name: hook, session_id: 'session', turn_id: 'request', tool_use_id: 'operation', tool_name: 'apply_patch', tool_input: { command: patch } });
  async function allText(directory = store) { let result = ''; for (const e of await fs.readdir(directory, { withFileTypes: true })) { const full = path.join(directory, e.name); if (e.isDirectory()) result += await allText(full); else if (e.isFile()) result += await fs.readFile(full, 'utf8'); } return result; }
  return { root, workspace, store, call, allText };
}
for (const name of ['.npmrc', '.netrc', 'kubeconfig', 'token.secret', 'secrets.yaml', 'private/settings.yaml']) test('R17 excluded source never reaches pending/events/feedback: ' + name, async t => {
  const f = await fixture(t, ['private/**']), marker = 'private-fixture-value-5824', full = path.join(f.workspace, name);
  await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, marker + '\n');
  const patch = '*** Begin Patch\n*** Update File: ' + name + '\n@@\n-' + marker + '\n+' + marker + '-changed\n*** End Patch';
  await f.call('PreToolUse', name, patch); assert.ok(!(await f.allText()).includes(marker));
  await fs.writeFile(full, marker + '-changed\n'); await f.call('PostToolUse', name, patch);
  assert.ok(!(await f.allText()).includes(marker)); assert.match(await f.allText(), /excluded/);
  await atomic(path.join(f.store, 'feedback', hash('session'), 'excluded.json'), { action: 'reject', path: full });
  const result = await f.call('UserPromptSubmit'); await deliver(result, async output => { assert.ok(!output.includes(name)); assert.ok(!output.includes(marker)); });
});
test('R17 gitignore is not a blanket privacy rule; ordinary YAML/tfvars patches still capture', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.workspace, '.gitignore'), '*.yaml\n*.tfvars\n');
  for (const name of ['service.yaml', 'terraform.tfvars']) {
    const full = path.join(f.workspace, name), patch = '*** Begin Patch\n*** Update File: ' + name + '\n@@\n-before\n+after\n*** End Patch';
    await fs.writeFile(full, 'before\n'); await f.call('PreToolUse', name, patch); await fs.writeFile(full, 'after\n'); await f.call('PostToolUse', name, patch);
  }
  const text = await f.allText(); assert.match(text, /fileChange/); assert.match(text, /service.yaml/); assert.match(text, /terraform.tfvars/);
});
test('R17 changing exclusions scrubs a prepared snapshot before a later PostToolUse', async t => {
  const f = await fixture(t), full = path.join(f.workspace, 'settings.yaml'), marker = 'prepared-private-value-3619';
  const patch = '*** Begin Patch\n*** Update File: settings.yaml\n@@\n-' + marker + '\n+changed\n*** End Patch';
  await fs.writeFile(full, marker + '\n'); await f.call('PreToolUse', 'settings.yaml', patch); assert.ok((await f.allText()).includes(marker));
  const config = JSON.parse(await fs.readFile(path.join(f.store, 'connection.json'), 'utf8')); await atomic(path.join(f.store, 'connection.json'), { ...config, exclude: ['settings.yaml'] });
  await fs.writeFile(full, 'changed\n'); await f.call('PostToolUse', 'settings.yaml', patch);
  assert.ok(!(await f.allText()).includes(marker)); assert.match(await f.allText(), /excluded/);
});
test('R17 policy cleanup removes old excluded payloads but preserves allowed pending and neighbours', async t => {
  const f = await fixture(t), { scrubPolicyStore } = require('../capture-policy'), { createPathPolicy } = require('../files');
  const protectedFile = path.join(f.workspace, 'settings.yaml'), safeFile = path.join(f.workspace, 'safe.txt'), marker = 'old-private-value-2618';
  const change = full => ({ path: full, snapshot: { disk: marker, text: marker, mode: 0o644, canonical: full }, kind: { type: 'update' }, diff: marker });
  await atomic(path.join(f.store, 'pending', 'old.json'), { turn: 'request', files: [change(protectedFile)] });
  await atomic(path.join(f.store, 'pending', 'safe.json'), { turn: 'safe', files: [{ ...change(safeFile), snapshot: { disk: 'allowed', text: 'allowed' }, diff: 'allowed' }] });
  await atomic(path.join(f.store, 'events', '001-old.json'), { version: 1, records: [{ method: 'item/completed', type: 'fileChange', threadId: 'session', turnId: 'request', itemId: 'item', status: 'completed', changes: [change(protectedFile), { ...change(safeFile), snapshot: { disk: 'allowed', text: 'allowed' }, diff: 'allowed' }] }] });
  await atomic(path.join(f.store, 'feedback', hash('session'), 'old.json'), { action: 'reject', path: protectedFile });
  const removed = await scrubPolicyStore(f.store, f.workspace, createPathPolicy(['settings.yaml']), atomic);
  assert.equal(removed, 3); const text = await f.allText(); assert.ok(!text.includes(marker)); assert.match(text, /allowed/); assert.match(text, /excluded/);
  const event = JSON.parse(await fs.readFile(path.join(f.store, 'events', '001-old.json'), 'utf8')).records[0]; assert.equal(event.changes.length, 1); assert.equal(event.changes[0].path, safeFile);
});
for (const [directory, name] of [['.aws', 'config'], ['.kube', 'config'], ['.ssh', 'config'], ['.gnupg', 'settings'], ['.docker', 'config.json']]) test('R17 a credential directory used as workspace root remains protected: ' + directory, async t => {
  const f = await fixture(t), workspace = path.join(f.root, directory), full = path.join(workspace, name), marker = 'credential-root-value-7951';
  await fs.mkdir(workspace); await fs.writeFile(full, marker + '\n');
  await atomic(path.join(f.store, 'connection.json'), { root: workspace, enabled: true, pid: process.pid, updated: Date.now() });
  const { allowedFull, assertSafe, createPathPolicy } = require('../files');
  assert.equal(allowedFull(workspace, full, createPathPolicy()), false);
  await assert.rejects(assertSafe(workspace, name), { code: 'REVIEW_EXCLUDED' });
  await handle(f.store, { cwd: workspace, hook_event_name: 'PreToolUse', session_id: 'session', turn_id: 'request', tool_use_id: 'operation', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: ' + name + '\n@@\n-' + marker + '\n+changed\n*** End Patch' } });
  assert.ok(!(await f.allText()).includes(marker));
});
test('R17 credential ancestry also protects a canonical target behind a workspace alias', async t => {
  const f = await fixture(t), workspace = path.join(f.root, '.aws'), alias = path.join(f.root, 'alias'); await fs.mkdir(workspace); await fs.symlink(workspace, alias); await fs.writeFile(path.join(workspace, 'config'), 'private');
  await assert.rejects(require('../files').assertSafe(alias, 'config'), { code: 'REVIEW_EXCLUDED' });
  const ordinary = path.join(f.root, 'build'); await fs.mkdir(ordinary); await fs.writeFile(path.join(ordinary, 'source.txt'), 'ordinary');
  assert.equal(await require('../files').assertSafe(ordinary, 'source.txt'), path.join(ordinary, 'source.txt'));
});
async function connected(t, onReceive = () => {}) {
  const f = await fixture(t), received = [], errors = []; let patterns = [];
  const connection = require('../hook-connection').createConnection({ root: f.workspace, storage: f.store, extensionPath: path.dirname(__dirname), executable: process.execPath, home: path.join(f.root, 'home'), receive: async event => { received.push(event); await onReceive(event); }, enabled: () => true, exclude: () => patterns, report: error => { errors.push(error); } });
  await connection.ready; await connection.connect();
  const event = hook => ({ cwd: f.workspace, hook_event_name: hook, session_id: 'session', turn_id: 'request', tool_use_id: 'operation', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: settings.yaml\n@@\n-private-race-value-2186\n+changed\n*** End Patch' } });
  return { ...f, connection, event, received, errors, setPatterns: value => { patterns = value; } };
}
test('R17 a Pre paused on its source read cannot commit an obsolete policy after scrub', async t => {
  const f = await connected(t), full = path.join(f.workspace, 'settings.yaml'); await fs.writeFile(full, 'private-race-value-2186\n');
  let entered, release; const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; }), readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args) => { const value = await readFile(...args); if (args[0] === full) { entered(); await resume; } return value; });
  try {
    const pre = handle(f.connection.store, f.event('PreToolUse')); await reached;
    f.setPatterns(['settings.yaml']); await f.connection.update(); release(); await pre;
    assert.ok(!(await f.allText()).includes('private-race-value-2186'));
  } finally { release(); await f.connection.disconnect(); await f.connection.dispose(); }
});
test('R17 a policy update waits for an already committing Pre and scrubs its committed source', async t => {
  const f = await connected(t), full = path.join(f.workspace, 'settings.yaml'); await fs.writeFile(full, 'private-race-value-2186\n');
  let entered, release; const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; }), rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args) => { if (path.dirname(args[1]) === path.join(f.connection.store, 'pending')) { entered(); await resume; } return rename(...args); });
  try {
    const pre = handle(f.connection.store, f.event('PreToolUse')); await reached;
    f.setPatterns(['settings.yaml']); let updated = false; const update = f.connection.update().then(() => { updated = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); const raced = updated; release(); await Promise.all([pre, update]);
    assert.equal(raced, false); assert.ok(!(await f.allText()).includes('private-race-value-2186'));
  } finally { release(); await f.connection.disconnect(); await f.connection.dispose(); }
});
test('R17 a Post paused during verification cannot emit excluded source after scrub', async t => {
  const f = await connected(t), full = path.join(f.workspace, 'settings.yaml'); await fs.writeFile(full, 'private-race-value-2186\n'); await handle(f.connection.store, f.event('PreToolUse')); await fs.writeFile(full, 'changed\n');
  let entered, release; const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; }), readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args) => { const value = await readFile(...args); if (args[0] === full) { entered(); await resume; } return value; });
  try {
    const post = handle(f.connection.store, f.event('PostToolUse')); await reached;
    f.setPatterns(['settings.yaml']); await f.connection.update(); release(); await post; await f.connection.drain();
    assert.ok(!(await f.allText()).includes('private-race-value-2186')); assert.ok(!JSON.stringify(f.received).includes('private-race-value-2186')); assert.ok(f.received.some(event => event.skipReason === 'excluded'));
  } finally { release(); await f.connection.disconnect(); await f.connection.dispose(); }
});
test('R17 a delayed partial event rewrite cannot restore source after a second exclusion change', async t => {
  const f = await connected(t, () => { throw Object.assign(new Error('receive failed'), { code: 'EIO' }); });
  f.setPatterns(['first.txt']); await f.connection.update();
  const file = path.join(f.connection.store, 'events', '001-backlog.json'), marker = 'second-excluded-value-8263';
  const change = name => ({ path: path.join(f.workspace, name), kind: { type: 'update' }, diff: '', snapshot: { disk: marker, text: marker, mode: 0o644 } });
  let entered, release, hit = false; const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; }), rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args) => { if (!hit && args[1] === file) { hit = true; entered(); await resume; } return rename(...args); });
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, records: [{ method: 'item/completed', type: 'fileChange', threadId: 'session', turnId: 'request', itemId: 'operation', status: 'completed', changes: [change('first.txt'), change('second.txt')] }] }));
    const drain = f.connection.drain(); await reached;
    f.setPatterns(['first.txt', 'second.txt']); let updated = false; const update = f.connection.update().then(() => { updated = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); const raced = updated; release(); await Promise.all([update, drain]);
    assert.equal(raced, false); assert.ok(!(await fs.readFile(file, 'utf8')).includes(marker)); assert.ok(f.errors.some(error => error.code === 'EIO'));
  } finally { release(); await f.connection.disconnect(); await f.connection.dispose(); }
});
