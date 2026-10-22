'use strict';
const native = import('../review-native.mjs').then(module => module.reviewNative);
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(document) { this.ownerDocument = document; this.style = {}; this.children = []; this.handlers = {}; }
  appendChild(child) { this.children.push(child); child.parent = this; }
  setAttribute() {}
  addEventListener(event, handler) { this.handlers[event] = handler; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  remove() { this.removed = true; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 800, height: this.style.display === 'none' ? 0 : 22 }; }
  click() { this.handlers.click({ stopPropagation() {} }); }
}
function editor(uri = 'file:///preview.txt') {
  const document = { createElement: () => new Element(document) };
  const listeners = new Map(), host = new Element(document);
  const value = { line: 2, scroll: 0, model: { uri: { toString: () => uri }, getLineCount: () => 100 },
    getDomNode: () => host, getModel() { return this.model; }, getPosition() { return { lineNumber: this.line, column: 1 }; },
    getLayoutInfo: () => ({ height: 400, contentLeft: 60, contentWidth: 740, verticalScrollbarWidth: 12 }),
    getScrolledVisiblePosition(position) { return { top: (position.lineNumber - 1) * 20 - this.scroll, height: 20 }; },
    addOverlayWidget(widget) { this.widget = widget; }, removeOverlayWidget() { this.widget = undefined; }, layoutOverlayWidget() {}, hasTextFocus: () => true,
    emit(event, data) { for (const fn of [...listeners.get(event) || []]) fn(data); }, listeners };
  for (const event of ['onMouseMove', 'onMouseLeave', 'onDidChangeCursorPosition', 'onDidScrollChange', 'onDidLayoutChange', 'onDidChangeConfiguration', 'onDidChangeModelContent', 'onDidChangeModel', 'onDidDispose', 'onKeyDown']) {
    listeners.set(event, new Set()); value[event] = fn => { listeners.get(event).add(fn); return { dispose: () => listeners.get(event).delete(fn) }; };
  }
  return value;
}
const items = revision => [2, 10].map((line, index) => ({ start: line, end: line, arg: { turn: 'preview/one', path: '/preview.txt', revision, hunk: revision + ':' + index } }));
const decorations = data => [{ hoverMessage: { value: '<!-- change-review-controls:v1 -->' + JSON.stringify(data) } }];

module.exports = { native, tick, editor, items, decorations };
