'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { createPatch } = require('diff');
const factory = require('../mode-status');
const original = factory.createModeStatus;
const items = [], notifications = [];

factory.createModeStatus = (editor, enabled) => original({
  StatusBarAlignment: editor.StatusBarAlignment,
  window: {
    createStatusBarItem(...args) {
      const item = editor.window.createStatusBarItem(...args);
      items.push(item);
      return item;
    },
    showInformationMessage(message, ...args) {
      notifications.push(message);
      return editor.window.showInformationMessage(message, ...args);
    }
  }
}, enabled);

async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate();
  await api.ready;
  assert.equal(items.length, 1, 'The active extension creates one real status bar item');
  const item = items[0], config = vscode.workspace.getConfiguration('changeReview');
  const notices = () => notifications.filter(message => /^Agent Review is (ON|OFF)\.$/.test(message));
  async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(predicate(), 'Status catches up with the actual configuration');
  }
  assert.equal(api.isEnabled(), false);
  assert.equal(item.text, '$(circle-slash) Review: OFF');
  assert.equal(item.command, 'changeReview.toggle');
  assert.equal(notices().length, 0, 'Opening the window does not show a toggle notification');
  const full = path.join(root, 'pending-mode.txt');
  if (process.env.REVIEW_TEST_PHASE === 'mode-restore') {
    assert.equal(api.entries().length, 1, 'Pending decisions survive a restart while review is off');
    assert.equal(await fs.readFile(full, 'utf8'), 'after\n');
    const cache = path.join(path.dirname(api.hooks.store), 'request-review.json');
    assert.ok((await fs.stat(cache)).isFile(), 'Legacy snapshots are copied even while review is disabled');
    return;
  }

  await vscode.commands.executeCommand(item.command);
  assert.equal(api.isEnabled(), true);
  assert.equal(item.text, '$(check) Review: ON');
  assert.deepEqual(notices(), ['Agent Review is ON.']);
  await api.setEnabled(true);
  assert.equal(notices().length, 1, 'Setting the same value does not repeat the notification');

  await fs.writeFile(full, 'after\n');
  await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'mode', turnId: 'pending', itemId: 'change', changes: [{ path: full, kind: { type: 'update' }, diff: createPatch(full, 'before\n', 'after\n'), snapshot: { disk: 'after\n', text: 'after\n', mode: 0o644 } }] });
  await api.receive({ method: 'turn/completed', threadId: 'mode', turnId: 'pending' });
  assert.equal(api.entries().length, 1);
  await vscode.commands.executeCommand(item.command);
  assert.equal(api.isEnabled(), false);
  assert.equal(item.text, '$(circle-slash) Review: OFF');
  assert.equal(api.entries().length, 1, 'The switch preserves pending decisions');
  assert.equal(api.controlItems(vscode.window.activeTextEditor.document).length, 0);
  assert.equal(await fs.readFile(full, 'utf8'), 'after\n');
  assert.deepEqual(notices(), ['Agent Review is ON.', 'Agent Review is OFF.']);

  await config.update('enabled', true, vscode.ConfigurationTarget.Workspace);
  await waitFor(() => item.text === '$(check) Review: ON');
  assert.equal(notices().length, 3, 'An external setting change updates and notifies once');
  const globalValue = config.inspect('enabled').globalValue;
  await vscode.commands.executeCommand(item.command);
  assert.equal(api.isEnabled(), false);
  assert.equal(item.text, '$(circle-slash) Review: OFF');
  assert.equal(config.inspect('enabled').workspaceValue, false, 'The switch updates the existing workspace setting');
  assert.equal(config.inspect('enabled').globalValue, globalValue, 'The workspace switch preserves global preferences');
  assert.equal(notices().length, 4);
  assert.equal(items.length, 1, 'Toggles reuse the existing item');
  const storage = path.dirname(api.hooks.store);
  const legacy = path.join(path.dirname(storage), 'local-tools.change-review', 'request-review.json');
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  await fs.copyFile(path.join(storage, 'request-review.json'), legacy);
  await fs.unlink(path.join(storage, 'request-review.json'));

}

module.exports = { run: async () => {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const result = path.join(root, process.env.REVIEW_TEST_PHASE + '-result.json');
  try { await run(); await fs.writeFile(result, JSON.stringify({ passed: true })); }
  catch (error) { await fs.writeFile(result, JSON.stringify({ passed: false, error: error.stack })); throw error; }
  finally { factory.createModeStatus = original; }
} };
