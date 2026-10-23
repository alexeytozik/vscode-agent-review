'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { createPatch } = require('diff');

async function run() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready;
  const { actionAt: reviewAction } = require('./review-actions');
  assert.ok(!(await vscode.commands.getCommands()).includes('_changeReview.nativeInspect'), 'The test runs without a patched editor');
  assert.ok(vscode.workspace.getConfiguration('changeReview').inspect('enabled'), 'Toggle configuration is registered in the loaded window');
  assert.ok([false, 'off'].includes(vscode.workspace.getConfiguration('editor').get('hover.enabled')));
  assert.equal(vscode.workspace.getConfiguration('editor').get('hover.delay'), 10000);
  if (process.env.REVIEW_TEST_PHASE === 'resume') {
    assert.equal(api.isEnabled(), true);
    const pending = api.entries().find(e => path.basename(e.file.path) === 'pending.txt'); assert.ok(pending);
    const deadline = Date.now() + 5000;
    while (vscode.window.activeTextEditor?.document.uri.fsPath !== pending.file.path && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, pending.file.path, 'Reload automatically resumes review for the open file');
    assert.equal(vscode.window.activeTextEditor.selection.active.line, 0);
    await reviewAction(vscode.window.activeTextEditor.document, 0, 'accept');
    console.log('PASS reload resumes pending review without commands or search'); return;
  }
  if (process.env.REVIEW_TEST_PHASE === 'restore') {
    assert.equal(api.isEnabled(), false, 'Disabled mode persists after restart');
    const pending = api.entries().find(e => path.basename(e.file.path) === 'pending.txt'); assert.ok(pending);
    await api.setEnabled(true);
    assert.ok(!pending.turn.running); await api.show({ turn: pending.turn.key, path: pending.file.path });
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText);
    assert.ok(api.entries().some(e => path.basename(e.file.path) === 'conflict.txt' && e.file.error));
    console.log('PASS pending queue restored after extension host restart'); return;
  }
  const first = path.join(root, 'first.txt'), second = path.join(root, 'second.txt');
  const original = 'manual before\none\nkeep1\nkeep2\nthree\nkeep3\nkeep4\n';
  await fs.writeFile(first, original); await fs.writeFile(second, 'alpha\nbeta\n');
  if (process.env.REVIEW_TEST_PHASE === 'fixture') {
    const changes = [];
    for (const [full, before, after] of [[first, original, original.replace('one\n', 'ONE\n').replace('three\n', 'THREE\n')], [second, 'alpha\nbeta\n', 'ALPHA\nbeta\n']]) {
      await fs.writeFile(full, after);
      changes.push({ path: full, kind: { type: 'update' }, diff: createPatch(full, before, after), snapshot: { disk: after, text: after, mode: 0o644 } });
    }
    await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'fixture-main', turnId: 'main', itemId: 'changes', changes });
    await api.receive({ method: 'turn/completed', threadId: 'fixture-main', turnId: 'main' });
  } else {
    const vendor = vscode.extensions.getExtension('openai.chatgpt'); await vendor.activate();
    const bridge = require(path.join(vendor.extensionPath, 'out/review-bridge.js'));
    const account = await bridge.request('account/read', { refreshToken: false }); assert.ok(account.account);
    const started = await bridge.request('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: true });
    const threadId = started.thread.id;
    await bridge.request('turn/start', { threadId, input: [{ type: 'text', text: 'Use apply_patch only: in first.txt replace the whole line one with ONE and the whole line three with THREE. Keep all other lines unchanged. In second.txt replace alpha with ALPHA. Do not run shell, do not delegate. Reply done.' }] });
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await bridge.drain();
      const state = api.getState().turns.find(t => t.threadId === threadId);
      if (state && !state.running) break;
      await new Promise(r => setTimeout(r, 300));
    }
    await bridge.drain();
  }
  let pending = api.entries(); assert.equal(pending.length, 2); assert.ok(pending.every(e => !e.file.error && !e.turn.running));
  assert.equal(pending.reduce((n, e) => n + e.hunks.length, 0), 3);
  console.log('PASS request produces two files and three independent blocks');
  let entry = pending.find(e => e.file.path === first);
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText, 'Normal file tab, not a diff tab');
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, first, 'Request completion automatically opens the first file');
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 1, 'Request completion selects the first change');
  const doc = await vscode.workspace.openTextDocument(first);
  let edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, doc.positionAt(doc.getText().length), 'manual after\n');
  assert.ok(await vscode.workspace.applyEdit(edit)); await api.refresh();
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
  assert.ok(lenses.some(l => l.command?.command === 'changeReview.accept'), 'Public inline actions are available');
  assert.equal(api.hover(doc, new vscode.Position(0, 0)), undefined, 'Unchanged lines have no review hover');
  const accept = await reviewAction(doc, 1, 'accept');
  await vscode.commands.executeCommand(accept.command, ...accept.arguments);
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 4, 'Continue at the next change in the same file');
  assert.equal(api.hover(doc, new vscode.Position(1, 0)), undefined, 'Accepted changes have no review hover');
  const reject = await reviewAction(doc, 4, 'reject');
  await vscode.commands.executeCommand(reject.command, ...reject.arguments);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, second, 'Continue in next actual file');
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText);
  assert.equal(doc.getText(), original.replace('one\n', 'ONE\n') + 'manual after\n');
  assert.ok(doc.isDirty, 'Manual buffer must not be saved implicitly');
  await doc.save(); assert.equal(await fs.readFile(first, 'utf8'), doc.getText());
  console.log('PASS public controls accept, reject and advance while preserving unsaved manual text');
  entry = api.entries().find(e => e.file.path === second);
  await api.decide({ turn: entry.turn.key, path: second, revision: entry.revision, hunk: entry.hunks[0].id }, 'reject');
  assert.equal(await fs.readFile(second, 'utf8'), 'alpha\nbeta\n'); assert.equal(api.entries().length, 0);
  console.log('PASS next file independently rejected');

  let sequence = 0;
  async function inject(name, before, after, mode = 0o644) {
    const full = path.join(root, name);
    if (after === null) await fs.unlink(full).catch(e => { if (e.code !== 'ENOENT') throw e; }); else await fs.writeFile(full, after, { mode });
    const event = { method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'fixture', turnId: 'turn-' + (++sequence), itemId: 'change', changes: [{ path: full, kind: { type: before === null ? 'add' : after === null ? 'delete' : 'update' }, diff: createPatch(name, before || '', after || ''), snapshot: { disk: after, text: after, mode } }] };
    await api.receive(event); await api.receive({ method: 'turn/completed', threadId: event.threadId, turnId: event.turnId });
    return api.entries().find(e => e.file.path === full);
  }
  for (const [name, before, after, mode] of [['created.txt', null, 'new\n', 0o644], ['deleted.sh', 'echo ok\r\n', null, 0o755], ['nested/deleted.sh', 'echo restored\n', null, 0o755], ['bom.txt', '\uFEFFone\r\ntwo', '\uFEFFONE\r\ntwo', 0o644]]) {
    const e = await inject(name, before, after, mode); assert.ok(e && !e.file.error, e?.file.error);
    await api.show({ turn: e.turn.key, path: e.file.path });
    const action = await reviewAction(vscode.window.activeTextEditor.document, 0, 'reject');
    await vscode.commands.executeCommand(action.command, ...action.arguments);
    if (before === null) await assert.rejects(fs.stat(e.file.path), { code: 'ENOENT' });
    else { assert.equal(await fs.readFile(e.file.path, 'utf8'), before); assert.equal((await fs.stat(e.file.path)).mode & 0o777, mode); }
  }
  console.log('PASS create/delete, executable mode, CRLF and BOM');

  const paused = await inject('paused.txt', 'before\n', 'after\n');
  const pausedDocument = await vscode.workspace.openTextDocument(paused.file.path);
  await api.setEnabled(false);
  assert.equal(api.isEnabled(), false);
  assert.equal(api.hover(pausedDocument, new vscode.Position(0, 0)), undefined);
  assert.ok(api.entries().some(e => e.file.path === paused.file.path), 'Disabling preserves pending decisions');
  const ignored = { method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'off-mode', turnId: 'ignored', itemId: 'change', changes: [{ path: path.join(root, 'ignored.txt'), kind: { type: 'add' }, diff: createPatch('ignored', '', 'ignored\n'), snapshot: { disk: 'ignored\n', text: 'ignored\n' } }] };
  await api.receive({ method: 'turn/started', threadId: ignored.threadId, turnId: ignored.turnId });
  await api.setEnabled(true);
  await api.receive(ignored); await api.receive({ method: 'turn/completed', threadId: ignored.threadId, turnId: ignored.turnId });
  assert.ok(!api.entries().some(e => e.file.path.endsWith('/ignored.txt')), 'Enabling mid-request does not capture its tail');
  assert.equal(api.controlItems(pausedDocument).length, 1);
  await api.acceptAll();
  assert.equal(api.entries().length, 0);
  assert.equal(await fs.readFile(paused.file.path, 'utf8'), 'after\n');
  console.log('PASS toggle hides buttons, preserves pending work, ignores disabled requests and accepts all without writing files');

  const navigation = { method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'navigation', turnId: 'files', itemId: 'change', changes: [] };
  for (const name of ['nav-first.txt', 'nav-second.txt']) {
    const full = path.join(root, name), before = 'before\n', after = 'after\n'; await fs.writeFile(full, after);
    navigation.changes.push({ path: full, kind: { type: 'update' }, diff: createPatch(name, before, after), snapshot: { disk: after, text: after, mode: 0o644 } });
  }
  await api.receive(navigation); await api.receive({ method: 'turn/completed', threadId: 'navigation', turnId: 'files' });
  await api.show({ turn: 'navigation/files', path: navigation.changes[0].path });
  await vscode.commands.executeCommand('changeReview.next');
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, navigation.changes[1].path);
  await vscode.commands.executeCommand('changeReview.previous');
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, navigation.changes[0].path);
  await api.acceptAll();
  console.log('PASS keyboard navigation moves between ordinary file tabs');
  const ordered = await inject('hover (edge).txt', 'one\nkeep1\ntwo\nkeep2\nthree\n', 'ONE\nkeep1\nTWO\nkeep2\nTHREE\n');
  await api.show({ turn: ordered.turn.key, path: ordered.file.path, hunk: ordered.hunks[1].id });
  const orderedDoc = vscode.window.activeTextEditor.document;
  const middle = await reviewAction(orderedDoc, 2, 'accept');
  assert.equal(middle.arguments[0].path, ordered.file.path, 'Parentheses in paths survive command URI encoding');
  await vscode.commands.executeCommand(middle.command, ...middle.arguments);
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 4, 'Review continues forward instead of jumping back to an earlier pending change');
  await api.decide(middle.arguments[0], 'reject').then(() => assert.fail('Stale native action must fail'), () => {});
  assert.equal(orderedDoc.getText(), 'ONE\nkeep1\nTWO\nkeep2\nTHREE\n');
  await api.acceptAll();
  console.log('PASS forward continuation, encoded paths and stale native action protection');
  const older = await inject('older-request.txt', 'before\n', 'after\n');
  const current = await inject('current-request.txt', 'before\n', 'after\n');
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, current.file.path, 'New request opens its own first change despite older queued requests');
  const lastAction = await reviewAction(vscode.window.activeTextEditor.document, 0, 'accept');
  await vscode.commands.executeCommand(lastAction.command, ...lastAction.arguments);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, current.file.path, 'Completing a request does not jump into an older request');
  assert.equal(api.entries().length, 1);
  assert.equal(api.entries()[0].turn.key, older.turn.key, 'Unrelated pending decisions are preserved');
  assert.equal(api.hover(vscode.window.activeTextEditor.document, new vscode.Position(0, 0)), undefined);
  await api.acceptAll();
  console.log('PASS automatic first change and request-scoped completion');
  const e = await inject('conflict.txt', 'before\n', 'after\n');
  await fs.writeFile(e.file.path, 'manual\n'); await api.refresh();
  assert.ok(api.entries().find(a => a.file.path === e.file.path).file.error);
  const conflictDoc = await vscode.workspace.openTextDocument(e.file.path);
  const conflictHover = api.hover(conflictDoc, new vscode.Position(0, 0));
  assert.match(conflictHover.contents[0].value.replace(/&nbsp;/g, ' '), /Review paused/);
  assert.ok(!conflictHover.contents[0].value.includes('command:'), 'Conflicts explain the issue without allowing unsafe actions');
  await assert.rejects(api.decide({ turn: e.turn.key, path: e.file.path, revision: e.revision, hunk: e.hunks[0].id }, 'reject'), /overlaps/);
  assert.equal(await fs.readFile(e.file.path, 'utf8'), 'manual\n');
  console.log('PASS overlapping manual edit refuses rejection');
  // Leave both a conflict and a pending block for the restart check.
  await fs.writeFile(path.join(root, 'pending.txt'), 'pending\n');
  const last = await inject('pending.txt', 'before\n', 'pending\n');
  assert.ok(last && !last.file.error);
  const removed = await inject('missing.txt', 'before\n', 'after\n');
  await fs.unlink(removed.file.path); await api.refresh();
  assert.match(removed.file.error, /removed after this request/);
  await api.show();
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, last.file.path, 'Saved conflicts do not block ordinary review');
  await fs.writeFile(path.join(root, 'expected-pending.json'), JSON.stringify({ turn: last.turn.key, path: last.file.path }));
  await api.setEnabled(false);
}
module.exports = { run: async () => {
  const phase = process.env.REVIEW_TEST_PHASE;
  const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, ['restore', 'resume'].includes(phase) ? `${phase}-result.json` : 'integration-result.json');
  try { await run(); await fs.writeFile(file, JSON.stringify({ passed: true })); }
  catch (error) { await fs.writeFile(file, JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
