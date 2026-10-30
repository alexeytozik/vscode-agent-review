'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModeStatus } = require('../mode-status');

function fixture(initial, connection = { connected: true, lastEvent: 1 }) {
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
  const status = createModeStatus(vscode, () => enabled, () => connection);
  return { status, item, messages, get visible() { return visible; }, get disposed() { return disposed; }, set(value) { enabled = value; status.update(); } };
}

for (const enabled of [true, false]) {
  test('mode indicator starts ' + (enabled ? 'on' : 'off') + ' without a startup notification', () => {
    const f = fixture(enabled), mode = enabled ? 'ON' : 'OFF';
    assert.ok(f.visible);
    assert.equal(f.item.text, (enabled ? '$(check)' : '$(circle-slash)') + ' Review: ' + mode);
    assert.equal(f.item.command, 'changeReview.toggle');
    assert.equal(f.item.name, 'Agent Review');
    assert.match(f.item.tooltip, new RegExp('is ' + mode));
    assert.match(f.item.tooltip, new RegExp(enabled ? 'turn it off' : 'turn it on'));
    assert.equal(f.item.accessibilityInformation.label, f.item.tooltip);
    assert.deepEqual(f.messages, []);
  });
  test('mode change to ' + (enabled ? 'off' : 'on') + ' updates immediately and notifies once', () => {
    const f = fixture(enabled), mode = enabled ? 'OFF' : 'ON';
    f.set(!enabled);
    assert.ok(f.item.text.endsWith(mode));
    assert.deepEqual(f.messages, ['Agent Review is ' + mode + '.']);
    for (let index = 0; index < 50; index++) f.status.update();
    assert.equal(f.messages.length, 1, 'Queue and configuration refreshes do not repeat the notification');
  });
}

test('rapid changes keep the indicator and every notification in order', () => {
  const f = fixture(false);
  for (let index = 0; index < 10; index++) f.set(index % 2 === 0);
  assert.ok(f.item.text.endsWith('OFF'));
  assert.deepEqual(f.messages, Array.from({ length: 10 }, (_, index) => 'Agent Review is ' + (index % 2 ? 'OFF' : 'ON') + '.'));
});

test('unloading the extension disposes its indicator', () => {
  const f = fixture(true);
  f.status.dispose();
  assert.ok(f.disposed);
});

test('enabled mode stays switchable when review is disconnected', () => {
  const f = fixture(true, { connected: false });
  assert.equal(f.item.text, '$(warning) Review: ON');
  assert.equal(f.item.command, 'changeReview.toggle');
  assert.match(f.item.tooltip, /not connected/i);
  assert.match(f.item.tooltip, /turn it off/i);
  assert.deepEqual(f.messages, []);
});

test('configured hooks wait for evidence of event delivery', () => {
  const connection = { connected: true };
  const f = fixture(true, connection);
  assert.equal(f.item.text, '$(warning) Review: ON');
  assert.equal(f.item.command, 'changeReview.toggle');
  assert.match(f.item.tooltip, /delivery is not verified/i);
  connection.lastEvent = Date.now(); f.status.update();
  assert.equal(f.item.text, '$(check) Review: ON');
  assert.match(f.item.tooltip, /apply_patch/);
  connection.connected = false; f.status.update();
  assert.equal(f.item.text, '$(warning) Review: ON');
  assert.equal(f.item.command, 'changeReview.toggle');
  assert.match(f.item.tooltip, /not connected/i);
  assert.deepEqual(f.messages, []);
});

test('unsupported workspace explains why review cannot connect', () => {
  const f = fixture(true, { available: false });
  assert.equal(f.item.text, '$(warning) Review: ON');
  assert.equal(f.item.command, 'changeReview.toggle');
  assert.match(f.item.tooltip, /one local/i);
});

test('quarantined events keep coverage visibly incomplete after later delivery', () => {
  const f = fixture(true, { connected: true, lastEvent: 1, incomplete: true });
  assert.equal(f.item.text, '$(warning) Review: ON');
  assert.match(f.item.tooltip, /coverage is incomplete/);
  assert.match(f.item.tooltip, /manually/);
  f.set(false);
  assert.equal(f.item.text, '$(circle-slash) Review: OFF');
});

test('enabling without a connection reports both the mode and connection problem', () => {
  const f = fixture(false, {}); f.set(true);
  assert.match(f.messages[0], /is ON/);
  assert.match(f.messages[0], /not connected/i);
});
test('R16 event delivery, confirmed patch, counts and auto-open reason are separate facts', () => {
  const state = { connected: true, lastEvent: 1, ready: 2, blocked: 1, running: 3, skipped: 4, autoOpenReason: 'disabled in settings' }, f = fixture(true, state);
  assert.match(f.item.tooltip, /Last lifecycle event: 1970/);
  assert.match(f.item.tooltip, /Last confirmed queued patch: not observed/);
  assert.match(f.item.tooltip, /2 ready blocks, 1 paused files, 3 running files/);
  assert.match(f.item.tooltip, /4 unsupported or skipped operations/); assert.match(f.item.tooltip, /disabled in settings/);
  state.lastPatch = 2; f.status.update(); assert.match(f.item.tooltip, /Last confirmed queued patch: 1970/);
  assert.equal(f.item.text, '$(check) Review: ON'); assert.equal(f.messages.length, 0);
  for (let i = 0; i < 100; i++) f.status.update(); assert.equal(f.item.text, '$(check) Review: ON', 'Idle time does not invent a disconnection');
});

for (const state of [{ available: false }, { connected: false }, { connected: true }, { connected: true, lastEvent: 1 }]) {
  test('one click can disable every connection state: ' + JSON.stringify(state), () => {
    const f = fixture(true, state);
    assert.equal(f.item.command, 'changeReview.toggle');
    f.set(false);
    assert.equal(f.item.text, '$(circle-slash) Review: OFF');
    assert.equal(f.item.command, 'changeReview.toggle');
    assert.match(f.item.tooltip, /not recorded/i);
    assert.match(f.item.tooltip, /preserved/i);
    assert.deepEqual(f.messages, ['Agent Review is OFF.']);
    for (let index = 0; index < 50; index++) f.status.update();
    assert.equal(f.messages.length, 1);
  });
}
