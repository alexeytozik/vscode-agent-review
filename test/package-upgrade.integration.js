'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const vscode = require('vscode'), { createPatch } = require('diff');
module.exports = { run: async () => {
  try {
    const extension = vscode.extensions.getExtension('alexeytozik.agent-review'); assert.equal(extension.packageJSON.version, process.env.REVIEW_UPGRADE_VERSION); assert.ok(extension.extensionPath.startsWith(process.env.REVIEW_UPGRADE_EXTENSIONS + path.sep));
    const api = await extension.activate(); await api.ready; await api.hooks.ready;
    const root = process.env.REVIEW_UPGRADE_ROOT, checkpoint = path.join(root, 'checkpoint.json'), workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath), full = path.join(workspace, 'pending.txt'), configFile = path.join(process.env.CODEX_HOME, 'hooks.json');
    const off = process.env.REVIEW_UPGRADE_OFF !== '0';
    const snapshot = () => api.entries().map(entry => ({ turn: entry.turn.key, path: entry.file.path, baseline: entry.file.baseline, expected: entry.file.expected, mode: entry.file.mode, hunks: entry.hunks.length }));
    if (process.env.REVIEW_TEST_PHASE === 'before') {
      await api.hooks.connect();
      const before = '\ufeffold first 😺\r\nunchanged\r\nold last ё\r\n', after = before.replace('old first', 'new first').replace('old last', 'new last'); await fs.writeFile(full, after); await fs.chmod(full, 0o640);
      await api.receive({ method: 'item/completed', type: 'fileChange', threadId: 'upgrade', turnId: 'pending', itemId: 'edit', status: 'completed', changes: [{ path: full, kind: { type: 'update' }, diff: createPatch(full, before, after), snapshot: { disk: after, text: after, mode: 0o640, canonical: full } }] }); await api.receive({ method: 'turn/completed', threadId: 'upgrade', turnId: 'pending' });
      await api.setEnabled(!off); await api.refresh(); assert.equal(api.isEnabled(), !off); const entries = snapshot(); assert.equal(entries.length, 1); assert.equal(entries[0].hunks, 2);
      await fs.writeFile(checkpoint, JSON.stringify({ entries, after, config: await fs.readFile(configFile, 'utf8') }));
    } else {
      const saved = JSON.parse(await fs.readFile(checkpoint, 'utf8')); await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(api.isEnabled(), !off, 'The chosen ON/OFF mode survives the package upgrade'); assert.deepEqual(snapshot(), saved.entries, 'Unresolved baseline/expected/mode/hunks survive without decisions'); assert.equal(await fs.readFile(full, 'utf8'), saved.after); assert.equal((await fs.stat(full)).mode & 0o777, 0o640);
      assert.equal(await fs.readFile(configFile, 'utf8'), saved.config, 'Upgrade does not migrate or rewrite global handlers'); assert.equal(api.getState().feedback.length, 0, 'Upgrade creates no review decisions');
    }
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true, pendingFiles: 1, pendingHunks: 2, off }));
  } catch (error) { await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
