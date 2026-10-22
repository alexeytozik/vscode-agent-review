'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModeStatus } = require('../mode-status');

function fixture(initial) {
  let enabled = initial, visible = false, disposed = false;
  const messages = [], item = { show() { visible = true; }, dispose() { disposed = true; } };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    window: {
      createStatusBarItem(id, alignment, priority) {
        assert.equal(id, 'changeReview.mode');
        assert.equal(alignment, 1);
        assert.equal(priority, 10);
        return item;
      },
      showInformationMessage(message) { messages.push(message); return Promise.resolve(); }
    }
  };
  const status = createModeStatus(vscode, () => enabled);
  return { status, item, messages, get visible() { return visible; }, get disposed() { return disposed; }, set(value) { enabled = value; status.update(); } };
}

for (const enabled of [true, false]) {
  test('mode indicator starts ' + (enabled ? 'on' : 'off') + ' without a startup notification', () => {
    const f = fixture(enabled), mode = enabled ? 'ON' : 'OFF';
    assert.ok(f.visible);
    assert.equal(f.item.text, (enabled ? '$(check)' : '$(circle-slash)') + ' Review: ' + mode);
    assert.equal(f.item.command, 'changeReview.toggle');
    assert.equal(f.item.name, 'Code Review');
    assert.match(f.item.tooltip, new RegExp('is ' + mode));
    assert.match(f.item.tooltip, new RegExp(enabled ? 'turn it off' : 'turn it on'));
    assert.equal(f.item.accessibilityInformation.label, f.item.tooltip);
    assert.deepEqual(f.messages, []);
  });
  test('mode change to ' + (enabled ? 'off' : 'on') + ' updates immediately and notifies once', () => {
    const f = fixture(enabled), mode = enabled ? 'OFF' : 'ON';
    f.set(!enabled);
    assert.ok(f.item.text.endsWith(mode));
    assert.deepEqual(f.messages, ['Code review is ' + mode + '.']);
    for (let index = 0; index < 50; index++) f.status.update();
    assert.equal(f.messages.length, 1, 'Queue and configuration refreshes do not repeat the notification');
  });
}

test('rapid changes keep the indicator and every notification in order', () => {
  const f = fixture(false);
  for (let index = 0; index < 10; index++) f.set(index % 2 === 0);
  assert.ok(f.item.text.endsWith('OFF'));
  assert.deepEqual(f.messages, Array.from({ length: 10 }, (_, index) => 'Code review is ' + (index % 2 ? 'OFF' : 'ON') + '.'));
});

test('unloading the extension disposes its indicator', () => {
  const f = fixture(true);
  f.status.dispose();
  assert.ok(f.disposed);
});
