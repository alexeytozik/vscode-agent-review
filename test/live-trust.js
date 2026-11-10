'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { commandArgs, isConfigured } = require('../hook-config');

async function isolatedHome(home, cwd, store) {
  const canonical = await fs.realpath(home), workspace = await fs.realpath(cwd);
  assert.equal(path.basename(canonical), 'home', 'A separate live-test home is required');
  assert.equal(path.dirname(canonical), path.dirname(workspace), 'Only the isolated live-test profile may be configured');
  const storage = await fs.realpath(store), relative = path.relative(path.dirname(canonical), storage);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'The live-test store must belong to its isolated profile');
  assert.ok(!storage.startsWith(canonical + path.sep), 'The review store must remain separate from the live-test home');
  return canonical;
}

async function verifyLiveHooks({ home, cwd, store, extensionPath, hooks, executable = process.execPath }) {
  const canonical = await isolatedHome(home, cwd, store);
  const registry = path.join(home, 'review-hooks'), script = path.join(registry, 'dispatch-v1.js');
  for (const file of [path.join(registry, 'setup.json'), script, path.join(home, 'hooks.json')]) {
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Only ordinary isolated hook files may be trusted');
  }
  const setup = JSON.parse(await fs.readFile(path.join(registry, 'setup.json'), 'utf8'));
  const args = commandArgs(setup.command);
  assert.equal(setup.version, 1);
  assert.ok(args, 'The shared hook command must use the supported argument format');
  assert.equal(await fs.realpath(args[0]), await fs.realpath(executable));
  assert.equal(await fs.realpath(args[1]), await fs.realpath(script));
  assert.equal(await fs.realpath(args[2]), await fs.realpath(registry));
  assert.equal(await fs.realpath(setup.executable), await fs.realpath(executable));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const expectedHash = digest(await fs.readFile(path.join(extensionPath, 'hook-dispatch.js')));
  assert.equal(setup.scriptHash, expectedHash, 'The owned dispatcher must match the active extension');
  assert.equal(digest(await fs.readFile(script)), expectedHash, 'The trusted dispatcher bytes must match the active extension');
  assert.ok(isConfigured(JSON.parse(await fs.readFile(path.join(home, 'hooks.json'), 'utf8')), setup.command), 'All reviewed hook matchers and timeouts must be configured');
  assert.ok(Array.isArray(hooks));
  assert.equal(hooks.length, 5, 'Only the five isolated review hooks may be trusted');
  const state = {};
  for (const hook of hooks) {
    assert.equal(hook.command, setup.command);
    assert.equal(await fs.realpath(hook.sourcePath), path.join(canonical, 'hooks.json'));
    assert.ok(typeof hook.key === 'string' && hook.key.length && !Object.hasOwn(state, hook.key), 'Each trusted hook needs a distinct key');
    assert.ok(typeof hook.currentHash === 'string' && hook.currentHash.length, 'Each trusted hook needs its current hash');
    Object.defineProperty(state, hook.key, { value: { trusted_hash: hook.currentHash }, enumerable: true });
  }
  return { home: canonical, state };
}
module.exports = { isolatedHome, verifyLiveHooks };
