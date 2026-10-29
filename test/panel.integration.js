'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { createPatch } = require('diff');

async function run(root) {
  const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready;
  assert.equal(vscode.workspace.getConfiguration('changeReview').get('view'), 'review');
  assert.ok(!(await vscode.commands.getCommands()).includes('_changeReview.nativeInspect'), 'The review tab runs in a pristine editor');
  async function state() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const view = api.reviewView.inspect();
      if (view.visible && view.ready && view.rendered === view.state?.id) return view.state;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('The actual webview did not render its current state: ' + JSON.stringify(api.reviewView.inspect()));
  }
  async function action(action) { const current = await state(); await api.reviewView.receive({ action, id: current.id }); return state(); }
  let turn = 0;
  async function inject(files, complete = true) {
    const turnId = 'turn-' + ++turn, records = [];
    for (const [name, before, after] of files) {
      const full = path.join(root, name); await fs.writeFile(full, after);
      records.push({ path: full, kind: { type: 'update' }, diff: createPatch(full, before, after), snapshot: { disk: after, text: after, mode: 0o644 } });
    }
    await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'panel', turnId, itemId: 'changes', changes: records });
    if (complete) await api.receive({ method: 'turn/completed', threadId: 'panel', turnId });
    return turnId;
  }
  const phase = process.env.REVIEW_TEST_PHASE;
  if (phase !== 'panel') {
    const saved = JSON.parse(await fs.readFile(path.join(root, 'expected-panel.json'), 'utf8'));
    if (phase === 'panel-restore') {
      assert.equal(api.isEnabled(), false); assert.equal(api.reviewView.inspect().visible, false);
      assert.ok(api.entries().some(e => e.file.path === saved.path));
      await api.setEnabled(true); await api.show(saved);
      assert.equal((await state()).arg.path, saved.path);
      console.log('PASS: OFF and saved decisions survive a restart, then reopen in the review tab');
    } else {
      assert.equal(api.isEnabled(), true); assert.equal((await state()).arg.path, saved.path, 'ON resumes pending review automatically');
      await action('reject'); assert.equal(await fs.readFile(saved.path, 'utf8'), 'before\n');
      assert.ok(api.entries().some(e => e.file.error), 'Unrelated saved conflicts survive');
      console.log('PASS: a second restart automatically resumes the review tab and preserves conflicts');
    }
    return;
  }
  const id = await inject([['first.txt', 'one\nanchor\nthree\n', 'ONE\nanchor\nTHREE\n'], ['second.txt', 'old\n', 'NEW\n']], false);
  assert.equal(api.reviewView.inspect().visible, false, 'No review opens while the request is still running');
  await api.receive({ method: 'turn/completed', threadId: 'panel', turnId: id });
  const initial = await state();
  assert.equal(initial.total, 3); assert.equal(initial.index, 1); assert.equal(initial.path, 'first.txt');
  assert.equal(initial.fileChangeIndex, 1); assert.equal(initial.fileChangeCount, 2);
  assert.equal(initial.blocks.filter(block => block.kind !== 'removed').map(block => block.text).join(''), 'ONE\nanchor\nTHREE\n', 'The complete file is present while the first change is selected');
  assert.equal(new Set(initial.blocks.filter(block => block.hunk).map(block => block.hunk)).size, 2, 'All changes in this file are shown together');
  assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputWebview, 'The actual review tab is active');
  const firstDoc = await vscode.workspace.openTextDocument(path.join(root, 'first.txt'));
  assert.deepEqual(api.codeLenses(firstDoc), []); assert.equal(api.hover(firstDoc, new vscode.Position(0, 0)), undefined);
  let current = await action('accept'); assert.equal(current.index, 1); assert.equal(current.path, 'first.txt');
  assert.equal(current.fileChangeCount, 1);
  assert.equal(await api.reviewView.receive({ action: 'reject', id: initial.id }), false, 'A stale frame cannot reject the next block');
  await state(); current = await action('reject'); assert.equal(current.path, 'second.txt');
  assert.equal(current.fileChangeIndex, 1); assert.equal(current.fileChangeCount, 1);
  assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'ONE\nanchor\nthree\n');
  await api.setEnabled(false); assert.equal(api.reviewView.inspect().visible, false);
  await inject([['off.txt', 'before\n', 'unreviewed\n']]);
  assert.equal(api.reviewView.inspect().visible, false); assert.equal(api.entries().length, 1);
  await api.setEnabled(true); await api.show(current.arg); await action('reject');
  assert.equal(await fs.readFile(path.join(root, 'second.txt'), 'utf8'), 'old\n');
  assert.equal(await fs.readFile(path.join(root, 'off.txt'), 'utf8'), 'unreviewed\n');
  assert.equal(api.entries().length, 0);
  console.log('PASS: real webview render, Keep/Undo, stale messages, next file and OFF/ON without editor patches');

  const largeBefore = '# header\n' + Array.from({ length: 3500 }, (_, i) => `line ${i} ` + 'unchanged '.repeat(4) + '\n').join('') + '# end\n';
  const largeAfter = largeBefore.replace('line 5 ', 'updated 5 ').replace('line 3300 ', 'updated 3300 ');
  await inject([['full.txt', largeBefore, largeAfter]]);
  const full = await state();
  assert.ok(largeAfter.length > 80000);
  assert.equal(full.blocks.filter(block => block.kind !== 'removed').map(block => block.text).join(''), largeAfter);
  const last = full.blocks.filter(block => block.hunk).at(-1).hunk;
  await api.reviewView.receive({ action: 'select', id: full.id, hunk: last });
  const chosen = await state(); assert.equal(chosen.arg.hunk, last); assert.equal(chosen.index, 2);
  await action('reject'); assert.equal(await fs.readFile(path.join(root, 'full.txt'), 'utf8'), largeBefore.replace('line 5 ', 'updated 5 '));
  await api.show(); await action('accept'); assert.equal(api.entries().length, 0);
  console.log('PASS: complete file beyond 80000 characters and 2000 lines, all changes visible and block selection guarded');

  await inject([['older.txt', 'old\n', 'new\n']]);
  const older = (await state()).arg;
  await inject([['current.txt', 'old\n', 'new\n']]); await action('accept');
  assert.equal((await state()).complete, true); assert.equal(api.entries().length, 1);
  await api.show(older); await action('reject');
  await inject([['dirty.txt', 'old\nanchor\n', 'new\nanchor\n']]);
  const doc = await vscode.workspace.openTextDocument(path.join(root, 'dirty.txt')), edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, doc.positionAt(doc.getText().length), 'manual\n'); await vscode.workspace.applyEdit(edit); await api.refresh();
  await action('reject'); assert.equal(doc.getText(), 'old\nanchor\nmanual\n'); assert.ok(doc.isDirty);
  assert.equal(await fs.readFile(doc.uri.fsPath, 'utf8'), 'new\nanchor\n'); await doc.save();
  console.log('PASS: request-scoped completion and dirty buffer edits remain intact');

  await inject([['conflict.txt', 'before\n', 'after\n']]);
  await fs.writeFile(path.join(root, 'conflict.txt'), 'manual\n'); await api.refresh();
  const conflict = await state(); assert.match(conflict.error, /overlap/);
  await assert.rejects(api.reviewView.receive({ action: 'reject', id: conflict.id }), /overlap/);
  assert.equal(await fs.readFile(path.join(root, 'conflict.txt'), 'utf8'), 'manual\n');
  await assert.rejects(api.reviewView.receive({ action: 'open', id: api.reviewView.inspect().state.id }), /Unknown/);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(root, 'conflict.txt')));
  await api.show(conflict.arg); assert.match((await state()).error, /overlap/);
  await inject([['pending.txt', 'before\n', 'after\n']]);
  const pending = await state(); api.reviewView.dispose();
  assert.equal(await api.reviewView.receive({ action: 'accept', id: pending.id }), false);
  await api.show(pending.arg); assert.equal((await state()).path, 'pending.txt');
  await fs.writeFile(path.join(root, 'expected-panel.json'), JSON.stringify(pending.arg));
  await api.setEnabled(false);
  console.log('PASS: manual conflicts block unsafe decisions; closing the tab keeps the queue');
}
module.exports = { run: async () => {
  const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  try { await run(root); await fs.writeFile(path.join(root, process.env.REVIEW_TEST_PHASE + '-result.json'), JSON.stringify({ passed: true })); }
  catch (error) { await fs.writeFile(path.join(root, process.env.REVIEW_TEST_PHASE + '-result.json'), JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
