'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createStateStore } = require('../review-state');
const { ReviewModel } = require('../review-model');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-identity-migration.')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const cache = id => path.join(root, 'storage', id, 'request-review.json');
  const file = cache('alexeytozik.vscode-agent-review'), old = cache('alexeytozik.agent-review'), older = cache('local-tools.change-review');
  const saved = suffix => ({ version: 2, turns: [{ key: 'session/' + suffix, threadId: 'session', id: suffix, created: 1, running: false, warnings: [], seen: ['edit'], files: [{ path: path.join(workspace, 'pending.txt'), canonical: path.join(workspace, 'pending.txt'), baseline: '\uFEFFbefore 😺\r\n', expected: '\uFEFFafter ё\r\n', mode: 0o640 }] }], feedback: [{ id: 'a'.repeat(64), turn: 'session/' + suffix, path: path.join(workspace, 'pending.txt'), action: 'reject', created: 2 }] });
  async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); return fs.readFile(file, 'utf8'); }
  return { root, workspace, file, old, older, saved, write, store: createStateStore(file), options: { root: workspace }, legacy: [old, older] };
}

test('identity migration prefers the previous private cache and preserves snapshots, modes, decisions and original bytes', async t => {
  const f = await fixture(t), source = await f.write(f.old, f.saved('current')), older = await f.write(f.older, f.saved('older'));
  const loaded = await f.store.load(f.legacy, f.options);
  assert.equal(loaded.migrated, true); assert.deepEqual(loaded.issues, []);
  assert.equal(loaded.state.turns[0].key, 'session/current');
  assert.deepEqual(loaded.state.turns[0].files, f.saved('current').turns[0].files);
  assert.deepEqual(loaded.state.feedback, f.saved('current').feedback);
  await f.store.save(loaded.state);
  assert.equal(await fs.readFile(f.old, 'utf8'), source); assert.equal(await fs.readFile(f.older, 'utf8'), older);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), loaded.state);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});

test('identity migration falls back to the older installation only when the private cache is missing', async t => {
  const f = await fixture(t); await f.write(f.older, f.saved('older'));
  const loaded = await f.store.load(f.legacy, f.options);
  assert.equal(loaded.migrated, true); assert.equal(loaded.state.turns[0].key, 'session/older');
});

test('an existing empty current cache wins over nonempty legacy caches', async t => {
  const f = await fixture(t); await f.write(f.file, { version: 2, turns: [] }); await f.write(f.old, f.saved('old'));
  const open = fs.open;
  t.mock.method(fs, 'open', (...args) => { assert.notEqual(args[0], f.old, 'Legacy storage must not be read'); return open(...args); });
  const loaded = await f.store.load(f.legacy, f.options);
  assert.equal(loaded.migrated, false); assert.deepEqual(loaded.state.turns, []);
});

test('the first imported save cannot overwrite a current archive created after legacy was loaded', async t => {
  const f = await fixture(t), original = await f.write(f.old, f.saved('legacy'));
  const imported = await f.store.load(f.legacy, f.options), winner = await f.write(f.file, f.saved('winner'));
  await assert.rejects(f.store.save(imported.state), { code: 'EEXIST' });
  assert.equal(await fs.readFile(f.file, 'utf8'), winner); assert.equal(await fs.readFile(f.old, 'utf8'), original);
  assert.equal(f.store.status().retry, true); await assert.rejects(f.store.save(imported.state), /read/);
  const current = await f.store.load(f.legacy, f.options);
  assert.equal(current.migrated, false); assert.equal(current.state.turns[0].key, 'session/winner');
  await f.store.save(current.state); assert.equal(f.store.status().retry, false);
  assert.ok(!(await fs.readdir(path.dirname(f.file))).some(name => name.endsWith('.tmp')));
});

test('a concurrent empty archive wins instead of resurrecting legacy snapshots', async t => {
  const f = await fixture(t); await f.write(f.old, f.saved('legacy'));
  const imported = await f.store.load(f.legacy, f.options), winner = await f.write(f.file, { version: 2, turns: [] });
  await assert.rejects(f.store.save(imported.state), { code: 'EEXIST' });
  assert.equal(await fs.readFile(f.file, 'utf8'), winner);
  assert.deepEqual((await f.store.load(f.legacy, f.options)).state.turns, []);
});

test('corrupt legacy recovery cannot overwrite a concurrent current archive either', async t => {
  const f = await fixture(t); await f.write(f.old, '{broken'); await assert.rejects(f.store.load(f.legacy, f.options), /Malformed JSON/);
  const winner = await f.write(f.file, f.saved('winner'));
  await assert.rejects(f.store.save({ version: 2, turns: [] }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(f.file, 'utf8'), winner); assert.equal(await fs.readFile(f.old, 'utf8'), '{broken');
  assert.equal(await fs.readFile(f.store.status().backup, 'utf8'), '{broken');
});

for (const code of ['EIO', 'ENOENT']) test('a selected legacy read failure cannot fall back or replace its original: ' + code, async t => {
  const f = await fixture(t), source = await f.write(f.old, f.saved('old')); await f.write(f.older, f.saved('older'));
  const open = fs.open, mock = t.mock.method(fs, 'open', (...args) => {
    if (args[0] === f.old) throw Object.assign(new Error('temporary legacy read'), { code });
    assert.notEqual(args[0], f.older, 'A read failure must not select an older snapshot'); return open(...args);
  });
  await assert.rejects(f.store.load(f.legacy, f.options), { code }); assert.equal(f.store.status().retry, true);
  await assert.rejects(f.store.save({ version: 2, turns: [] }), /read/);
  assert.equal(await fs.readFile(f.old, 'utf8'), source); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  mock.mock.restore(); assert.equal((await f.store.load(f.legacy, f.options)).state.turns[0].key, 'session/old');
});

test('corrupt legacy JSON is preserved without selecting a valid older snapshot', async t => {
  const f = await fixture(t); await f.write(f.old, '{broken'); await f.write(f.older, f.saved('older'));
  await assert.rejects(f.store.load(f.legacy, f.options), /Malformed JSON/);
  assert.equal(f.store.status().retry, false); await f.store.save({ version: 2, turns: [] });
  assert.equal(await fs.readFile(f.old, 'utf8'), '{broken'); assert.equal(await fs.readFile(f.store.status().backup, 'utf8'), '{broken');
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).turns, []);
});

test('partial legacy recovery preserves the whole original before saving valid neighbours', async t => {
  const f = await fixture(t), saved = f.saved('old'); saved.turns.push({ id: 'broken' });
  const original = await f.write(f.old, saved), loaded = await f.store.load(f.legacy, f.options);
  assert.equal(loaded.issues.length, 1); assert.equal(loaded.state.turns.length, 1); await f.store.save(loaded.state);
  assert.equal(await fs.readFile(f.old, 'utf8'), original); assert.equal(await fs.readFile(f.store.status().backup, 'utf8'), original);
  assert.deepEqual(loaded.state.feedback, saved.feedback);
});

test('an unreadable candidate cannot be bypassed even before its source is opened', async t => {
  const f = await fixture(t); await f.write(f.old, f.saved('old')); await f.write(f.older, f.saved('older'));
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', (...args) => { if (args[0] === f.old) throw Object.assign(new Error('legacy permission failure'), { code: 'EACCES' }); return lstat(...args); });
  await assert.rejects(f.store.load(f.legacy, f.options), { code: 'EACCES' }); assert.equal(f.store.status().retry, true);
  await assert.rejects(f.store.save({ version: 2, turns: [] }), /read/);
});

test('a legacy queue symlink is neither imported nor overwritten', async t => {
  const f = await fixture(t), target = path.join(f.root, 'target'); await f.write(target, 'preserved');
  await fs.mkdir(path.dirname(f.old), { recursive: true }); await fs.symlink(target, f.old); await f.write(f.older, f.saved('older'));
  await assert.rejects(f.store.load(f.legacy, f.options)); await assert.rejects(f.store.save({ version: 2, turns: [] }), /not a regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), 'preserved'); assert.ok((await fs.lstat(f.old)).isSymbolicLink());
});

test('the controller discards a losing import and publishes only the reloaded winner outbox on Connect', async t => {
  const f = await fixture(t), legacy = f.saved('legacy'), winner = f.saved('winner');
  winner.feedback[0].id = 'b'.repeat(64);
  const original = await f.write(f.old, legacy);
  await f.write(legacy.turns[0].files[0].path, legacy.turns[0].files[0].expected);
  let raced = false, winnerBytes; const link = fs.link;
  t.mock.method(fs, 'link', async (...args) => {
    if (!raced && args[1] === f.file) { raced = true; winnerBytes = await f.write(f.file, winner); }
    return link(...args);
  });
  const commands = new Map(), messages = [], decisions = [], subscriptions = [];
  const disposable = () => ({ dispose() {} }), event = () => disposable();
  let connected = false, resolveHooks;
  const hooksReady = new Promise(resolve => { resolveHooks = resolve; });
  const hooks = { ready: hooksReady, store: path.join(path.dirname(f.file), 'lifecycle'), status: () => ({ connected }), connect: async () => { connected = true; }, disconnect: async () => { connected = false; }, dispose: async () => {}, decision: async record => { if (!connected) return false; decisions.push(record.id); return true; } };
  const settings = { enabled: true, autoOpen: false, view: 'review', exclude: [] };
  const vscode = {
    extensions: { getExtension: () => undefined },
    ThemeColor: class {}, RelativePattern: class {}, EventEmitter: class { event() { return disposable(); } fire() {} dispose() {} },
    Uri: { from: value => ({ ...value, fsPath: value.path }), file: value => ({ scheme: 'file', fsPath: value }) },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: f.workspace } }], textDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => Object.hasOwn(settings, key) ? settings[key] : fallback }),
      registerTextDocumentContentProvider: event, createFileSystemWatcher: () => ({ onDidChange: event, onDidCreate: event, onDidDelete: event, dispose() {} }),
      onDidChangeTextDocument: event, onDidSaveTextDocument: event, onDidOpenTextDocument: event, onDidCloseTextDocument: event, onDidChangeConfiguration: event
    },
    window: { visibleTextEditors: [], createTextEditorDecorationType: disposable, showWarningMessage: text => { messages.push(text); }, showInformationMessage() {}, onDidChangeActiveTextEditor: event, onDidChangeVisibleTextEditors: event, onDidChangeTextEditorSelection: event },
    languages: { registerCodeLensProvider: event, registerHoverProvider: event },
    commands: { registerCommand: (name, run) => { commands.set(name, run); return disposable(); }, executeCommand: async () => {}, getCommands: async () => [] }
  };
  const module = { exports: {} }, localRequire = createRequire(require.resolve('../review'));
  vm.runInNewContext(fsSync.readFileSync(require.resolve('../review'), 'utf8'), {
    module, Buffer, process, setTimeout, clearTimeout,
    require: id => id === 'vscode' ? vscode : id === './review-io' ? { createReviewIO: () => ({}) } : id === './mode-status' ? { createModeStatus: () => ({ update() {}, dispose() {} }) } : id === './review-view' ? { createReviewView: () => ({ update() {}, inspect: () => ({ visible: false }), dispose() {} }) } : id === './hook-connection' ? { createConnection: () => hooks } : localRequire(id)
  });
  const api = module.exports.activate({ extension: { id: 'alexeytozik.vscode-agent-review' }, storageUri: { fsPath: path.dirname(f.file) }, extensionPath: path.dirname(require.resolve('../review')), subscriptions });
  t.after(async () => { resolveHooks(); await Promise.all(subscriptions.map(value => value.dispose())); });
  await api.ready;
  assert.ok(raced); assert.equal(await fs.readFile(f.file, 'utf8'), winnerBytes);
  assert.equal(api.entries().length, 0, 'The stale imported snapshots are unavailable until the winner is reloaded');
  assert.equal(api.getState().feedback.length, 0, 'The stale imported outbox cannot escape through hooks.ready');
  assert.ok(messages.some(message => message.includes('appeared during import')));
  resolveHooks(); await commands.get('changeReview.connect')();
  assert.deepEqual(decisions, ['b'.repeat(64)], 'Only the winning archive supplies decisions after Connect');
  assert.equal(api.entries()[0].turn.key, 'session/winner'); assert.equal(api.getState().feedback.length, 0);
  const stale = new ReviewModel(legacy).entries()[0];
  await assert.rejects(api.decide({ turn: stale.turn.key, path: stale.file.path, revision: stale.revision, hunk: stale.hunks[0].id }, 'reject'), /already been reviewed/);
  assert.equal(await fs.readFile(f.old, 'utf8'), original);
  assert.equal(await fs.readFile(legacy.turns[0].files[0].path, 'utf8'), legacy.turns[0].files[0].expected);
});

function activation(enabled, currentId = 'alexeytozik.vscode-agent-review') {
  const messages = [], subscriptions = [], reached = new Error('resource creation reached'); let resources = 0;
  const localRequire = createRequire(require.resolve('../review')), module = { exports: {} };
  const vscode = { extensions: { getExtension: id => enabled.has(id) ? { id } : undefined }, window: { showWarningMessage: message => { messages.push(message); return Promise.resolve(); } } };
  vm.runInNewContext(fsSync.readFileSync(require.resolve('../review'), 'utf8'), { module, require: id => id === 'vscode' ? vscode : id === './review-io' ? { createReviewIO: () => { resources++; throw reached; } } : localRequire(id) });
  return { start: () => module.exports.activate({ extension: { id: currentId }, subscriptions }), messages, subscriptions, reached, resources: () => resources };
}
for (const old of ['alexeytozik.agent-review', 'local-tools.change-review']) test('enabled legacy identity blocks activation before creating commands or resources: ' + old, async () => {
  const f = activation(new Set([old])), api = f.start();
  assert.equal(api.migrationBlocked, true); await api.ready;
  assert.equal(f.resources(), 0); assert.equal(f.subscriptions.length, 0); assert.equal(f.messages.length, 1);
  assert.ok(f.messages[0].includes(old)); assert.match(f.messages[0], /Disable.+reload/);
});

test('an identity never blocks its own activation', () => {
  const id = 'alexeytozik.agent-review', f = activation(new Set([id]), id);
  assert.throws(f.start, error => error === f.reached); assert.equal(f.messages.length, 0); assert.equal(f.resources(), 1);
});

test('disabled legacy and unrelated publishers do not block activation', () => {
  const f = activation(new Set(['jaikathuria.agent-review']));
  assert.throws(f.start, error => error === f.reached); assert.equal(f.messages.length, 0); assert.equal(f.resources(), 1);
});
