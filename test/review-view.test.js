'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { changes } = require('../core');
const { viewState, createReviewView } = require('../review-view');

function entry(full = '/workspace/file.txt', before = 'old\nanchor\nlast\n', after = 'new\nanchor\nLAST\n', turn = 'request') {
  return { turn: { key: turn, running: false }, file: { path: full, baseline: before, expected: after }, ...changes(before, after) };
}
function selected(e, index = 0) { return { turn: e.turn.key, path: e.file.path, hunk: e.hunks[index]?.id }; }
function fixture(run = async () => {}) {
  let close, message, created = 0;
  const e = entry(), messages = [];
  const web = { cspSource: 'local:', asWebviewUri: uri => 'local:/' + uri, onDidReceiveMessage(fn) { message = fn; }, postMessage(value) { messages.push(value); return Promise.resolve(true); } };
  const panel = { visible: true, webview: web, reveal() { this.visible = true; }, onDidDispose(fn) { close = fn; }, dispose() { this.visible = false; close(); } };
  const vscode = { window: { createWebviewPanel(type, title, column, options) { created++; assert.equal(type, 'changeReview.review'); assert.deepEqual(options.localResourceRoots, ['root/media']); return panel; } }, Uri: { joinPath: (...args) => args.join('/') }, ViewColumn: { Active: 1 }, ThemeIcon: class {} };
  const view = createReviewView(vscode, { extensionUri: 'root' }, () => viewState([e], selected(e), '/workspace'), run);
  view.show();
  return { view, panel, web, messages, entry: e, message: value => message(value), count: () => created, current: () => view.inspect().state };
}

test('[regression] the review contains the entire current file, including distant unchanged lines', () => {
  const before = 'header\n' + 'unchanged\n'.repeat(30) + 'old\n' + 'tail\n'.repeat(30) + 'end\n';
  const after = before.replace('old\n', 'new\n');
  const e = entry('/workspace/full.txt', before, after), state = viewState([e], selected(e), '/workspace');
  assert.equal(state.blocks.filter(block => block.kind !== 'removed').map(block => block.text).join(''), after);
});
test('[regression] every pending change is shown while reviewing one of them', () => {
  const e = entry(), state = viewState([e], selected(e), '/workspace');
  assert.equal(state.blocks.filter(block => block.kind !== 'added').map(block => block.text).join(''), e.file.baseline);
  assert.deepEqual([...new Set(state.blocks.filter(block => block.hunk).map(block => block.hunk))], e.hunks.map(h => h.id));
});

test('view projects the selected change with context, relative path and request navigation', () => {
  const first = entry(), second = entry('/workspace/second.txt');
  const state = viewState([first, second], selected(first, 1), '/workspace');
  assert.equal(state.path, 'file.txt'); assert.equal(state.index, 2); assert.equal(state.total, 4);
  assert.equal(state.fileIndex, 1); assert.equal(state.fileCount, 2);
  assert.equal(state.fileChangeIndex, 2); assert.equal(state.fileChangeCount, 2);
  const nextFile = viewState([first, second], selected(second), '/workspace');
  assert.equal(nextFile.index, 3); assert.equal(nextFile.fileChangeIndex, 1); assert.equal(nextFile.fileChangeCount, 2);
  assert.equal(state.arg.revision, first.revision);
  const blocks = state.blocks.filter(block => block.hunk === state.arg.hunk);
  assert.equal(blocks[0].text, 'last\n'); assert.equal(blocks[1].text, 'LAST\n');
  assert.equal(blocks[0].line, 3); assert.equal(blocks[1].line, 3);
});
test('finishing a request never silently selects older pending changes', () => {
  const old = entry('/workspace/older.txt', 'old\n', 'new\n', 'older');
  assert.deepEqual(viewState([old], undefined, '/workspace'), { complete: true, pending: 1, blocks: [] });
});
test('display paths prefer verified canonical paths and never expose traversal prefixes', () => {
  const e = entry('/var/workspace/file.txt');
  e.file.canonical = '/private/var/workspace/nested/file.txt';
  assert.equal(viewState([e], selected(e), '/private/var/workspace').path, 'nested/file.txt');
  e.file.canonical = undefined;
  assert.equal(viewState([e], selected(e), '/private/var/workspace').path, 'file.txt');
});
for (const [name, before, after] of [['new-empty', null, ''], ['deleted-empty', '', null], ['unicode', 'ёж😺\r\n', 'йод🐱\r\n'], ['injection', '<script>bad()</script>\n', '<img onerror=bad()>\n']]) {
  test('view preserves text and whole-file operations: ' + name, () => {
    const e = entry('/workspace/<file>.txt', before, after), state = viewState([e], selected(e), '/workspace');
    assert.equal(state.blocks.filter(block => block.kind !== 'added').map(block => block.text).join(''), before || '');
    assert.equal(state.blocks.filter(block => block.kind !== 'removed').map(block => block.text).join(''), after || '');
    assert.equal(state.path, '<file>.txt'); assert.ok(state.arg);
  });
}
test('conflicts and running requests expose a reason rather than an actionable change', () => {
  const e = entry(); e.file.error = 'Manual edit overlaps';
  assert.equal(viewState([e], selected(e), '/workspace').error, e.file.error);
  e.file.error = undefined; e.turn.running = true;
  assert.match(viewState([e], selected(e), '/workspace').error, /still running/);
});
for (const [name, before, after] of [
  ['insertion', 'one\ntwo\n', 'one\nnew\ntwo\n'],
  ['deletion', 'one\nold\ntwo\n', 'one\ntwo\n'],
  ['no-final-newline', 'old\nend', 'new\nend'],
  ['bom-and-crlf', '\uFEFFhead\r\nold\r\ntail\r\n', '\uFEFFhead\r\nnew\r\ntail\r\n'],
  ['separated-edits', 'a\nb\nc\nd\ne\nf\n', 'A\nb\nc\nd\nE\nf\n']
]) test('full-file projection preserves both versions: ' + name, () => {
  const e = entry('/workspace/file.txt', before, after), blocks = viewState([e], selected(e), '/workspace').blocks;
  assert.equal(blocks.filter(block => block.kind !== 'added').map(block => block.text).join(''), before);
  assert.equal(blocks.filter(block => block.kind !== 'removed').map(block => block.text).join(''), after);
});
test('click selection is restricted to a block in the displayed file and revision', async () => {
  const calls = [], f = fixture((...args) => calls.push(args)), next = f.entry.hunks[1].id;
  await assert.rejects(f.view.receive({ action: 'select', id: f.current().id, hunk: 'foreign' }), /no longer/);
  await f.view.receive({ action: 'select', id: f.current().id, hunk: next, path: '/outside/file' });
  assert.equal(calls[0][0], 'select'); assert.equal(calls[0][1].hunk, next); assert.equal(calls[0][1].path, f.entry.file.path);
});
test('webview uses a restricted CSP, local assets and sends file contents only in messages', () => {
  const f = fixture();
  assert.match(f.web.html, /default-src 'none'/); assert.match(f.web.html, /script-src 'nonce-[a-f0-9]+'/);
  assert.ok(!f.web.html.includes(f.entry.file.expected)); assert.ok(!f.web.html.includes('command:'));
  assert.match(f.web.html, /data-action="reject"/); assert.match(f.web.html, /data-action="accept"/);
  assert.deepEqual([...f.web.html.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]), ['previous', 'next', 'reject', 'accept']);
  assert.ok(!f.web.html.includes('id="kind"')); assert.ok(!f.web.html.includes('id="files"'));
  f.view.show(); assert.equal(f.count(), 1, 'Reuse one review tab');
  f.view.dispose(); assert.equal(f.view.inspect().visible, false);
});
test('ready handshake resends the current state and tracks its actual render acknowledgement', async () => {
  const f = fixture(); await f.view.receive({ action: 'ready' });
  const id = f.current().id; assert.ok(f.view.inspect().ready);
  await f.view.receive({ action: 'rendered', id: id - 1 }); assert.equal(f.view.inspect().rendered, undefined);
  await f.view.receive({ action: 'rendered', id }); assert.equal(f.view.inspect().rendered, id);
});
test('messages cannot select a path or execute an arbitrary command', async () => {
  const calls = [], f = fixture((...args) => calls.push(args));
  await assert.rejects(f.view.receive({ action: 'delete', id: f.current().id }), /Unknown/);
  const arg = f.current().arg;
  await f.view.receive({ action: 'accept', id: f.current().id, arg: { path: '/outside/secret' }, command: 'anything' });
  assert.deepEqual(calls, [['accept', arg]]);
});
test('stale frames and competing double clicks never decide a second change', async () => {
  let finish; const calls = [], f = fixture(async (...args) => { calls.push(args); await new Promise(resolve => { finish = resolve; }); });
  const id = f.current().id;
  const first = f.view.receive({ action: 'accept', id });
  assert.equal(await f.view.receive({ action: 'reject', id }), false);
  finish(); await first;
  assert.equal(await f.view.receive({ action: 'reject', id }), false);
  assert.equal(calls.length, 1); assert.equal(f.current().error, undefined);
});
test('a failed decision retains its error and blocks decisions until the host refreshes', async () => {
  const f = fixture(async action => { if (action === 'reject') throw new Error('Manual edit overlaps'); });
  await assert.rejects(f.view.receive({ action: 'reject', id: f.current().id }), /overlaps/);
  assert.equal(f.current().error, 'Manual edit overlaps'); assert.equal(f.current().busy, false);
  await assert.rejects(f.view.receive({ action: 'accept', id: f.current().id }), /overlaps/);
  f.view.update(); assert.equal(f.current().error, undefined);
});
test('removed toolbar actions cannot be invoked by webview messages', async () => {
  const calls = [], f = fixture(action => calls.push(action));
  for (const action of ['open', 'refresh', 'queue']) await assert.rejects(f.view.receive({ action, id: f.current().id }), /Unknown/);
  assert.deepEqual(calls, []);
});
test('disposed panels reject late actions without changing files', async () => {
  let calls = 0; const f = fixture(() => { calls++; }), id = f.current().id;
  f.view.dispose(); assert.equal(await f.view.receive({ action: 'accept', id }), false); assert.equal(calls, 0);
});
