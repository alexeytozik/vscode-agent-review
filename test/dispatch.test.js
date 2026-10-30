'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { Readable, Writable } = require('node:stream');
const { createConnection } = require('../hook-connection'), { atomic } = require('../hook-runner');
const { select, run, keyFor } = require('../hook-dispatch');
const { createRegistry } = require('../hook-registry');
const { configure, hookCommand, commandArgs } = require('../hook-config');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-dispatch.'))), home = path.join(root, 'home'), connections = [], errors = [];
  const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign-hook' }] }] } }; await atomic(path.join(home, 'hooks.json'), foreign);
  t.after(async () => { await Promise.all(connections.map(connection => connection.dispose())); await fs.rm(root, { recursive: true, force: true }); });
  async function connect(name, { workspace, storage, enabled = () => true } = {}) {
    workspace ||= path.join(root, name); await fs.mkdir(workspace, { recursive: true });
    const received = [], connection = createConnection({ storage: storage || path.join(root, 'profiles', name), root: workspace, home, executable: process.execPath, extensionPath: path.resolve(__dirname, '..'), enabled, receive: async event => { received.push(event); }, report: error => { errors.push(error); } });
    connections.push(connection); await connection.ready; await connection.connect(); return { connection, workspace, received };
  }
  const registry = createRegistry(home), config = async () => JSON.parse(await fs.readFile(path.join(home, 'hooks.json'), 'utf8'));
  return { root, home, registry, foreign, connections, errors, connect, config };
}
const output = () => { let value = ''; return { stream: new Writable({ write(chunk, encoding, callback) { value += chunk; callback(); } }), text: () => value }; };
test('R20 twenty registrations use five shared commands and route a real event once', async t => {
  const f = await fixture(t), workspaces = [];
  for (let i = 0; i < 20; i++) workspaces.push(await f.connect('workspace-' + i));
  const config = await f.config(), commands = Object.values(config.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  assert.equal(commands.length, 6); assert.equal(new Set(commands.filter(hook => hook.command !== 'foreign-hook').map(hook => hook.command)).size, 1);
  const event = { cwd: workspaces[7].workspace, hook_event_name: 'UserPromptSubmit', session_id: 'session', turn_id: 'request' }, out = output();
  assert.equal(await run(f.registry.directory, { stdin: Readable.from([JSON.stringify(event)]), stdout: out.stream, stderr: output().stream }), true); assert.deepEqual(JSON.parse(out.text()), {});
  for (const { connection } of workspaces) await connection.drain();
  assert.equal(workspaces.flatMap(workspace => workspace.received).length, 1); assert.equal(workspaces[7].received[0].turnId, 'request'); assert.deepEqual(f.errors, []);
  for (const { connection } of workspaces.slice(0, -1)) await connection.disconnect(); assert.equal(Object.keys((await f.config()).hooks).length, 5);
  await workspaces.at(-1).connection.disconnect(); assert.deepEqual(await f.config(), f.foreign);
});
test('R20 nested OFF lease wins routing and preserves an ignored turn after enabling', async t => {
  const f = await fixture(t), outer = await f.connect('outer'); let enabled = false;
  const inner = await f.connect('inner', { workspace: path.join(outer.workspace, 'nested'), enabled: () => enabled });
  assert.equal((await select(f.registry.directory, inner.workspace)).store, inner.connection.store);
  for (const hook of ['UserPromptSubmit', 'Stop']) { const out = output(); await run(f.registry.directory, { stdin: Readable.from([JSON.stringify({ cwd: inner.workspace, hook_event_name: hook, session_id: 'session', turn_id: 'off' })]), stdout: out.stream, stderr: output().stream }); }
  await inner.connection.drain(); assert.ok(inner.received.every(event => event.skipReview)); assert.equal(outer.received.length, 0);
  enabled = true; await inner.connection.update(); assert.equal((await select(f.registry.directory, inner.workspace)).store, inner.connection.store);
});
test('R20 close removes a lease but retains registration; reopen and final explicit disconnect work', async t => {
  const f = await fixture(t), first = await f.connect('workspace'), setup = await f.config(); first.connection.dispose();
  for (let i = 0; i < 100 && await select(f.registry.directory, first.workspace); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await select(f.registry.directory, first.workspace), undefined); assert.deepEqual(await f.config(), setup); assert.ok(await f.registry.registration(first.workspace));
  const second = await f.connect('workspace'); assert.ok(await select(f.registry.directory, second.workspace)); await second.connection.disconnect(); assert.deepEqual(await f.config(), f.foreign);
});
test('R20 a duplicate canonical workspace across profiles is refused without a global change', async t => {
  const f = await fixture(t), first = await f.connect('workspace'), config = await f.config();
  await assert.rejects(f.connect('duplicate', { workspace: first.workspace }), /another window/); assert.deepEqual(await f.config(), config); assert.equal((await select(f.registry.directory, first.workspace)).store, first.connection.store);
});
test('R20 stale, future, dead and damaged neighbouring leases are ignored independently', async t => {
  const f = await fixture(t), current = await f.connect('workspace'), selected = await select(f.registry.directory, current.workspace), leaseFile = path.join(f.registry.directory, 'leases', keyFor(current.workspace) + '.json');
  await atomic(path.join(f.registry.directory, 'leases', 'f'.repeat(64) + '.json'), { invalid: true }); assert.equal((await select(f.registry.directory, current.workspace)).store, current.connection.store);
  for (const change of [{ updated: 0 }, { updated: Date.now() + 60000 }, { pid: 999999 }]) { await atomic(leaseFile, { ...selected, ...change }); assert.equal(await select(f.registry.directory, current.workspace), undefined); }
  await current.connection.update(); assert.ok(await select(f.registry.directory, current.workspace));
});
test('R20 shared setup failures preserve old config, registration and bootstrap bytes', async t => {
  const f = await fixture(t), first = await f.connect('workspace'), config = await f.config(), script = path.join(f.registry.directory, 'dispatch-v1.js'), original = await fs.readFile(script), registration = await f.registry.registration(first.workspace);
  const rename = fs.rename; let hit = false;
  t.mock.method(fs, 'rename', async (...args) => { if (!hit && args[1] === path.join(f.home, 'hooks.json')) { hit = true; throw Object.assign(new Error('write failed'), { code: 'EIO' }); } return rename(...args); });
  await assert.rejects(first.connection.connect(), { code: 'EIO' }); assert.ok(hit); assert.deepEqual(await f.config(), config); assert.deepEqual(await fs.readFile(script), original); assert.deepEqual(await f.registry.registration(first.workspace), registration); assert.ok(await select(f.registry.directory, first.workspace));
});
test('R20 foreign shared bootstrap symlinks cannot be overwritten or executed', async t => {
  const f = await fixture(t), first = await f.connect('workspace'), script = path.join(f.registry.directory, 'dispatch-v1.js'), outside = path.join(f.root, 'outside.js'); await fs.writeFile(outside, 'foreign'); await fs.unlink(script); await fs.symlink(outside, script);
  await assert.rejects(first.connection.connect(), /symbolic|ELOOP|unsafe/); assert.equal(await fs.readFile(outside, 'utf8'), 'foreign'); assert.ok((await fs.lstat(script)).isSymbolicLink());
});
test('R20 command parser accepts only exact quoted wrapper arguments', () => {
  const args = ['/with space/node', "/it's/hook.js", '/store/$(literal)']; assert.deepEqual(commandArgs(hookCommand(...args)), args);
  for (const command of ['node script', hookCommand(...args) + '; command', hookCommand(...args) + ' extra', 'ELECTRON_RUN_AS_NODE=1 $(command)']) assert.equal(commandArgs(command), undefined);
});
async function legacy(f, name) {
  const workspace = path.join(f.root, name), storage = path.join(f.root, 'profiles', name), store = path.join(storage, 'lifecycle'), script = path.join(store, 'launch.js'), command = hookCommand(process.execPath, script, store), configFile = path.join(f.home, 'hooks.json');
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(store, { recursive: true });
  await fs.writeFile(script, "'use strict';\nconst fs=require('node:fs'),path=require('node:path');\nconst store=process.argv[2];\nconst runtime=JSON.parse(fs.readFileSync(path.join(store,'runtime.json'),'utf8'));\nrequire(path.join(runtime.extensionPath,'hook-runner.js')).run(store);\n");
  await atomic(path.join(store, 'setup.json'), { command, configFile }); await atomic(configFile, configure(await f.config(), command));
  const connection = createConnection({ storage, root: workspace, home: f.home, executable: process.execPath, extensionPath: path.resolve(__dirname, '..'), enabled: () => true, receive: async () => {}, report: e => f.errors.push(e) }); f.connections.push(connection); await connection.ready;
  return { connection, command, workspace };
}
test('R20 gradual legacy migration preserves untouched workspaces and only removes verified own commands', async t => {
  const f = await fixture(t), a = await legacy(f, 'a'), b = await legacy(f, 'b');
  assert.equal((await f.config()).hooks.UserPromptSubmit.length, 2); assert.equal(await f.registry.setup(), undefined);
  await a.connection.connect(); let config = await f.config(); const args = config.hooks.UserPromptSubmit.map(group => group.hooks[0].command);
  assert.equal(args.length, 2); assert.ok(args.includes(b.command)); assert.ok(!args.includes(a.command)); assert.equal(await f.registry.registration(b.workspace), undefined);
  await b.connection.connect(); config = await f.config(); assert.equal(config.hooks.UserPromptSubmit.length, 1); assert.equal(config.hooks.Stop[0].hooks[0].command, 'foreign-hook');
  await a.connection.disconnect(); assert.equal((await f.config()).hooks.UserPromptSubmit.length, 1); await b.connection.disconnect(); assert.deepEqual(await f.config(), f.foreign);
});
test('R20 forged legacy ownership cannot remove a foreign hook', async t => {
  const f = await fixture(t), old = await legacy(f, 'legacy'), setup = path.join(old.connection.store, 'setup.json');
  await atomic(setup, { configFile: path.join(f.home, 'hooks.json'), command: 'foreign-hook' }); const before = await f.config();
  await assert.rejects(old.connection.connect(), /cannot be verified/); await assert.rejects(old.connection.disconnect(), /cannot be verified/); assert.deepEqual(await f.config(), before);
});
test('R20 overlapping connects and disconnects preserve registrations and foreign hooks', async t => {
  const f = await fixture(t), workspaces = await Promise.all(Array.from({ length: 5 }, (_, i) => f.connect('parallel-' + i)));
  assert.equal((await f.config()).hooks.UserPromptSubmit.length, 1);
  for (const workspace of workspaces) assert.ok(await select(f.registry.directory, workspace.workspace));
  await Promise.all(workspaces.map(workspace => workspace.connection.disconnect())); assert.deepEqual(await f.config(), f.foreign); assert.deepEqual(f.errors, []);
});
test('R20 a stale live lease still prevents another profile taking the same workspace', async t => {
  const f = await fixture(t), current = await f.connect('workspace'), leaseFile = path.join(f.registry.directory, 'leases', keyFor(current.workspace) + '.json'), saved = JSON.parse(await fs.readFile(leaseFile, 'utf8'));
  await atomic(leaseFile, { ...saved, updated: 0 }); assert.equal(await select(f.registry.directory, current.workspace), undefined);
  await assert.rejects(f.connect('other-profile', { workspace: current.workspace }), /another window/); await current.connection.update(); assert.ok(await select(f.registry.directory, current.workspace));
});
test('R20 old closed profile cannot disconnect a registration adopted by another profile', async t => {
  const f = await fixture(t), old = await f.connect('workspace'); old.connection.dispose();
  for (let i = 0; i < 100 && await select(f.registry.directory, old.workspace); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const current = await f.connect('new-profile', { workspace: old.workspace }), before = await f.config();
  await assert.rejects(old.connection.disconnect(), /another window|another profile/); assert.deepEqual(await f.config(), before); assert.equal((await select(f.registry.directory, current.workspace)).store, current.connection.store);
});
test('R20 all twenty legacy registrations migrate without multiplying shared handlers', async t => {
  const f = await fixture(t), workspaces = [];
  for (let i = 0; i < 20; i++) workspaces.push(await legacy(f, 'legacy-' + i));
  assert.equal((await f.config()).hooks.UserPromptSubmit.length, 20);
  for (let i = 0; i < workspaces.length; i++) {
    await workspaces[i].connection.connect(); const commands = (await f.config()).hooks.UserPromptSubmit.flatMap(group => group.hooks.map(hook => hook.command));
    assert.equal(commands.length, 20 - i); for (const remaining of workspaces.slice(i + 1)) assert.ok(commands.includes(remaining.command));
  }
  for (const workspace of workspaces) assert.ok(await select(f.registry.directory, workspace.workspace));
  for (const workspace of workspaces) await workspace.connection.disconnect(); assert.deepEqual(await f.config(), f.foreign); assert.deepEqual(f.errors, []);
});
test('R20 disconnect keeps global handlers while another registered workspace is closed', async t => {
  const f = await fixture(t), closed = await f.connect('closed'), active = await f.connect('active'); closed.connection.dispose();
  for (let i = 0; i < 100 && await select(f.registry.directory, closed.workspace); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await active.connection.disconnect(); assert.equal((await f.config()).hooks.UserPromptSubmit.length, 1); assert.ok(await f.registry.registration(closed.workspace));
  const reopened = await f.connect('closed'); await reopened.connection.disconnect(); assert.deepEqual(await f.config(), f.foreign);
});
test('R20 a workspace is reserved before the first local runtime and heartbeat are ready', async t => {
  const f = await fixture(t), workspace = path.join(f.root, 'workspace'), storage = path.join(f.root, 'profiles', 'first'), runtime = path.join(storage, 'lifecycle', 'runtime.json');
  let entered, release, hit = false; const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; }), rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args) => { if (!hit && args[1] === runtime) { hit = true; entered(); await resume; } return rename(...args); });
  const connecting = f.connect('first', { workspace, storage }); await reached;
  try {
    await assert.rejects(f.connect('second', { workspace }), /another window/); release(); const first = await connecting;
    assert.equal(first.connection.status().connected, true); assert.equal((await select(f.registry.directory, workspace)).store, first.connection.store);
  } finally { release(); await connecting.catch(() => {}); }
});
test('R20 an upgrade killed after bootstrap rename is recoverable without accepting foreign bytes', async t => {
  const f = await fixture(t), current = await f.connect('workspace'), script = path.join(f.registry.directory, 'dispatch-v1.js'), setupFile = path.join(f.registry.directory, 'setup.json');
  const oldBytes = Buffer.concat([await fs.readFile(script), Buffer.from('\n')]); await fs.writeFile(script, oldBytes);
  const setup = JSON.parse(await fs.readFile(setupFile, 'utf8')); setup.scriptHash = require('node:crypto').createHash('sha256').update(oldBytes).digest('hex'); await atomic(setupFile, setup);
  const workspace = path.join(f.root, 'upgrade'), store = path.join(f.root, 'profiles', 'upgrade', 'lifecycle'); await fs.mkdir(workspace);
  const options = { root: workspace, store, instance: 'upgrade-attempt', executable: process.execPath };
  const code = "const fs=require('node:fs/promises'),original=fs.rename;fs.rename=async(...args)=>{await original(...args);if(args[1]===process.argv[3])process.exit(23);};require(process.argv[1]).createRegistry(process.argv[2]).register(JSON.parse(process.argv[4])).catch(e=>{process.stderr.write(e.stack);process.exitCode=1;});";
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', code, require.resolve('../hook-registry'), f.home, script, JSON.stringify(options)], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 5000 });
  assert.equal(child.status, 23, child.stderr); assert.ok(JSON.parse(await fs.readFile(setupFile, 'utf8')).pendingScriptHash);
  const recovered = await f.connect('upgrade', { workspace }); assert.ok(await select(f.registry.directory, recovered.workspace)); assert.ok(await select(f.registry.directory, current.workspace)); assert.equal(JSON.parse(await fs.readFile(setupFile, 'utf8')).pendingScriptHash, undefined);
});
test('R20 a FIFO neighbour and a regular-to-FIFO swap cannot block routing', async t => {
  const f = await fixture(t), current = await f.connect('workspace'), file = path.join(f.registry.directory, 'leases', 'f'.repeat(64) + '.json'), mkfifo = () => { const result = require('node:child_process').spawnSync('mkfifo', [file], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  mkfifo(); assert.ok(await select(f.registry.directory, current.workspace)); await fs.unlink(file); await fs.writeFile(file, '{}');
  const open = fs.open; let swapped = false;
  t.mock.method(fs, 'open', async (...args) => { if (args[0] === file && !swapped) { swapped = true; await fs.unlink(file); mkfifo(); } return open(...args); });
  assert.ok(await select(f.registry.directory, current.workspace)); assert.ok(swapped);
});
test('R20 changing the shared executable keeps existing routes valid throughout config replacement', async t => {
  const f = await fixture(t), first = await f.connect('first'), executable = path.join(f.root, 'runtime'); await fs.symlink(process.execPath, executable);
  const workspace = path.join(f.root, 'second'); await fs.mkdir(workspace);
  const second = createConnection({ storage: path.join(f.root, 'profiles', 'second'), root: workspace, home: f.home, executable, extensionPath: path.resolve(__dirname, '..'), enabled: () => true, receive: async () => {}, report: e => f.errors.push(e) }); f.connections.push(second); await second.ready;
  let entered, release, hit = false; const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; }), rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args) => { if (!hit && args[1] === path.join(f.home, 'hooks.json')) { hit = true; entered(); await resume; } return rename(...args); });
  const connecting = second.connect(); await reached;
  try {
    let updated = false; const update = first.connection.update().then(() => { updated = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(updated, false); assert.equal(first.connection.status().connected, true);
    release(); await Promise.all([connecting, update]); assert.equal(first.connection.status().connected, true); assert.ok(await select(f.registry.directory, first.workspace));
    await first.connection.update(); assert.equal(first.connection.status().connected, true);
  } finally { release(); await connecting.catch(() => {}); }
});
test('R20 an old setup read followed by a newly replaced config keeps its route', async t => {
  const f = await fixture(t), first = await f.connect('first'), executable = path.join(f.root, 'runtime'); await fs.symlink(process.execPath, executable);
  const workspace = path.join(f.root, 'second'); await fs.mkdir(workspace);
  const second = createConnection({ storage: path.join(f.root, 'profiles', 'second'), root: workspace, home: f.home, executable, extensionPath: path.resolve(__dirname, '..'), enabled: () => true, receive: async () => {}, report: e => f.errors.push(e) }); f.connections.push(second); await second.ready;
  let entered, release, hit = false; const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; }), open = fs.open;
  t.mock.method(fs, 'open', async (...args) => { if (!hit && args[0] === path.join(f.home, 'hooks.json')) { hit = true; entered(); await resume; } return open(...args); });
  const update = first.connection.update(); await reached;
  try { let connected = false; const connecting = second.connect().then(() => { connected = true; }); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(connected, false); release(); await Promise.all([update, connecting]); assert.equal(first.connection.status().connected, true); assert.ok(await select(f.registry.directory, first.workspace)); }
  finally { release(); await update.catch(() => {}); }
});
test('R20 the maximum valid exclusion list fits both connection readers', async t => {
  const f = await fixture(t), workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace);
  const connection = createConnection({ storage: path.join(f.root, 'profiles', 'workspace'), root: workspace, home: f.home, executable: process.execPath, extensionPath: path.resolve(__dirname, '..'), enabled: () => true, exclude: () => Array.from({ length: 128 }, (_, i) => 'dir-' + i + '/' + '\u0001'.repeat(1000)), receive: async () => {}, report: e => f.errors.push(e) }); f.connections.push(connection); await connection.ready; await connection.connect();
  assert.ok((await fs.stat(path.join(connection.store, 'connection.json'))).size > 65536); assert.ok(await select(f.registry.directory, workspace));
  const out = output(); assert.equal(await run(f.registry.directory, { stdin: Readable.from([JSON.stringify({ cwd: workspace, hook_event_name: 'UserPromptSubmit', session_id: 'session', turn_id: 'request' })]), stdout: out.stream, stderr: output().stream }), true); assert.deepEqual(JSON.parse(out.text()), {});
});
test('R20 a health snapshot serializes two queued A-B-A executable transitions', async t => {
  const f = await fixture(t), first = await f.connect('first'), alias = path.join(f.root, 'runtime'); await fs.symlink(process.execPath, alias);
  const others = [];
  for (const [name, executable] of [['second', alias], ['third', process.execPath]]) {
    const workspace = path.join(f.root, name); await fs.mkdir(workspace);
    const connection = createConnection({ storage: path.join(f.root, 'profiles', name), root: workspace, home: f.home, executable, extensionPath: path.resolve(__dirname, '..'), enabled: () => true, receive: async () => {}, report: e => f.errors.push(e) }); f.connections.push(connection); await connection.ready; others.push(connection);
  }
  let entered, release, hit = false; const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; }), open = fs.open;
  t.mock.method(fs, 'open', async (...args) => { if (!hit && args[0] === path.join(f.home, 'hooks.json')) { hit = true; entered(); await resume; } return open(...args); });
  const update = first.connection.update(); await reached;
  try {
    let completed = 0; const switches = others[0].connect().then(() => { completed++; return others[1].connect(); }).then(() => { completed++; });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(completed, 0); release(); await Promise.all([update, switches]);
    assert.equal(first.connection.status().connected, true); assert.ok(await select(f.registry.directory, first.workspace)); await first.connection.update(); assert.ok(await select(f.registry.directory, first.workspace));
  } finally { release(); await update.catch(() => {}); }
});
test('R20 a pending setup finalization remains retryable with a valid hooks config above 64 KiB', async t => {
  const f = await fixture(t), config = f.foreign; config.hooks.Stop[0].hooks[0].command = 'foreign-' + 'x'.repeat(70000); await atomic(path.join(f.home, 'hooks.json'), config);
  const setupFile = path.join(f.registry.directory, 'setup.json'), rename = fs.rename; let writes = 0;
  t.mock.method(fs, 'rename', async (...args) => { if (args[1] === setupFile && ++writes === 2) throw Object.assign(new Error('finalization failed'), { code: 'EIO' }); return rename(...args); });
  const current = await f.connect('workspace'); assert.ok(JSON.parse(await fs.readFile(setupFile, 'utf8')).pendingCommand);
  await current.connection.connect(); assert.ok(await select(f.registry.directory, current.workspace)); assert.equal(JSON.parse(await fs.readFile(setupFile, 'utf8')).pendingCommand, undefined);
  await current.connection.disconnect(); assert.deepEqual(await f.config(), config);
});
for (const stage of ['bootstrap', 'runtime']) test('R20 closing during Connect at ' + stage + ' leaves no active lease, watcher or late decision', async t => {
  const f = await fixture(t), workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace);
  const connection = createConnection({ storage: path.join(f.root, 'profiles', 'workspace'), root: workspace, home: f.home, executable: process.execPath, extensionPath: path.resolve(__dirname, '..'), enabled: () => true, receive: async () => {}, report: e => f.errors.push(e) }); f.connections.push(connection); await connection.ready;
  let entered, release, hit = false; const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; }), rename = fs.rename;
  const pausedFile = stage === 'bootstrap' ? path.join(f.registry.directory, 'dispatch-v1.js') : path.join(connection.store, 'runtime.json');
  t.mock.method(fs, 'rename', async (...args) => { if (!hit && args[1] === pausedFile) { hit = true; entered(); await resume; } return rename(...args); });
  const connecting = connection.connect(); await reached; const disposed = connection.dispose(); release(); await Promise.all([connecting, disposed]);
  assert.equal(connection.status().connected, false); assert.ok(await f.registry.registration(workspace)); assert.equal(await select(f.registry.directory, workspace), undefined);
  assert.equal((await connection.diagnosticState()).active, false); assert.equal(await connection.decision({ turn: 'session/request', path: path.join(workspace, 'file.txt') }, 'accept'), false);
  await assert.rejects(fs.lstat(path.join(f.registry.directory, 'leases', keyFor(workspace) + '.json')), { code: 'ENOENT' });
  for (const name of ['owner.lock', 'connection.json']) await assert.rejects(fs.lstat(path.join(connection.store, name)), { code: 'ENOENT' });
});
test('R20 a feedback decision waiting for capture lock is not acknowledged after close', async t => {
  const f = await fixture(t), current = await f.connect('workspace'); let entered, release;
  const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; });
  const holder = require('../file-lock').withCaptureLock(current.connection.store, async () => { entered(); await resume; }); await reached;
  try {
    const decision = current.connection.decision({ turn: 'session/request', path: path.join(current.workspace, 'file.txt') }, 'accept');
    await current.connection.dispose(); release(); await holder; assert.equal(await decision, false);
    await assert.rejects(fs.stat(path.join(current.connection.store, 'feedback')), { code: 'ENOENT' });
  } finally { release(); await holder; }
});
