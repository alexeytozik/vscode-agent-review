'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { changes, decide } = require('../core');
const { scan, assertSafe, resolveInside, decode } = require('../files');

function apply(before, after, index, action) {
  const diff = changes(before, after);
  return decide(before, after, diff.revision, diff.hunks[index].id, action);
}
test('accept one block and reject another, preserving pre-existing content', () => {
  let before = 'unsaved personal note\none\nseparator\ntwo\n';
  let after = 'unsaved personal note\nONE\nseparator\nTWO\n';
  assert.equal(changes(before, after).hunks.length, 2);
  let result = apply(before, after, 0, 'accept');
  assert.equal(result.current, after);
  before = result.baseline;
  assert.equal(before, 'unsaved personal note\nONE\nseparator\ntwo\n');
  result = apply(before, after, 0, 'reject');
  assert.equal(result.current, before);
  assert.equal(changes(result.baseline, result.current).hunks.length, 0);
});
test('rejecting a lower block does not alter a manual edit above it', () => {
  const before = 'a\nb\nc\nd\ne\nf\n';
  const after = 'manual\na\nb\nc\nd\nE\nf\n';
  assert.equal(apply(before, after, 1, 'reject').current, 'manual\na\nb\nc\nd\ne\nf\n');
});
test('old buttons cannot overwrite a later edit', () => {
  const diff = changes('a\n', 'b\n');
  assert.throws(() => decide('a\n', 'new manual edit\n', diff.revision, diff.hunks[0].id, 'reject'), /The file changed/);
});
test('reject and accept inserted and deleted files, including empty files', () => {
  for (const text of ['', 'hello\n']) {
    assert.equal(apply(null, text, 0, 'accept').baseline, text);
    assert.equal(apply(null, text, 0, 'reject').current, null);
    assert.equal(apply(text, null, 0, 'accept').baseline, null);
    assert.equal(apply(text, null, 0, 'reject').current, text);
  }
});
test('preserve CRLF, BOM, unicode and missing trailing newline', () => {
  for (const [before, after] of [
    ['a\r\nb\r\nc\r\n', 'A\r\nb\r\nC\r\n'],
    ['\ufeffПривет\nмир', '\ufeffПривет\nземля 🌍'],
    ['a', 'a\n'], ['a\n', 'a'], ['', 'line'], ['line', '']
  ]) {
    let b = before, a = after;
    while (changes(b, a).hunks.length) a = apply(b, a, 0, 'reject').current;
    assert.equal(a, before);
    b = before; a = after;
    while (changes(b, a).hunks.length) b = apply(b, a, 0, 'accept').baseline;
    assert.equal(b, after);
  }
});
test('repeated line edits and removals are reversible in arbitrary order', () => {
  let seed = 37;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 150; run++) {
    const original = Array.from({ length: 20 }, () => ['same\n', 'other\n', '😺\r\n'][random(3)]);
    const edited = [...original];
    for (let j = 0; j < 6; j++) edited.splice(random(edited.length + 1), random(2), 'change-' + j + '\n');
    const before = original.join(''), after = edited.join('');
    let b = before, a = after;
    while (changes(b, a).hunks.length) {
      const diff = changes(b, a), hunk = diff.hunks[random(diff.hunks.length)];
      a = decide(b, a, diff.revision, hunk.id, 'reject').current;
    }
    assert.equal(a, before);
    b = before; a = after;
    while (changes(b, a).hunks.length) {
      const diff = changes(b, a), hunk = diff.hunks[random(diff.hunks.length)];
      b = decide(b, a, diff.revision, hunk.id, 'accept').baseline;
    }
    assert.equal(b, after);
  }
});
test('snapshot includes untracked files and excludes generated, binary and secret files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'untracked.py'), 'original\n');
  await fs.writeFile(path.join(root, '.env'), 'private');
  await fs.writeFile(path.join(root, 'node_modules', 'dependency.js'), 'ignored');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  const snapshot = await scan(root, new Map([[path.join(root, 'untracked.py'), 'unsaved content\n']]));
  assert.deepEqual([...snapshot.files], [['untracked.py', 'unsaved content\n']]);
  assert.equal(snapshot.skipped[0].path, 'binary.bin');
});
test('refuse path traversal and symbolic links outside the chosen directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-test-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-test-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  await fs.writeFile(path.join(outside, 'file.txt'), 'keep');
  await fs.symlink(outside, path.join(root, 'link'));
  assert.throws(() => resolveInside(root, '../file.txt'));
  assert.throws(() => resolveInside(root, '/absolute.txt'));
  await assert.rejects(assertSafe(root, 'link/file.txt'), /symbolic link/);
  await assert.rejects(assertSafe(root, 'link/new.txt'), /Symbolic links/);
  assert.equal((await scan(root)).files.size, 0);
});
test('reject unsupported encodings instead of replacing their bytes', () => {
  assert.throws(() => decode(Buffer.from([0xff, 0xfe, 65, 0])));
  const bom = Buffer.from('\ufefftext\r\n');
  assert.ok(Buffer.from(decode(bom)).equals(bom));
});
