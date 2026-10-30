'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { createPatch } = require('diff');
module.exports = { run: async () => {
  const read = fs.readFile, realpath = fs.realpath, lstat = fs.lstat;
  const samples = [];
  try {
    const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
    const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready;
    await vscode.workspace.getConfiguration('changeReview').update('autoOpen', false, vscode.ConfigurationTarget.Workspace);
    const files = Array.from({ length: 100 }, (_, i) => path.join(root, 'pending-' + i + '.txt'));
    const before = 'old\nanchor\n', after = 'new\nanchor\n';
    await Promise.all(files.map(full => fs.writeFile(full, after)));
    await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'refresh', turnId: 'request', itemId: 'edit', changes:
      files.map(full => ({ path: full, kind: { type: 'update' }, diff: createPatch(full, before, after), snapshot: { disk: after, text: after, mode: 0o644, canonical: full } })) });
    await api.receive({ method: 'turn/completed', threadId: 'refresh', turnId: 'request' });
    let reads = [], stats = 0, resolutions = 0;
    fs.readFile = async (...args) => { if (files.includes(args[0])) reads.push(args[0]); return read(...args); };
    fs.lstat = async (...args) => { if (files.includes(args[0])) stats++; return lstat(...args); };
    fs.realpath = async (...args) => { if (files.includes(args[0])) resolutions++; return realpath(...args); };
    let start = Date.now(); await api.refresh();
    samples.push({ probe: 'explicit-full', files: 100, reads: reads.length, stats, realpaths: resolutions, elapsed_ms: Date.now() - start });
    assert.equal(reads.length, 100);
    reads = []; stats = resolutions = 0; start = Date.now();
    for (let i = 0; i < 6; i++) await fs.writeFile(files[0], after + 'manual ' + i + '\n');
    for (let i = 0; i < 200 && api.entries().find(e => e.file.path === files[0]).file.expected !== after + 'manual 5\n'; i++) await new Promise(resolve => setTimeout(resolve, 25));
    const elapsed = Date.now() - start;
    assert.equal(api.entries().find(e => e.file.path === files[0]).file.expected, after + 'manual 5\n');
    samples.push({ probe: 'one-path-burst', files: 100, writes: 6, reads: reads.length, unique_paths: new Set(reads).size, stats, realpaths: resolutions, elapsed_ms: elapsed });
    console.log(JSON.stringify(samples));
    assert.deepEqual([...new Set(reads)], [files[0]], 'A dirty file must not reread the other 99 pending files');
    assert.equal(reads.length, 1, 'The burst must be coalesced');
    // An unsaved editor buffer participates in refresh and is preserved by Undo.
    const doc = await vscode.workspace.openTextDocument(files[1]), editor = await vscode.window.showTextDocument(doc);
    reads = []; start = Date.now();
    await editor.edit(edit => edit.insert(doc.positionAt(doc.getText().length), 'unsaved\n'));
    for (let i = 0; i < 200 && api.entries().find(e => e.file.path === files[1]).file.expected !== after + 'unsaved\n'; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(api.entries().find(e => e.file.path === files[1]).file.expected, after + 'unsaved\n');
    assert.deepEqual([...new Set(reads)], [files[1]]);
    const entry = api.entries().find(e => e.file.path === files[1]); reads = [];
    await api.decide({ turn: entry.turn.key, path: files[1], revision: entry.revision, hunk: entry.hunks[0].id }, 'reject');
    assert.equal(doc.getText(), before + 'unsaved\n'); assert.ok(doc.isDirty);
    assert.equal(await read(files[1], 'utf8'), after);
    assert.ok(reads.filter(full => full === files[1]).length >= 2, 'Undo must still perform immediate safety rereads');
    const alias = path.join(root, 'alias'); await fs.symlink(root, alias, 'dir');
    const aliasDoc = await vscode.workspace.openTextDocument(path.join(alias, path.basename(files[2]))), aliasEditor = await vscode.window.showTextDocument(aliasDoc);
    assert.notEqual(aliasDoc.uri.fsPath, files[2], 'Exercise an actual lexical alias');
    await aliasEditor.edit(edit => edit.insert(aliasDoc.positionAt(aliasDoc.getText().length), 'discard me\n'));
    for (let i = 0; i < 200 && !api.entries().find(e => e.file.path === files[2]).file.expected.endsWith('discard me\n'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(api.entries().find(e => e.file.path === files[2]).file.expected, after + 'discard me\n');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    for (let i = 0; i < 200 && api.entries().find(e => e.file.path === files[2]).file.expected !== after; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(api.entries().find(e => e.file.path === files[2]).file.expected, after, 'Discard/close refreshes the canonical pending path');
    const moved = path.join(root, 'renamed.txt'); await fs.rename(files[3], moved);
    for (let i = 0; i < 200 && !api.entries().find(e => e.file.path === files[3]).file.error; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(api.entries().find(e => e.file.path === files[3]).file.error, /removed|missing/);
    assert.equal(await read(moved, 'utf8'), after);
    await fs.rename(moved, files[3]);
    for (let i = 0; i < 200 && api.entries().find(e => e.file.path === files[3]).file.error; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(api.entries().find(e => e.file.path === files[3]).file.error, undefined);
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true, samples }));
  } catch (error) { await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack, samples })); throw error; }
  finally { fs.readFile = read; fs.realpath = realpath; fs.lstat = lstat; }
} };
