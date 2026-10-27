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
  async function visible(full, check = () => true) {
    const uri = vscode.Uri.file(full).toString();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const controls = await vscode.commands.executeCommand('_changeReview.nativeInspect', uri);
      if (controls?.[0]?.visible && !controls[0].invalidated && check(controls[0])) return controls[0];
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
  const wrapped = path.join(root, 'wrapped.md'), oldParagraph = 'before '.repeat(2000) + '\n', newParagraph = 'after '.repeat(2000) + '\n';
  await vscode.workspace.getConfiguration('editor').update('wordWrap', 'on', vscode.ConfigurationTarget.Workspace);
  await fs.writeFile(wrapped, newParagraph);
  await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'native', turnId: 'wrapped', itemId: 'paragraph', changes: [
    { path: wrapped, kind: { type: 'update' }, diff: createPatch(wrapped, oldParagraph, newParagraph), snapshot: { disk: newParagraph, text: newParagraph, mode: 0o644 } }
  ] });
  await api.receive({ method: 'turn/completed', threadId: 'native', turnId: 'wrapped' });
  const editor = vscode.window.activeTextEditor, middle = new vscode.Position(0, 6000);
  editor.selection = new vscode.Selection(middle, middle);
  editor.revealRange(new vscode.Range(middle, middle), vscode.TextEditorRevealType.InCenter);
  const paragraph = await visible(wrapped, state => state.firstLineTop < 0);
  assert.ok(paragraph.position.preference.top >= 0, 'The controls stay inside the viewport while the first visual row is off screen');
  await vscode.commands.executeCommand('_changeReview.nativeAction', paragraph.current.arg, 'reject', vscode.Uri.file(wrapped).toString());
  assert.equal(await fs.readFile(wrapped, 'utf8'), oldParagraph, 'A long wrapped paragraph can be undone from its visible middle');
  assert.equal(api.entries().length, 0);
  console.log('PASS: actual inline toolbar, no duplicate links, double/stale clicks, next hunk/file, OFF/ON and Keep/Undo bytes');
  console.log('PASS: native controls remain usable in a long wrapped Markdown paragraph');
  for (const extension of ['md', 'py']) {
    const full = path.join(root, 'long-line.' + extension), original = '# notes\n\n# before\n# ' + 'unchanged '.repeat(120) + '\n\n';
    const changed = original.replace('# before', '# after');
    await fs.writeFile(full, changed);
    await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'native', turnId: extension, itemId: 'line', changes: [
      { path: full, kind: { type: 'update' }, diff: createPatch(full, original, changed), snapshot: { disk: changed, text: changed, mode: 0o644 } }
    ] });
    await api.receive({ method: 'turn/completed', threadId: 'native', turnId: extension });
    const controls = await visible(full);
    assert.ok(controls.actions.every(action => action.labelVisible), 'Both labels remain readable beside a long line: ' + JSON.stringify(controls.actions));
    await vscode.commands.executeCommand('_changeReview.nativeAction', controls.current.arg, 'reject', vscode.Uri.file(full).toString());
    assert.equal(await fs.readFile(full, 'utf8'), original);
    assert.equal(api.entries().length, 0);
  }
  console.log('PASS: readable Keep/Undo labels beside long Markdown and Python lines, with exact Undo bytes');
}

module.exports = { run: async () => {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  try { await run(root); await fs.writeFile(path.join(root, 'native-result.json'), JSON.stringify({ passed: true })); }
  catch (error) { await fs.writeFile(path.join(root, 'native-result.json'), JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
