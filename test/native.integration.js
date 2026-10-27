'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { createPatch } = require('diff');

async function run(root) {
  assert.ok((await vscode.commands.getCommands()).includes('_changeReview.nativeInspect'), 'Run against the supported local workbench integration');
  const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate();
  await api.ready;
  const first = path.join(root, 'first.txt'), second = path.join(root, 'second.txt');
  const before = 'one\nkeep\nthree\n', after = 'ONE\nkeep\nTHREE\n';
  await fs.writeFile(first, after); await fs.writeFile(second, 'NEW\n');
  await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'native', turnId: 'toolbar', itemId: 'changes', changes: [
    { path: first, kind: { type: 'update' }, diff: createPatch(first, before, after), snapshot: { disk: after, text: after, mode: 0o644 } },
    { path: second, kind: { type: 'update' }, diff: createPatch(second, 'old\n', 'NEW\n'), snapshot: { disk: 'NEW\n', text: 'NEW\n', mode: 0o644 } }
  ] });
  await api.receive({ method: 'turn/completed', threadId: 'native', turnId: 'toolbar' });
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, first);
  async function visible(full) {
    const uri = vscode.Uri.file(full).toString();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const controls = await vscode.commands.executeCommand('_changeReview.nativeInspect', uri);
      if (controls?.[0]?.visible && !controls[0].invalidated) return controls[0];
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Inline toolbar did not become visible: ' + path.basename(full));
  }
  const initial = await visible(first);
  assert.equal(initial.items.length, 2);
  assert.equal(initial.height, 22);
  assert.deepEqual(initial.actions.map(action => action.label), ['Undo', 'Keep']);
  assert.deepEqual(api.codeLenses(vscode.window.activeTextEditor.document), [], 'Native mode removes duplicate CodeLens');
  assert.equal(api.hover(vscode.window.activeTextEditor.document, new vscode.Position(0, 0)), undefined, 'Native mode removes delayed action hover');
  await Promise.all([1, 2].map(() => vscode.commands.executeCommand('_changeReview.nativeAction', initial.current.arg, 'reject', vscode.Uri.file(first).toString())));
  assert.equal(await fs.readFile(first, 'utf8'), 'one\nkeep\nTHREE\n', 'A double click undoes only its displayed change');
  const next = await visible(first);
  assert.notEqual(next.current.arg.hunk, initial.current.arg.hunk);
  assert.equal(vscode.window.activeTextEditor.selection.active.line, 2);
  await assert.rejects(vscode.commands.executeCommand('_changeReview.nativeAction', initial.current.arg, 'accept', vscode.Uri.file(first).toString()), /changed/);
  await vscode.commands.executeCommand('_changeReview.nativeAction', next.current.arg, 'accept', vscode.Uri.file(first).toString());
  assert.equal(await fs.readFile(first, 'utf8'), 'one\nkeep\nTHREE\n');
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, second, 'Resolving a file advances to the next file');
  const last = await visible(second);
  await api.setEnabled(false);
  assert.deepEqual(await vscode.commands.executeCommand('_changeReview.nativeInspect', vscode.Uri.file(second).toString()), [], 'OFF removes native controls');
  await api.setEnabled(true);
  const resumed = await visible(second);
  assert.equal(resumed.current.arg.hunk, last.current.arg.hunk, 'Toggling preserves the remaining decision');
  await vscode.commands.executeCommand('_changeReview.nativeAction', resumed.current.arg, 'reject', vscode.Uri.file(second).toString());
  assert.equal(await fs.readFile(second, 'utf8'), 'old\n');
  assert.equal(api.entries().length, 0);
  console.log('PASS: actual inline toolbar, no duplicate links, double/stale clicks, next hunk/file, OFF/ON and Keep/Undo bytes');
}

module.exports = { run: async () => {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  try { await run(root); await fs.writeFile(path.join(root, 'native-result.json'), JSON.stringify({ passed: true })); }
  catch (error) { await fs.writeFile(path.join(root, 'native-result.json'), JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
