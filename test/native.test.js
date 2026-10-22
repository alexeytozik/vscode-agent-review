'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { native, tick, editor, items, decorations } = require('./native-fixture');

test('native buttons react synchronously to pointer/cursor events and stay anchored while scrolling', async () => {
  const api = await native, ed = editor(); api.update(ed, 'controls', decorations(items('one')), () => {});
  assert.equal(api.inspect('file:///preview.txt')[0].visible, true);
  ed.emit('onMouseMove', { target: { position: { lineNumber: 10 }, element: null } });
  let state = api.inspect('file:///preview.txt')[0]; assert.equal(state.current.arg.hunk, 'one:1'); assert.equal(state.position.preference.top, 200);
  ed.scroll = 160; ed.emit('onDidScrollChange'); assert.equal(api.inspect('file:///preview.txt')[0].position.preference.top, 40);
  ed.emit('onMouseMove', { target: { position: { lineNumber: 6 }, element: null } }); assert.equal(api.inspect('file:///preview.txt')[0].visible, false);
  ed.emit('onDidChangeCursorPosition', { position: { lineNumber: 2 } }); ed.scroll = 0; ed.emit('onDidScrollChange');
  assert.equal(api.inspect('file:///preview.txt')[0].current.arg.hunk, 'one:0');
  const adjacent = items('adjacent'); adjacent[1].start = adjacent[1].end = 3;
  api.update(ed, 'controls', decorations(adjacent), () => {});
  ed.emit('onMouseMove', { target: { position: { lineNumber: 3 }, element: null } });
  assert.equal(api.inspect('file:///preview.txt')[0].current.arg.hunk, 'adjacent:1', 'A preceding deletion anchor cannot steal the next change');
  api.clear('controls'); assert.equal(ed.widget, undefined); assert.ok([...ed.listeners.values()].every(set => set.size === 0));
});

test('native decisions use fresh arguments, block duplicate clicks and invalidate after edits', async () => {
  const api = await native, ed = editor(), calls = []; let finish;
  api.update(ed, 'actions', decorations(items('old')), (command, arg) => { calls.push({ command, arg }); return new Promise(resolve => { finish = resolve; }); });
  const bar = ed.widget.getDomNode().children[0], keep = bar.children[4];
  keep.click(); keep.click(); await tick(); assert.equal(calls.length, 1); assert.equal(calls[0].arg.revision, 'old');
  finish(); await tick();
  ed.emit('onDidChangeModelContent'); keep.click(); await tick(); assert.equal(calls.length, 1);
  api.update(ed, 'actions', decorations(items('fresh')), () => {}); keep.click(); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[1].arg.revision, 'fresh'); finish(); await tick();
  api.update(ed, 'actions', [], () => {}); keep.click(); await tick(); assert.equal(calls.length, 2); assert.deepEqual(api.inspect('file:///preview.txt'), []);
});

test('split editors and model replacement keep controls isolated; unrelated decorations pass through', async () => {
  const api = await native, first = editor('file:///first.txt'), second = editor('file:///second.txt');
  assert.equal(api.update(first, 'normal', [{ range: {} }], () => {}), false);
  api.update(first, 'first', decorations(items('one')), () => {}); api.update(second, 'second', decorations(items('two')), () => {});
  first.emit('onDidChangeModel'); assert.deepEqual(api.inspect('file:///first.txt'), []); assert.equal(api.inspect('file:///second.txt').length, 1);
  api.clear('second'); assert.equal(second.widget, undefined);
});

test('native navigation and keyboard decisions target the displayed change; end-of-file stays inside the editor', async () => {
  const api = await native, ed = editor(), calls = [];
  const mac = /Mac/.test(globalThis.navigator?.platform || '');
  api.update(ed, 'navigation', decorations(items('navigation')), (command, arg) => calls.push({ command, arg }));
  ed.widget.getDomNode().children[0].children[2].click(); await tick();
  assert.equal(calls[0].command, 'changeReview.show'); assert.equal(calls[0].arg.hunk, 'navigation:1');
  ed.line = 10; ed.emit('onDidChangeCursorPosition', { position: { lineNumber: 10 } });
  let stopped = false;
  ed.emit('onKeyDown', { browserEvent: { key: 'y' }, metaKey: mac, ctrlKey: !mac, shiftKey: mac, altKey: false, preventDefault() { stopped = true; }, stopPropagation() {} });
  await tick(); assert.equal(stopped, true); assert.equal(calls[1].command, 'changeReview.accept'); assert.equal(calls[1].arg.hunk, 'navigation:1');
  const end = [{ start: 100, end: 100, arg: items('end')[0].arg }]; ed.line = 100; ed.scroll = 1660;
  api.update(ed, 'navigation', decorations(end), () => {});
  const state = api.inspect('file:///preview.txt')[0]; assert.equal(state.visible, true); assert.equal(state.position.preference.top, 318);
  api.clear('navigation');
});
