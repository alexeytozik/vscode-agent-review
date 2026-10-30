'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cleanOrphanTemps, inspectData, clearData, createDataWalker } = require('../lifecycle-retention');
const { atomic, handle, hash } = require('../hook-runner');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-retention.'))), store = path.join(root, 'lifecycle');
  await fs.mkdir(store); await fs.mkdir(path.join(store, 'pending')); t.after(() => fs.rm(root, { recursive: true, force: true })); return { root, store };
}
test('R18 automatic cleanup removes a dead writer draft, retaining active, legacy and future-dated pending data', async t => {
  const f = await fixture(t), active = path.join(f.store, 'event.json.' + process.pid + '-' + randomUUID() + '.tmp'), legacy = path.join(f.store, 'event.json.' + randomUUID() + '.tmp');
  await fs.writeFile(active, 'active'); await fs.utimes(active, 1, 1); await fs.writeFile(legacy, 'unknown owner');
  const child = spawnSync(process.execPath, ['-e', "const fs=require('node:fs'),path=require('node:path');const file=path.join(process.argv[1],'event.json.'+process.pid+'-'+require('node:crypto').randomUUID()+'.tmp');fs.writeFileSync(file,'abandoned');fs.utimesSync(file,4102444800,4102444800);process.stdout.write(file);", f.store], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(child.status, 0, child.stderr); const abandoned = child.stdout;
  await atomic(path.join(f.store, 'pending', 'future.json'), { created: 4102444800000, files: [{ snapshot: { disk: 'pending source' } }] });
  const result = await cleanOrphanTemps(f.store); assert.equal(result.removed, 1);
  await assert.rejects(fs.lstat(abandoned), { code: 'ENOENT' }); assert.equal(await fs.readFile(active, 'utf8'), 'active'); assert.equal(await fs.readFile(legacy, 'utf8'), 'unknown owner');
  assert.match(await fs.readFile(path.join(f.store, 'pending', 'future.json'), 'utf8'), /pending source/);
});
test('R18 cleanup is bounded and never follows a symbolic link or expires an unresolved queue', async t => {
  const f = await fixture(t), queue = path.join(f.root, 'request-review.json'), target = path.join(f.root, 'outside'); await fs.writeFile(queue, 'unresolved snapshot'); await fs.writeFile(target, 'keep');
  for (let i = 0; i < 50; i++) await fs.writeFile(path.join(f.store, 'event.json.999999-' + randomUUID() + '.tmp'), 'draft');
  const link = path.join(f.store, 'event.json.999999-' + randomUUID() + '.tmp'); await fs.symlink(target, link);
  const result = await cleanOrphanTemps(f.store, { maxEntries: 64, maxRemove: 10, isAlive: () => false });
  assert.equal(result.removed, 10); assert.ok(result.scanned <= 64); assert.equal(await fs.readFile(queue, 'utf8'), 'unresolved snapshot'); assert.equal(await fs.readFile(target, 'utf8'), 'keep'); assert.ok((await fs.lstat(link)).isSymbolicLink());
});
test('R18 explicit cleanup refuses a connected integration and protects source and saved queue', async t => {
  const f = await fixture(t), queue = path.join(f.root, 'request-review.json'), source = path.join(f.root, 'project.txt'); await fs.writeFile(queue, 'unresolved'); await fs.writeFile(source, 'source');
  for (const [directory, name] of [['pending', 'one.json'], ['events', 'one.json'], ['feedback/session', 'one.json'], ['event-quarantine', 'one.record']]) { await fs.mkdir(path.join(f.store, directory), { recursive: true }); await fs.writeFile(path.join(f.store, directory, name), 'private test payload'); }
  await fs.writeFile(path.join(f.root, 'request-review.corrupt-' + randomUUID() + '.json'), 'recovery'); await fs.writeFile(path.join(f.store, 'hooks-backup-1.json'), 'config recovery');
  const report = await inspectData(f.store); assert.equal(report.categories.pending.files, 1); assert.equal(report.categories.feedback.files, 1); assert.equal(report.categories.backups.files, 2); assert.ok(!JSON.stringify(report).includes('private test payload')); assert.ok(!JSON.stringify(report).includes(f.root));
  await assert.rejects(clearData(f.store, ['pending'], { connected: true }), /Disconnect/);
  await assert.rejects(clearData(f.store, ['queue']), /scope/);
  const cleared = await clearData(f.store, ['pending', 'events', 'feedback', 'quarantine', 'backups'], { connected: false }); assert.equal(cleared.removed, 6);
  assert.equal(await fs.readFile(queue, 'utf8'), 'unresolved'); assert.equal(await fs.readFile(source, 'utf8'), 'source');
});
test('R18 a missing PostToolUse survives restart/clock skew and a later Post still verifies the original snapshot', async t => {
  const f = await fixture(t), workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace); const full = path.join(workspace, 'file.txt'); await fs.writeFile(full, 'before\n');
  const config = { root: workspace, pid: process.pid, enabled: true, instance: 'current', updated: Date.now() }; await atomic(path.join(f.store, 'connection.json'), config);
  const event = hook => ({ cwd: workspace, hook_event_name: hook, session_id: 'session', turn_id: 'request', tool_use_id: 'operation', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch' } });
  await handle(f.store, event('PreToolUse')); const pending = path.join(f.store, 'pending', hash('session/request/operation') + '.json'), saved = JSON.parse(await fs.readFile(pending, 'utf8'));
  assert.ok(Number.isSafeInteger(saved.created)); saved.created = 4102444800000; await atomic(pending, saved); await cleanOrphanTemps(f.store);
  assert.equal((await fs.stat(pending)).isFile(), true);
  await atomic(path.join(f.store, 'connection.json'), { ...config, instance: 'restarted', updated: Date.now() }); await fs.writeFile(full, 'after\n'); await handle(f.store, event('PostToolUse'));
  await assert.rejects(fs.stat(pending), { code: 'ENOENT' });
  const records = (await Promise.all((await fs.readdir(path.join(f.store, 'events'))).map(name => fs.readFile(path.join(f.store, 'events', name), 'utf8')))).map(JSON.parse);
  assert.ok(records.every(record => Number.isSafeInteger(record.created))); assert.equal(records.flatMap(r => r.records).filter(r => r.type === 'fileChange').length, 2);
});
test('R18 failed atomic replacement cleans only its own temporary file', async t => {
  const f = await fixture(t), file = path.join(f.store, 'event.json'), other = path.join(f.store, 'other.tmp'); await fs.writeFile(file, 'original'); await fs.writeFile(other, 'other');
  t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('replace failed'), { code: 'EIO' }); });
  await assert.rejects(atomic(file, { changed: true }), { code: 'EIO' }); assert.deepEqual((await fs.readdir(f.store)).sort(), ['event.json', 'other.tmp', 'pending']); assert.equal(await fs.readFile(file, 'utf8'), 'original');
});
test('R18 repeated bounded batches advance beyond an unchanged pending backlog', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 150; i++) await fs.writeFile(path.join(f.store, 'pending', 'item-' + i + '.json'), 'pending');
  const draft = path.join(f.store, 'event.json.999999-' + randomUUID() + '.tmp'); await fs.writeFile(draft, 'abandoned');
  const walker = createDataWalker(f.store); let removed = 0;
  try { for (let i = 0; i < 10; i++) { const result = await clearData(f.store, ['temporary'], { connected: false, maxEntries: 32, walker, isAlive: () => false }); assert.ok(result.scanned <= 32); removed += result.removed; if (!result.truncated) break; } }
  finally { await walker.return(); }
  assert.equal(removed, 1); assert.equal((await fs.readdir(path.join(f.store, 'pending'))).length, 150);
});
test('R18 overlapping requests with the same tool ID retain independent prepared snapshots', async t => {
  const f = await fixture(t), workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace); await atomic(path.join(f.store, 'connection.json'), { root: workspace, pid: process.pid, enabled: true, updated: Date.now() });
  const event = (hook, turn) => ({ cwd: workspace, hook_event_name: hook, session_id: 'session', turn_id: turn, tool_use_id: 'shared', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: ' + turn + '.txt\n@@\n-before\n+after\n*** End Patch' } });
  for (const turn of ['a', 'b']) { await fs.writeFile(path.join(workspace, turn + '.txt'), 'before\n'); await handle(f.store, event('PreToolUse', turn)); }
  assert.equal((await fs.readdir(path.join(f.store, 'pending'))).filter(n => n.endsWith('.json')).length, 2);
  for (const turn of ['a', 'b']) { await fs.writeFile(path.join(workspace, turn + '.txt'), 'after\n'); await handle(f.store, event('PostToolUse', turn)); }
  const records = (await Promise.all((await fs.readdir(path.join(f.store, 'events'))).map(name => fs.readFile(path.join(f.store, 'events', name), 'utf8')))).map(JSON.parse).flatMap(r => r.records);
  assert.equal(records.filter(r => r.type === 'fileChange' && r.method === 'item/completed').length, 2);
});
test('R18 a legacy prepared key remains consumable without expiring its payload', async t => {
  const f = await fixture(t), workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace); await atomic(path.join(f.store, 'connection.json'), { root: workspace, pid: process.pid, enabled: true, updated: Date.now() });
  const full = path.join(workspace, 'file.txt'); await fs.writeFile(full, 'before\n');
  const event = hook => ({ cwd: workspace, hook_event_name: hook, session_id: 'session', turn_id: 'request', tool_use_id: 'operation', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch' } });
  await handle(f.store, event('PreToolUse'));
  const current = path.join(f.store, 'pending', hash('session/request/operation') + '.json'), legacy = path.join(f.store, 'pending', hash('session/operation') + '.json');
  await fs.rename(current, legacy); await fs.writeFile(full, 'after\n'); await handle(f.store, event('PostToolUse')); await assert.rejects(fs.stat(legacy), { code: 'ENOENT' });
  assert.equal((await fs.readdir(path.join(f.store, 'events'))).length, 1);
});
for (const kind of ['json', 'schema', 'symlink', 'oversize']) test('R18 invalid prepared ' + kind + ' is isolated without reading an outside target', async t => {
  const f = await fixture(t), workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace); await atomic(path.join(f.store, 'connection.json'), { root: workspace, pid: process.pid, enabled: true, updated: Date.now() });
  const pending = path.join(f.store, 'pending', hash('session/request/operation') + '.json'), target = path.join(f.root, 'outside'), marker = 'outside-fixture-value-3602'; await fs.writeFile(target, marker);
  if (kind === 'json') await fs.writeFile(pending, '{');
  else if (kind === 'schema') await atomic(pending, { turn: 'request', files: [{ path: path.join(workspace, 'file'), expected: 'new', snapshot: { disk: 'old', text: 'old', mode: '644' } }] });
  else if (kind === 'symlink') await fs.symlink(target, pending);
  else { await fs.writeFile(pending, ''); await fs.truncate(pending, 25 * 1024 * 1024 + 1); }
  await handle(f.store, { cwd: workspace, session_id: 'session', turn_id: 'request', tool_use_id: 'operation', hook_event_name: 'PostToolUse', tool_name: 'apply_patch' });
  await assert.rejects(fs.lstat(pending), { code: 'ENOENT' }); assert.equal(await fs.readFile(target, 'utf8'), marker);
  const events = (await Promise.all((await fs.readdir(path.join(f.store, 'events'))).map(name => fs.readFile(path.join(f.store, 'events', name), 'utf8')))).join(''); assert.ok(!events.includes(marker)); assert.match(events, /externalTool/);
  const quarantine = path.join(f.store, 'pending-quarantine');
  for (const name of (await fs.readdir(quarantine)).filter(n => n.endsWith('.json'))) { const receipt = await fs.readFile(path.join(quarantine, name), 'utf8'); assert.ok(!receipt.includes(marker)); assert.match(receipt, /Invalid prepared/); }
});
test('R18 timestamp metadata does not change the identity of an unconsumed feedback batch', async t => {
  const f = await fixture(t); await atomic(path.join(f.store, 'connection.json'), { root: f.root, enabled: true, pid: process.pid, updated: Date.now() });
  const file = path.join(f.store, 'feedback', hash('session'), 'one.json'), decision = { action: 'reject', path: path.join(f.root, 'file.txt') };
  const prompt = { cwd: f.root, session_id: 'session', turn_id: 'request', hook_event_name: 'UserPromptSubmit' };
  await atomic(file, { ...decision, created: 1 }); const first = await handle(f.store, prompt);
  await atomic(file, { ...decision, created: 2 }); const second = await handle(f.store, prompt);
  assert.equal(first.hookSpecificOutput.additionalContext.match(/Review batch: ([\w-]+)/)[1], second.hookSpecificOutput.additionalContext.match(/Review batch: ([\w-]+)/)[1]);
});
test('R18 directory-to-symlink swap during enumeration cannot delete a project file', async t => {
  const f = await fixture(t), events = path.join(f.store, 'events'), project = path.join(f.root, 'project'); await fs.mkdir(events); await fs.mkdir(project); const source = path.join(project, 'source.txt'); await fs.writeFile(source, 'project source');
  const opendir = fs.opendir; let swapped = false;
  t.mock.method(fs, 'opendir', async (...args) => {
    if (!swapped && args[0] === events) { swapped = true; await fs.rename(events, events + '-old'); await fs.symlink(project, events); }
    return opendir(...args);
  });
  await clearData(f.store, ['events'], { connected: false }).catch(error => assert.match(error.message, /changed|scope|directory/));
  assert.ok(swapped); assert.equal(await fs.readFile(source, 'utf8'), 'project source');
});
for (const timing of ['before', 'after']) test('R18 a parent swap ' + timing + ' worker spawn cannot redirect deletion', async t => {
  const f = await fixture(t), events = path.join(f.store, 'events'), project = path.join(f.root, 'project'); await fs.mkdir(events); await fs.mkdir(project);
  await fs.writeFile(path.join(events, 'source.txt'), 'retained event'); const source = path.join(project, 'source.txt'); await fs.writeFile(source, 'project source');
  const childProcess = require('node:child_process'), sync = require('node:fs'), spawn = childProcess.spawn; let swapped = false;
  const swap = () => { swapped = true; sync.renameSync(events, events + '-old'); sync.symlinkSync(project, events); };
  t.mock.method(childProcess, 'spawn', (...args) => {
    if (args[2]?.cwd !== events || swapped) return spawn(...args);
    if (timing === 'before') swap();
    const child = spawn(...args); if (timing === 'after') swap(); return child;
  });
  const result = await clearData(f.store, ['events'], { connected: false });
  assert.ok(swapped); assert.equal(await fs.readFile(source, 'utf8'), 'project source');
  if (timing === 'before') { assert.equal(result.removed, 0); assert.equal(result.failed, 1); }
});
test('R18 the worker independently rechecks a temporary writer PID', async t => {
  const f = await fixture(t), active = path.join(f.store, 'event.json.' + process.pid + '-' + randomUUID() + '.tmp'); await fs.writeFile(active, 'active writer');
  const result = await clearData(f.store, ['temporary'], { connected: false, isAlive: () => false });
  assert.equal(result.removed, 0); assert.equal(result.skippedActive, 1); assert.equal(await fs.readFile(active, 'utf8'), 'active writer');
});
