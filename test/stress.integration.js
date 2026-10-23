'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vscode = require('vscode');
const { createPatch } = require('diff');

const { actionAt } = require('./review-actions');

async function run(root) {
  const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate();
  await api.ready;
  assert.ok([false, 'off'].includes(vscode.workspace.getConfiguration('editor').get('hover.enabled')));
  assert.equal(vscode.workspace.getConfiguration('editor').get('hover.delay'), 10000);
  assert.equal(api.entries().length, 0, 'Use a fresh isolated review queue');
  const iterations = [];
  const opened = new Set();
  for (let iteration = 1; iteration <= 5; iteration++) {
    const started = Date.now();
    const full = path.join(root, `iteration-${String(iteration).padStart(2, '0')}.txt`);
    const blocks = Array.from({ length: 50 }, (_, index) => ({
      prefix: `section-${index}\n`, suffix: `anchor-${index}\n`,
      before: index % 3 === 0 ? '' : `before-${index}\n`,
      after: index % 3 === 1 ? '' : `after-${index}\n`,
      action: (index + iteration) % 2 === 0 ? 'accept' : 'reject'
    }));
    const before = blocks.map(block => block.prefix + block.before + block.suffix).join('');
    const after = blocks.map(block => block.prefix + block.after + block.suffix).join('');
    const expected = blocks.map(block => block.prefix + (block.action === 'accept' ? block.after : block.before) + block.suffix).join('');
    await fs.writeFile(full, after);
    const event = { method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'review-stress', turnId: `iteration-${iteration}`, itemId: 'changes', changes: [{ path: full, kind: { type: 'update' }, diff: createPatch(full, before, after), snapshot: { disk: after, text: after, mode: 0o644 } }] };
    await api.receive(event);
    await api.receive({ method: 'turn/completed', threadId: event.threadId, turnId: event.turnId });
    let entry = api.entries().find(item => item.file.path === full);
    assert.ok(entry && !entry.file.error && !entry.turn.running);
    assert.equal(entry.hunks.length, 50, 'All changes are independent review blocks');
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor.document.uri.fsPath, full, 'Open each new tab automatically');
    assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputText);
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.isPreview, false);
    opened.add(full);
    const tabPaths = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText).map(tab => tab.input.uri.fsPath));
    assert.ok([...opened].every(file => tabPaths.has(file)), 'Each iteration retains a separate ordinary editor tab');
    const document = editor.document;
    const manual = `manual-note-${iteration}\n`;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.positionAt(document.getText().length), manual);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await api.refresh();
    let accepted = 0, rejected = 0;
    for (let index = 0; index < 50; index++) {
      entry = api.entries().find(item => item.file.path === full);
      assert.ok(entry && !entry.file.error);
      assert.equal(entry.hunks.length, 50 - index);
      const hunk = entry.hunks[0];
      assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, full);
      assert.equal(vscode.window.activeTextEditor.selection.active.line, hunk.newLine - 1, 'Automatically select the next unresolved change');
      const action = blocks[index].action;
      const link = await actionAt(document, hunk.newLine - 1, action);
      assert.equal(link.arguments[0].revision, entry.revision, 'Hover actions contain a fresh revision');
      assert.equal(link.arguments[0].hunk, hunk.id);
      await vscode.commands.executeCommand(link.command, ...link.arguments);
      if (action === 'accept') accepted++; else rejected++;
      const remaining = api.entries().find(item => item.file.path === full);
      assert.equal(remaining?.hunks.length || 0, 49 - index, 'Each decision resolves exactly one change');
      assert.ok(document.getText().endsWith(manual), 'Preserve unrelated unsaved edits after every decision');
    }
    assert.equal(accepted, 25); assert.equal(rejected, 25);
    assert.equal(api.entries().length, 0, 'No unresolved changes leak into the next iteration');
    assert.equal(document.getText(), expected + manual);
    assert.ok(document.isDirty, 'Review decisions do not save unrelated manual edits');
    assert.equal(await fs.readFile(full, 'utf8'), after, 'Keep the original disk contents until explicitly saved');
    assert.equal(api.hover(document, new vscode.Position(0, 0)), undefined);
    assert.ok(await document.save());
    assert.equal(await fs.readFile(full, 'utf8'), expected + manual);
    iterations.push({ iteration, file: full, changes: 50, accepted, rejected, insertions: 17, deletions: 17, replacements: 16, elapsedMs: Date.now() - started, sha256: createHash('sha256').update(expected + manual).digest('hex') });
    await fs.writeFile(path.join(root, 'stress-progress.json.tmp'), JSON.stringify(iterations));
    await fs.rename(path.join(root, 'stress-progress.json.tmp'), path.join(root, 'stress-progress.json'));
  }
  assert.equal(opened.size, 5);
  return { passed: true, totalChanges: 250, iterations };
}

module.exports = { run: async () => {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  try { await fs.writeFile(path.join(root, 'stress-result.json'), JSON.stringify(await run(root), null, 2)); }
  catch (error) { await fs.writeFile(path.join(root, 'stress-result.json'), JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
