'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { allowed, resolveInside, assertSafe, decode, scan, MAX_FILE_BYTES } = require('../files');

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-files.'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

for (const name of ['.env', '.ENV', '.envrc', 'nested/.AWS/credentials', 'nested/.ssh/id_ed25519', 'nested/auth.json', 'credentials.json', '.env.local', 'nested/private.pem', 'nested/client.KEY', 'nested/config.kubeconfig', 'node_modules/file.js', 'nested/.git/config']) {
  test('snapshot excludes protected path: ' + name, () => assert.equal(allowed(name), false));
}
for (const name of ['file.txt', 'nested/manifest.json', 'environment.py']) {
  test('snapshot permits ordinary path: ' + name, () => assert.equal(allowed(name), true));
}
for (const value of ['', null, '..', '../outside', '/absolute', 'invalid\0name']) {
  test('path guard rejects ' + JSON.stringify(value), () => assert.throws(() => resolveInside('/tmp/example', value)));
}
test('UTF-8 byte limit accepts exactly 1 MiB and refuses one extra byte', () => {
  const exact = Buffer.alloc(MAX_FILE_BYTES, 65);
  assert.equal(decode(exact).length, MAX_FILE_BYTES);
  assert.throws(() => decode(Buffer.concat([exact, Buffer.from('a')])), /1 MiB/);
  assert.throws(() => decode(Buffer.from('😺'.repeat(MAX_FILE_BYTES / 4 + 1))), /1 MiB/);
});
test('safe paths include existing files and missing nested parents without creating them', async t => {
  const root = await directory(t), existing = path.join(root, 'existing.txt');
  await fs.writeFile(existing, 'keep');
  assert.equal(await assertSafe(root, 'existing.txt'), existing);
  assert.equal(await assertSafe(root, 'nested/new.txt'), path.join(root, 'nested/new.txt'));
  await assert.rejects(fs.stat(path.join(root, 'nested')), { code: 'ENOENT' });
});
test('snapshot includes a new unsaved document and refuses outside or invalid documents', async t => {
  const root = await directory(t), full = path.join(root, 'nested/new.txt');
  const documents = new Map([[full, 'unsaved 😺\r\n'], [path.join(root, '../outside.txt'), 'outside'], [path.join(root, 'invalid.txt'), '\0binary'], [path.join(root, '.env'), 'private']]);
  assert.deepEqual([...(await scan(root, documents)).files], [['nested/new.txt', 'unsaved 😺\r\n']]);
});
test('snapshot refuses an unsaved document behind a symbolic link', async t => {
  const root = await directory(t), outside = await directory(t);
  await fs.symlink(outside, path.join(root, 'redirect'));
  assert.equal((await scan(root, new Map([[path.join(root, 'redirect/new.txt'), 'keep']]))).files.size, 0);
  await assert.rejects(fs.stat(path.join(outside, 'new.txt')), { code: 'ENOENT' });
});
test('path guard refuses aliases into excluded directories within the workspace', async t => {
  const root = await directory(t), protectedDir = path.join(root, '.aws');
  await fs.mkdir(protectedDir);
  await fs.mkdir(path.join(protectedDir, 'nested'));
  await fs.writeFile(path.join(protectedDir, 'config'), 'fixture');
  await fs.symlink(protectedDir, path.join(root, 'alias'));
  await assert.rejects(assertSafe(root, 'alias/config'), /excluded/);
  await assert.rejects(assertSafe(root, 'alias/nested/new/config'), /excluded/);
  assert.equal((await scan(root, new Map([[path.join(root, 'alias/config'), 'dirty']]))).files.size, 0);
});
test('oversized disk and dirty-buffer files are reported without collecting their text', async t => {
  const root = await directory(t), oversized = 'a'.repeat(MAX_FILE_BYTES + 1);
  await fs.writeFile(path.join(root, 'large.txt'), oversized);
  await fs.writeFile(path.join(root, 'dirty.txt'), 'small');
  const result = await scan(root, new Map([[path.join(root, 'dirty.txt'), oversized]]));
  assert.equal(result.files.size, 0);
  assert.deepEqual(result.skipped.map(item => item.path), ['dirty.txt', 'large.txt']);
  assert.ok(result.skipped.every(item => /1 MiB/.test(item.reason)));
});
test('snapshot accepts 2,000 files and refuses the next file', async t => {
  const root = await directory(t);
  for (let start = 0; start < 2000; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, index) => fs.writeFile(path.join(root, 'file-' + (start + index) + '.txt'), '')));
  }
  assert.equal((await scan(root)).files.size, 2000);
  await fs.writeFile(path.join(root, 'extra.txt'), '');
  await assert.rejects(scan(root), /2,000/);
});
test('snapshot enforces the total byte limit for disk files and new unsaved documents', async t => {
  const root = await directory(t), text = 'a'.repeat(MAX_FILE_BYTES);
  await Promise.all(Array.from({ length: 20 }, (_, index) => fs.writeFile(path.join(root, 'file-' + index + '.txt'), text)));
  assert.equal((await scan(root)).files.size, 20);
  await assert.rejects(scan(root, new Map([[path.join(root, 'new.txt'), 'extra']])), /smaller folder/);
  await fs.writeFile(path.join(root, 'extra.txt'), 'extra');
  await assert.rejects(scan(root), /20 MiB/);
});
