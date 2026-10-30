'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), vscode = require('vscode');
const { createPatch } = require('diff');
module.exports = { run: async () => {
  try {
    const marker = 'private-fixture-value-6048', root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath), home = process.env.CODEX_HOME;
    assert.ok(home.includes('/diagnostics/home'), 'Use only the isolated diagnostic fixture home');
    await fs.writeFile(path.join(home, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'fixture-hook --value ' + marker }] }] } }));
    const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready; await api.hooks.ready;
    await vscode.commands.executeCommand('changeReview.connect');
    process.env.DIAGNOSTIC_FIXTURE_VALUE = marker;
    await vscode.workspace.getConfiguration('changeReview').update('exclude', ['sensitive/' + marker + '/**'], vscode.ConfigurationTarget.Workspace);
    const full = path.join(root, 'normal.txt'), before = 'old ' + marker + '\n', after = 'new ' + marker + '\n'; await fs.writeFile(full, after);
    await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', itemId: 'edit-' + marker, threadId: marker, turnId: 'request', changes: [{ path: full, kind: { type: 'update' }, diff: createPatch(full, before, after), snapshot: { disk: after, text: after, mode: 0o644, canonical: full } }] }); await api.receive({ method: 'turn/completed', threadId: marker, turnId: 'request' });
    const cache = path.join(path.dirname(api.hooks.store), 'request-review.json'), saved = await fs.readFile(cache, 'utf8'), report = await api.diagnostics(), text = JSON.stringify(report);
    assert.ok(!text.includes(marker)); assert.ok(!text.includes(root)); assert.ok(!text.includes(home)); assert.equal(report.queue.readyBlocks, 1); assert.equal(report.capture.lastResult, 'request-ready'); assert.equal(report.hooks.configured, true); assert.equal(report.hooks.ownedCommandCount, 5); assert.equal(report.settings.exclusionPatterns, 1); assert.equal(report.versions.vscode, vscode.version);
    assert.equal(await fs.readFile(cache, 'utf8'), saved, 'An on-demand report does not write the saved queue');
    await vscode.commands.executeCommand('changeReview.diagnostics'); const document = vscode.window.activeTextEditor.document;
    assert.equal(document.uri.scheme, 'untitled'); assert.equal(document.languageId, 'json'); assert.ok(!document.getText().includes(marker)); assert.equal(JSON.parse(document.getText()).queue.readyBlocks, 1);
    assert.equal(await fs.readFile(full, 'utf8'), after);
    await api.setEnabled(false); const off = await api.diagnostics(); assert.equal(off.settings.enabled, false); assert.equal(off.queue.readyBlocks, 1); assert.equal(off.capture.autoOpenReason, 'review-off');
    delete process.env.DIAGNOSTIC_FIXTURE_VALUE;
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true }));
  } catch (error) { delete process.env.DIAGNOSTIC_FIXTURE_VALUE; await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
