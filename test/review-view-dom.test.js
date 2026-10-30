'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(platform = 'MacIntel') {
  const scrolls = []; let collapsed = true;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.textContent = ''; this.disabled = false; this.attributes = {}; this.isConnected = true;
      this.scrollTop = 0; this.scrollLeft = 0;
      this.style = { setProperty: (name, value) => { this.attributes[name] = value; } };
      this.classList = { toggle: (name, enabled) => { const values = new Set(this.className?.split(' ').filter(Boolean)); if (enabled) values.add(name); else values.delete(name); this.className = [...values].join(' '); } };
    }
    append(...children) { this.children.push(...children); children.forEach(child => { child.parentElement = this; }); }
    replaceChildren() { this.children = []; }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    matches(selector) { return selector === 'button[data-action]' ? this.tagName === 'BUTTON' && Boolean(this.dataset.action) : selector === '[data-hunk]' ? Boolean(this.dataset.hunk) : false; }
    scrollIntoView(options) { scrolls.push({ hunk: this.parentElement.dataset.hunk, options }); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    focus() { document.activeElement = this; }
    set innerHTML(value) { assert.fail('Untrusted content must never become HTML'); }
  }
  const ids = Object.fromEntries(['path','kind','counter','error','empty','change','code','navigation','actions'].map(id => [id, new Element()]));
  const buttons = Object.fromEntries(['accept','reject','next','previous'].map(action => { const b = new Element('button'); b.dataset.action = action; return [action, b]; }));
  const events = {}, messages = [];
  const document = { getElementById: id => ids[id], createElement: tag => new Element(tag), querySelectorAll: () => Object.values(buttons), addEventListener: (event, handler) => { events[event] = handler; } };
  const window = { addEventListener: (_, handler) => { events.message = handler; }, getSelection: () => ({ isCollapsed: collapsed }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../media/review-view.js'), 'utf8'), { document, window, navigator: { platform }, acquireVsCodeApi: () => ({ postMessage: m => messages.push(m) }) });
  function elements() { const result = []; function walk(node) { result.push(node); node.children.forEach(walk); } walk(ids.code); return result; }
  return { ids, buttons, messages, scrolls, elements, selecting: value => { collapsed = !value; }, source: () => elements().filter(node => node.className === 'source').map(node => node.textContent).join(''), render: data => events.message({ data: { type: 'state', id: 1, index: 1, total: 2, fileChangeIndex: 1, fileChangeCount: 2, fileIndex: 1, fileCount: 1, path: 'file.txt', blocks: [], ...data } }), click: action => events.click({ target: buttons[action] }), clickHunk: hunk => events.click({ target: elements().find(node => node.dataset.hunk === hunk) }), key: values => events.keydown({ key: '', altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, target: new Element(), preventDefault() {}, ...values }) };
}
test('webview renders code and malicious-looking file names as plain text', () => {
  const f = fixture(); f.render({ path: '<script>bad()</script>', blocks: [{ kind: 'added', line: 9, text: '<img onerror=bad()>\nёж😺\n' }] });
  assert.equal(f.ids.path.textContent, '<script>bad()</script>');
  assert.equal(f.source(), '<img onerror=bad()>\nёж😺\n');
  assert.equal(f.elements().find(node => node.className === 'number').textContent, '9\n10\n');
  assert.equal(f.messages.at(-1).action, 'rendered');
});
test('buttons send only an action and frame ID, and disable immediately on the first click', () => {
  const f = fixture(); f.render({}); const count = f.messages.length;
  f.click('accept'); f.click('reject');
  assert.equal(f.messages.length, count + 1); assert.deepEqual(JSON.parse(JSON.stringify(f.messages.at(-1))), { action: 'accept', id: 1 });
  assert.ok(Object.values(f.buttons).every(button => button.disabled));
});
test('conflicts block decisions but allow navigation to available neighbours', () => {
  const f = fixture(); f.render({ error: 'Manual edit overlaps', canNavigate: true });
  assert.ok(f.buttons.accept.disabled); assert.ok(f.buttons.reject.disabled); assert.equal(f.buttons.next.disabled, false);
  assert.equal(f.ids.counter.textContent, 'Review paused'); assert.match(f.ids.error.textContent, /saved snapshot/);
});
test('completion hides inactive controls and does not advertise removed buttons', () => {
  for (const state of [{ error: 'Manual edit overlaps' }, { complete: true }]) {
    const f = fixture(); f.render(state);
    assert.ok(f.buttons.accept.disabled); assert.ok(f.buttons.reject.disabled);
    assert.equal(f.ids.navigation.hidden, Boolean(state.complete)); assert.equal(f.ids.actions.hidden, Boolean(state.complete));
    assert.doesNotMatch(f.ids.empty.textContent, /Queue|Open file|Refresh/);
  }
});
test('the visible counter belongs to the current file, while navigation can move to the next file', () => {
  const f = fixture(); f.render({ index: 4, total: 5, fileIndex: 2, fileCount: 3, fileChangeIndex: 1, fileChangeCount: 1 });
  assert.equal(f.ids.counter.textContent, '1 / 1'); assert.match(f.ids.counter.title, /File 2 of 3/);
  assert.equal(f.buttons.next.disabled, false); f.click('next'); assert.equal(f.messages.at(-1).action, 'next');
});
test('large files retain all text without creating one DOM row per line', () => {
  for (const text of ['x'.repeat(100000), '\n'.repeat(4000)]) {
    const f = fixture(); f.render({ blocks: [{ kind: 'added', line: 1, text }] });
    assert.equal(f.source(), text); assert.ok(f.elements().length < 24);
  }
});
test('R22 newline-heavy files keep every character and correct line numbers in bounded render chunks', () => {
  const text = '\n'.repeat(512 * 1024 - 1) + 'last character Ω', f = fixture(); f.render({ blocks: [{ kind: 'context', line: 1, text }] });
  assert.equal(f.source(), text);
  const rows = f.elements().filter(node => node.className?.includes('code-block'));
  assert.equal(rows.length, 512); assert.ok(rows.every(row => Number(row.attributes['--review-lines']) <= 1024));
  assert.equal(rows[0].children[0].textContent.split('\n')[0], '1'); assert.equal(rows.at(-1).children[0].textContent.split('\n').at(-1), String(512 * 1024));
});
test('navigation highlights and scrolls to a change without rebuilding the complete file', () => {
  const f = fixture(), blocks = [{ kind: 'context', line: 1, text: 'header\n' }, { kind: 'added', line: 2, text: 'first\n', hunk: 'one' }, { kind: 'context', line: 3, text: 'unchanged\n'.repeat(3000) }, { kind: 'added', line: 3003, text: 'second\n', hunk: 'two' }];
  const base = { arg: { turn: 'request', path: '/file', revision: 'revision', hunk: 'one' }, blocks };
  f.render(base); const original = f.ids.code.children[0];
  assert.equal(f.scrolls.at(-1).hunk, 'one');
  f.render({ ...base, id: 2, arg: { ...base.arg, hunk: 'two' } });
  assert.equal(f.ids.code.children[0], original); assert.equal(f.scrolls.at(-1).hunk, 'two');
  assert.match(f.elements().find(node => node.dataset.hunk === 'two').className, /selected/);
  f.ids.code.scrollTop = 250; const count = f.scrolls.length;
  f.render({ ...base, id: 3, busy: true, arg: { ...base.arg, hunk: 'two' } });
  assert.equal(f.ids.code.scrollTop, 250); assert.equal(f.scrolls.length, count);
});
test('clicking a different change selects it, while copying text preserves the selection', () => {
  const f = fixture(); f.render({ arg: { turn: 't', path: '/file', revision: 'r', hunk: 'one' }, blocks: [{ kind: 'added', line: 1, text: 'one\n', hunk: 'one' }, { kind: 'added', line: 2, text: 'two\n', hunk: 'two' }] });
  f.selecting(true); const count = f.messages.length; f.clickHunk('two'); assert.equal(f.messages.length, count);
  f.selecting(false); f.clickHunk('two'); assert.equal(f.messages.at(-1).action, 'select'); assert.equal(f.messages.at(-1).hunk, 'two');
});
for (const platform of ['MacIntel', 'Linux x86_64']) {
  test('review shortcuts use the same decisions on ' + platform, () => {
    const f = fixture(platform); f.render({});
    f.key({ key: 'n', altKey: true, metaKey: platform === 'MacIntel', ctrlKey: platform !== 'MacIntel' });
    assert.equal(f.messages.at(-1).action, 'reject');
  });
}
test('empty-file changes still show an actionable review', () => {
  const f = fixture(); f.render({ kind: 'create' });
  assert.equal(f.ids.code.children[0].textContent, 'Empty file'); assert.equal(f.buttons.accept.disabled, false);
});
test('holding a shortcut does not approve the next rendered change', () => {
  const f = fixture(); f.render({});
  f.key({ key: 'y', altKey: true, metaKey: true });
  f.render({ id: 2 }); const count = f.messages.length;
  f.key({ key: 'y', altKey: true, metaKey: true, repeat: true });
  assert.equal(f.messages.length, count);
});
test('lightweight frames reuse only matching content and lost content requires resync', () => {
  const f = fixture(), arg = { turn: 't', path: '/file', revision: 'a', hunk: 'one' };
  f.render({ id: 1, contentId: 'a', arg, blocks: [{ kind: 'added', line: 1, text: 'version a\n', hunk: 'one' }] });
  const node = f.ids.code.children[0];
  f.render({ id: 2, contentId: 'a', arg, blocks: undefined, busy: true });
  assert.equal(f.ids.code.children[0], node); assert.equal(f.source(), 'version a\n');
  f.render({ id: 3, contentId: 'b', arg: { ...arg, revision: 'b' }, blocks: undefined });
  assert.equal(f.messages.at(-1).action, 'resync'); assert.equal(f.source(), 'version a\n');
  assert.ok(Object.values(f.buttons).every(button => button.disabled));
  const count = f.messages.length;
  f.render({ id: 4, contentId: 'b', blocks: undefined }); assert.equal(f.messages.length, count, 'Do not flood resync for the same missing content');
  f.render({ id: 2, contentId: 'a', arg, blocks: [{ kind: 'added', line: 1, text: 'stale\n' }] });
  assert.equal(f.source(), 'version a\n');
  f.render({ id: 5, contentId: 'b', arg: { ...arg, revision: 'b' }, blocks: [{ kind: 'added', line: 1, text: 'version b\n' }] });
  assert.equal(f.source(), 'version b\n'); assert.equal(f.messages.at(-1).action, 'rendered');
  assert.equal(f.buttons.accept.disabled, false);
});
for (const [key, code, action, modifiers] of [
  ['¥', 'KeyY', 'accept', { metaKey: true }], ['н', 'KeyY', 'accept', { metaKey: true }], ['т', 'KeyN', 'reject', { metaKey: true }],
  ['‘', 'BracketRight', 'next', {}], ['х', 'BracketLeft', 'previous', {}]
]) test('R12 physical shortcut works for ' + key + '/' + code, () => {
  const f = fixture(); f.render({}); f.key({ key, code, altKey: true, ...modifiers }); assert.equal(f.messages.at(-1).action, action);
});
for (const values of [
  { isComposing: true }, { keyCode: 229 }, { getModifierState: name => name === 'AltGraph' }, { shiftKey: true }, { ctrlKey: true },
  { target: { isContentEditable: true, matches: () => false, closest: () => null } },
  { target: { matches: () => true, closest: () => null } }, { repeat: true }, { code: 'KeyZ', key: 'y' }
]) test('R12 composition/editable/extra modifiers/repeat cannot decide: ' + JSON.stringify(values), () => {
  const f = fixture(); f.render({}); const count = f.messages.length;
  f.key({ code: 'KeyY', key: 'y', altKey: true, metaKey: true, ...values }); assert.equal(f.messages.length, count);
});
test('R12 navigation shortcuts work from a conflict without enabling a decision', () => {
  const f = fixture(); f.render({ error: 'conflict', canNavigate: true });
  f.key({ key: '¥', code: 'KeyY', altKey: true, metaKey: true }); assert.equal(f.messages.at(-1).action, 'rendered');
  f.key({ key: '‘', code: 'BracketRight', altKey: true }); assert.equal(f.messages.at(-1).action, 'next');
});
test('R13 decorative columns are hidden from AX and changed text has short semantic labels', () => {
  const f = fixture(); f.render({ arg: { hunk: 'one' }, blocks: [{ kind: 'removed', line: 1, hunk: 'one', text: 'old\n' }, { kind: 'added', line: 1, hunk: 'one', text: 'new\n' }] });
  for (const node of f.elements().filter(n => ['number', 'marker'].includes(n.className))) assert.equal(node.getAttribute('aria-hidden'), 'true');
  assert.match(f.elements().find(n => n.dataset.hunk === 'one').getAttribute('aria-label'), /Change 1 of 1/);
  assert.match(f.elements().find(n => n.className === 'code-block removed').getAttribute('aria-label'), /Removed text/);
  assert.match(f.ids.counter.getAttribute('aria-label'), /file.txt/);
  assert.equal(f.source(), 'old\nnew\n'); assert.equal(f.ids.code.getAttribute('aria-live'), undefined);
});
test('R15 whole-file kind is conditional and disappears for the next normal file', () => {
  const f = fixture(); f.render({ kind: 'create' }); assert.equal(f.ids.kind.textContent, 'New file'); assert.equal(f.ids.kind.hidden, false);
  f.render({ id: 2, kind: 'delete' }); assert.equal(f.ids.kind.textContent, 'Deleted file');
  f.render({ id: 3, kind: 'modify' }); assert.equal(f.ids.kind.hidden, true); assert.equal(f.ids.kind.textContent, '');
});
