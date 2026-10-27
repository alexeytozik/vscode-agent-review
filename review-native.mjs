// Browser-side review controls, loaded by the versioned workbench integration.
const prefix = '<!-- change-review-controls:v1 -->';
const states = new Map();
let sequence = 0;

function payload(decorations) {
  const message = decorations?.[0]?.hoverMessage;
  const value = (Array.isArray(message) ? message[0] : message)?.value;
  if (typeof value !== 'string' || !value.startsWith(prefix)) return;
  const data = JSON.parse(value.slice(prefix.length));
  if (!Array.isArray(data) || data.length > 10000) throw new Error('Invalid review controls');
  for (const item of data) {
    if (!Number.isInteger(item.start) || !Number.isInteger(item.end) || item.start < 1 || item.end < item.start ||
        !['turn', 'path', 'revision', 'hunk'].every(key => typeof item.arg?.[key] === 'string')) throw new Error('Invalid review change');
  }
  return data;
}

class Controls {
  constructor(editor, key, execute) {
    this.editor = editor; this.key = key; this.execute = execute; this.items = []; this.disposed = false;
    this.dom = editor.getDomNode().ownerDocument.createElement('div');
    this.dom.className = 'change-review-native';
    this.dom.style.cssText = 'display:none;position:absolute;z-index:11;pointer-events:none;height:22px;';
    this.bar = this.dom.ownerDocument.createElement('div');
    this.bar.className = 'change-review-actions';
    this.bar.style.cssText = 'float:right;display:flex;align-items:center;gap:2px;pointer-events:auto;height:22px;border-radius:4px;overflow:hidden;';
    this.dom.appendChild(this.bar);
    this.previous = this.button('‹', 'Previous change', () => this.navigate(-1));
    this.counter = this.dom.ownerDocument.createElement('span');
    this.counter.style.cssText = 'font:11px var(--vscode-font-family);padding:0 4px;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);height:22px;line-height:22px;';
    this.bar.appendChild(this.counter);
    this.next = this.button('›', 'Next change', () => this.navigate(1));
    const mac = /Mac/.test(globalThis.navigator?.platform || '');
    this.reject = this.button('Undo', 'Reject change', () => this.act('reject'), mac ? '⌘N' : 'Ctrl+N');
    this.accept = this.button('Keep', 'Accept change', () => this.act('accept'), mac ? '⇧⌘Y' : 'Ctrl+Y');
    this.accept.style.background = 'color-mix(in srgb, var(--vscode-charts-green, #16a34a) 85%, transparent)';
    this.accept.style.color = 'var(--vscode-button-foreground)';
    this.dom.addEventListener('pointerdown', event => event.preventDefault());
    this.dom.addEventListener('mouseleave', () => this.refresh());
    this.widget = { getId: () => 'change-review-' + ++sequence, getDomNode: () => this.dom, getPosition: () => this.position };
    const id = this.widget.getId(); this.widget.getId = () => id;
    editor.addOverlayWidget(this.widget);
    this.listeners = [
      editor.onMouseMove(event => {
        if (this.dom.contains(event.target.element)) return;
        if (event.target.position) { this.line = event.target.position.lineNumber; this.refresh(); }
      }),
      editor.onMouseLeave(() => { this.line = editor.getPosition()?.lineNumber; this.refresh(); }),
      editor.onDidChangeCursorPosition(event => { this.line = event.position.lineNumber; this.refresh(); }),
      editor.onDidScrollChange(() => this.refresh()),
      editor.onDidLayoutChange(() => this.refresh()),
      editor.onDidChangeConfiguration(() => this.refresh()),
      editor.onDidChangeModelContent(() => { this.invalidated = true; this.refresh(); }),
      editor.onDidChangeModel(() => this.dispose()),
      editor.onDidDispose(() => this.dispose()),
      editor.onKeyDown(event => {
        if (!this.current || !editor.hasTextFocus()) return;
        const key = event.browserEvent.key.toLowerCase();
        const modifier = mac ? event.metaKey : event.ctrlKey;
        const action = modifier && !event.altKey && (key === 'n' && !event.shiftKey ? 'reject' : key === 'y' && event.shiftKey === mac ? 'accept' : undefined);
        if (action) { event.preventDefault(); event.stopPropagation(); this.act(action); }
      })
    ];
  }
  button(text, title, action, shortcut) {
    const button = this.dom.ownerDocument.createElement('button');
    button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
    button.style.cssText = 'display:flex;align-items:center;gap:4px;height:22px;padding:2px 6px;border:1px solid transparent;border-radius:4px;font:12px var(--vscode-font-family);color:var(--vscode-input-foreground);background:var(--vscode-editor-background);cursor:pointer;white-space:nowrap;';
    const label = this.dom.ownerDocument.createElement('span'); label.textContent = text;
    button.appendChild(label); button.reviewLabel = label;
    if (shortcut) {
      const hint = this.dom.ownerDocument.createElement('span'); hint.textContent = shortcut;
      hint.style.cssText = 'opacity:.7;font-size:11px;'; button.appendChild(hint);
    }
    button.addEventListener('click', event => { event.stopPropagation(); action(); });
    button.addEventListener('mouseenter', () => { button.style.filter = 'brightness(1.15)'; });
    button.addEventListener('mouseleave', () => { button.style.filter = ''; });
    this.bar.appendChild(button); return button;
  }
  set(items) {
    const changed = JSON.stringify(items) !== JSON.stringify(this.items);
    this.items = items; if (changed) this.invalidated = false;
    const cursor = this.editor.getPosition()?.lineNumber;
    if (this.cursorLine !== cursor || this.line === undefined) this.line = cursor;
    this.cursorLine = cursor; this.refresh();
  }
  refresh() {
    if (this.disposed) return;
    const model = this.editor.getModel();
    this.current = !this.invalidated && model && (this.items.find(item => item.start <= this.line && this.line <= item.end) || this.items.find(item => item.end + 1 === this.line));
    if (!this.current) { this.dom.style.display = 'none'; return; }
    const layout = this.editor.getLayoutInfo();
    let anchor = Math.min(this.current.end + 1, model.getLineCount());
    let rect = this.editor.getScrolledVisiblePosition({ lineNumber: anchor, column: 1 });
    if (rect && rect.top + 22 > layout.height && this.current.start <= this.line && this.line <= this.current.end) { anchor = this.current.start; rect = this.editor.getScrolledVisiblePosition({ lineNumber: anchor, column: 1 }); }
    if (!rect) { this.dom.style.display = 'none'; return; }
    if (rect.top < 0 || rect.top + 22 > layout.height) {
      const visible = this.editor.getVisibleRanges?.().some(range => range.startLineNumber <= this.current.end && range.endLineNumber >= this.current.start);
      if (!visible || layout.height < 22) { this.dom.style.display = 'none'; return; }
      rect = { ...rect, top: Math.max(0, Math.min(rect.top, layout.height - 22)) };
    }
    const eof = this.current.end >= model.getLineCount();
    this.position = { preference: { top: Math.max(0, rect.top + (eof ? rect.height - 22 : 0)), left: layout.contentLeft } };
    this.dom.style.width = layout.contentWidth + 'px';
    this.bar.style.marginRight = ((layout.verticalScrollbarWidth || 14) + 4) + 'px';
    this.counter.textContent = (this.items.indexOf(this.current) + 1) + ' of ' + this.items.length;
    for (const node of [this.previous, this.counter, this.next]) node.style.display = this.items.length > 1 ? '' : 'none';
    for (const button of [this.previous, this.next, this.reject, this.accept]) button.disabled = this.busy;
    this.dom.style.display = 'block'; this.editor.layoutOverlayWidget(this.widget);
  }
  navigate(direction) {
    if (!this.current || this.busy || this.disposed) return;
    const index = (this.items.indexOf(this.current) + direction + this.items.length) % this.items.length;
    this.run('changeReview.show', this.items[index].arg);
  }
  act(action) {
    if (!this.current || this.busy || this.disposed || this.invalidated) return;
    return this.run('changeReview.' + action, this.current.arg);
  }
  run(command, arg) {
    this.busy = true; this.refresh();
    return Promise.resolve().then(() => this.execute(command, arg)).catch(error => { this.lastError = error.message; }).finally(() => {
      if (!this.disposed) { this.busy = false; this.refresh(); }
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.current = undefined;
    for (const listener of this.listeners || []) listener.dispose();
    this.editor.removeOverlayWidget(this.widget); this.dom.remove();
    if (states.get(this.editor) === this) states.delete(this.editor);
  }
  inspect() {
    const rect = this.dom.getBoundingClientRect();
    const style = node => this.dom.ownerDocument.defaultView?.getComputedStyle(node);
    return { key: this.key, visible: this.dom.style.display === 'block', busy: this.busy, invalidated: this.invalidated,
      firstLineTop: this.editor.getScrolledVisiblePosition({ lineNumber: 1, column: 1 })?.top,
      position: this.position, items: this.items, current: this.current,
      actions: [{ command: 'changeReview.reject', label: 'Undo', title: 'Reject change' }, { command: 'changeReview.accept', label: 'Keep', title: 'Accept change' }].map((action, index) => {
        const button = [this.reject, this.accept][index];
        return { ...action, labelVisible: (style(button.reviewLabel)?.display ?? button.reviewLabel.style.display) !== 'none', background: style(button)?.backgroundColor };
      }),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, height: this.bar.getBoundingClientRect().height, lastError: this.lastError };
  }
}

export const reviewNative = {
  update(editor, key, decorations, execute) {
    if (!editor?.getDomNode()) return false;
    const items = payload(decorations), existing = states.get(editor);
    if (items === undefined) {
      if (existing?.key !== key) return false;
      existing.dispose(); return true;
    }
    if (existing && existing.key !== key) existing.dispose();
    const controls = states.get(editor) || new Controls(editor, key, execute);
    states.set(editor, controls); controls.set(items); return true;
  },
  clear(key) { for (const controls of states.values()) if (controls.key === key) controls.dispose(); },
  act(uri, action, expected) {
    if (!['accept', 'reject'].includes(action)) throw new Error('Unknown review action');
    const controls = [...states.values()].find(item => item.editor.getModel()?.uri.toString() === uri && item.current?.arg.hunk === expected.hunk && item.current.arg.revision === expected.revision && !item.invalidated);
    if (!controls) throw new Error('The displayed change has changed');
    return controls.act(action);
  },
  inspect(uri) { return [...states.values()].filter(controls => controls.editor.getModel()?.uri.toString() === uri).map(controls => controls.inspect()); }
};
