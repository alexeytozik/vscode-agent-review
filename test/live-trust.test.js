'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { hookCommand, configure } = require('../hook-config');
const { isolatedHome, verifyLiveHooks } = require('./live-trust');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-live-trust.'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), cwd = path.join(root, 'workspace'), store = path.join(root, 'user', 'store'), extensionPath = path.join(root, 'extensions', 'review');
  const registry = path.join(home, 'review-hooks'), script = path.join(registry, 'dispatch-v1.js');
  for (const directory of [registry, cwd, store, extensionPath]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const source = 'exports.run = () => {};\n', command = hookCommand(process.execPath, script, registry);
  const setup = { version: 1, executable: process.execPath, command, scriptHash: createHash('sha256').update(source).digest('hex') };
  await fs.writeFile(script, source); await fs.writeFile(path.join(extensionPath, 'hook-dispatch.js'), source);
  const setupFile = path.join(registry, 'setup.json'), configFile = path.join(home, 'hooks.json');
  await fs.writeFile(setupFile, JSON.stringify(setup));
  await fs.writeFile(configFile, JSON.stringify(configure({}, command)));
  const hooks = Array.from({ length: 5 }, (_, index) => ({ key: 'hook-' + index, currentHash: 'current-' + index, sourcePath: configFile, command }));
  const options = { home, cwd, store, extensionPath, hooks };
  return { root, home, cwd, store, extensionPath, registry, script, source, command, setup, setupFile, configFile, hooks, options, verify: () => verifyLiveHooks(options), writeSetup: () => fs.writeFile(setupFile, JSON.stringify(setup)) };
}

test('live trust verifies the current shared dispatcher and returns exactly its five keys', async t => {
  const f = await fixture(t), result = await f.verify();
  assert.equal(result.home, await fs.realpath(f.home));
  assert.deepEqual(result.state, Object.fromEntries(f.hooks.map(hook => [hook.key, { trusted_hash: hook.currentHash }])));
});
test('live trust accepts canonical path aliases without changing the reviewed command', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias');
  await fs.symlink(f.root, alias, 'dir');
  f.options.home = path.join(alias, 'home');
  f.setup.command = hookCommand(process.execPath, path.join(alias, 'home', 'review-hooks', 'dispatch-v1.js'), path.join(alias, 'home', 'review-hooks'));
  await f.writeSetup(); await fs.writeFile(f.configFile, JSON.stringify(configure({}, f.setup.command)));
  for (const hook of f.hooks) { hook.command = f.setup.command; hook.sourcePath = path.join(alias, 'home', 'hooks.json'); }
  assert.equal(Object.keys((await f.verify()).state).length, 5);
});
test('live trust rejects a home unrelated to the isolated workspace', async t => {
  const f = await fixture(t), parent = path.join(f.root, 'other');
  await fs.mkdir(path.join(parent, 'home'), { recursive: true });
  await assert.rejects(isolatedHome(path.join(parent, 'home'), f.cwd, f.store), /isolated live-test profile/);
});
test('live trust rejects storage outside the isolated profile', async t => {
  const f = await fixture(t);
  await assert.rejects(isolatedHome(f.home, f.cwd, path.dirname(f.root)), /isolated profile/);
});
test('live trust rejects storage inside the test home', async t => {
  const f = await fixture(t);
  await assert.rejects(isolatedHome(f.home, f.cwd, f.registry), /separate/);
});
test('live trust rejects a legacy per-workspace command', async t => {
  const f = await fixture(t), legacy = path.join(f.store, 'launch.js');
  await fs.writeFile(legacy, f.source); f.setup.command = hookCommand(process.execPath, legacy, f.store); await f.writeSetup();
  await assert.rejects(f.verify());
});
test('live trust rejects a foreign executable even with owned dispatcher paths', async t => {
  const f = await fixture(t);
  f.setup.command = hookCommand('/bin/sh', f.script, f.registry); await f.writeSetup();
  await assert.rejects(f.verify());
});
test('live trust rejects modified dispatcher bytes before creating trust', async t => {
  const f = await fixture(t); await fs.writeFile(f.script, 'changed\n');
  await assert.rejects(f.verify(), /dispatcher bytes/);
});
test('live trust rejects a forged recorded script hash', async t => {
  const f = await fixture(t); f.setup.scriptHash = '0'.repeat(64); await f.writeSetup();
  await assert.rejects(f.verify(), /active extension/);
});
test('live trust compares against the active extension rather than a recorded extension path', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.extensionPath, 'hook-dispatch.js'), 'new package\n');
  await assert.rejects(f.verify(), /active extension/);
});
test('live trust rejects a dispatcher symlink even when its bytes match', async t => {
  const f = await fixture(t); await fs.unlink(f.script); await fs.symlink(path.join(f.extensionPath, 'hook-dispatch.js'), f.script);
  await assert.rejects(f.verify(), /ordinary isolated hook files/);
});
test('live trust rejects altered matcher definitions', async t => {
  const f = await fixture(t), config = configure({}, f.command);
  config.hooks.PreToolUse[0].matcher = '.*'; await fs.writeFile(f.configFile, JSON.stringify(config));
  await assert.rejects(f.verify(), /matchers and timeouts/);
});
test('live trust rejects a hook from a foreign source file', async t => {
  const f = await fixture(t), foreign = path.join(f.root, 'foreign.json'); await fs.writeFile(foreign, '{}');
  f.hooks[0].sourcePath = foreign; await assert.rejects(f.verify());
});
test('live trust rejects a foreign command in a neighbour hook', async t => {
  const f = await fixture(t); f.hooks[1].command = 'foreign command';
  await assert.rejects(f.verify());
});
test('live trust rejects an incomplete hook list', async t => {
  const f = await fixture(t); f.hooks.pop(); await assert.rejects(f.verify(), /five/);
});
test('live trust rejects duplicate keys rather than silently trusting fewer hooks', async t => {
  const f = await fixture(t); f.hooks[1].key = f.hooks[0].key;
  await assert.rejects(f.verify(), /distinct key/);
});
test('live trust requires each current hook hash', async t => {
  const f = await fixture(t); f.hooks[1].currentHash = '';
  await assert.rejects(f.verify(), /current hash/);
});
