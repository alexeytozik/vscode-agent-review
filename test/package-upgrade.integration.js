'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const vscode = require('vscode'), { createPatch } = require('diff');
module.exports = { run: async () => {
  try {
    const id = process.env.REVIEW_UPGRADE_ID, previousId = process.env.REVIEW_UPGRADE_PREVIOUS_ID;
    const extension = vscode.extensions.getExtension(id); assert.ok(extension, 'The phase must load the ID of its actual VSIX'); assert.equal(extension.packageJSON.version, process.env.REVIEW_UPGRADE_VERSION); assert.ok(extension.extensionPath.startsWith(process.env.REVIEW_UPGRADE_EXTENSIONS + path.sep));
    const root = process.env.REVIEW_UPGRADE_ROOT, checkpoint = path.join(root, 'checkpoint.json'), workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath), full = path.join(workspace, 'pending.txt'), configFile = path.join(process.env.CODEX_HOME, 'hooks.json');
    const off = process.env.REVIEW_UPGRADE_OFF !== '0';
    if (process.env.REVIEW_TEST_PHASE === 'coexist') {
      const saved = JSON.parse(await fs.readFile(checkpoint, 'utf8')), legacy = vscode.extensions.getExtension(previousId);
      assert.ok(legacy && previousId !== id, 'Both distinct package IDs must be enabled for this check');
      const blocked = await extension.activate(); await blocked.ready;
      assert.equal(blocked.migrationBlocked, true, 'The new extension must not compete with an enabled old installation');
      assert.equal(blocked.hooks, undefined);
      const oldApi = await legacy.activate(); await oldApi.ready; await oldApi.hooks.ready;
      assert.equal(oldApi.entries().length, 1); assert.equal(oldApi.entries()[0].hunks.length, 2);
      assert.equal(await fs.readFile(configFile, 'utf8'), saved.config);
      assert.equal(await fs.readFile(full, 'utf8'), saved.after);
      await assert.rejects(fs.stat(path.join(path.dirname(saved.storage), id, 'request-review.json')), { code: 'ENOENT' });
      await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true, guardedCoexistence: true, pendingFiles: 1, pendingHunks: 2, off }));
      return;
    }
    if (process.env.REVIEW_TEST_PHASE === 'after' && previousId !== id) assert.equal(vscode.extensions.getExtension(previousId), undefined, 'The installed old package must be disabled before migration');
    const api = await extension.activate(); await api.ready; await api.hooks.ready;
    const snapshot = () => api.entries().map(entry => ({ turn: entry.turn.key, path: entry.file.path, baseline: entry.file.baseline, expected: entry.file.expected, mode: entry.file.mode, hunks: entry.hunks.length }));
    if (process.env.REVIEW_TEST_PHASE === 'before') {
      await api.hooks.connect();
      const before = '\ufeffold first 😺\r\nunchanged\r\nold last ё\r\n', after = before.replace('old first', 'new first').replace('old last', 'new last'); await fs.writeFile(full, after); await fs.chmod(full, 0o640);
      await api.receive({ method: 'item/completed', type: 'fileChange', threadId: 'upgrade', turnId: 'pending', itemId: 'edit', status: 'completed', changes: [{ path: full, kind: { type: 'update' }, diff: createPatch(full, before, after), snapshot: { disk: after, text: after, mode: 0o640, canonical: full } }] }); await api.receive({ method: 'turn/completed', threadId: 'upgrade', turnId: 'pending' });
      await api.setEnabled(!off); await api.refresh(); assert.equal(api.isEnabled(), !off); const entries = snapshot(); assert.equal(entries.length, 1); assert.equal(entries[0].hunks, 2);
      const storage = path.dirname(api.hooks.store);
      await fs.writeFile(checkpoint, JSON.stringify({ entries, after, config: await fs.readFile(configFile, 'utf8'), storage, archive: await fs.readFile(path.join(storage, 'request-review.json'), 'utf8'), extensionPath: extension.extensionPath }));
    } else {
      const saved = JSON.parse(await fs.readFile(checkpoint, 'utf8')); await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(api.isEnabled(), !off, 'The chosen ON/OFF mode survives the package upgrade'); assert.deepEqual(snapshot(), saved.entries, 'Unresolved baseline/expected/mode/hunks survive without decisions'); assert.equal(await fs.readFile(full, 'utf8'), saved.after); assert.equal((await fs.stat(full)).mode & 0o777, 0o640);
      assert.equal(await fs.readFile(configFile, 'utf8'), saved.config, 'Upgrade does not migrate or rewrite global handlers');
      assert.deepEqual(api.getState().feedback, saved.feedback || [], 'Unsent saved decisions are copied without inventing or consuming them');
      if (previousId !== id) {
        assert.equal(await fs.readFile(path.join(saved.storage, 'request-review.json'), 'utf8'), saved.archive, 'Migration preserves the original saved queue');
        assert.ok((await fs.stat(saved.extensionPath)).isDirectory(), 'The disabled original package is retained');
        assert.notEqual(path.dirname(api.hooks.store), saved.storage, 'The new identity owns its own storage after migration');
        if (saved.feedback?.length) {
          assert.equal(api.hooks.status().connected, false, 'Migration alone does not bind the old transport');
          await vscode.commands.executeCommand('changeReview.connect');
          assert.equal(api.hooks.status().connected, true);
          assert.deepEqual(api.getState().feedback, [], 'The registered Connect flushes the copied outbox before the next prompt');
          const { handle, deliver, hash } = require(path.join(extension.extensionPath, 'hook-runner.js'));
          const record = saved.feedback[0], feedbackFile = path.join(api.hooks.store, 'feedback', hash('upgrade'), hash(record.id) + '.json');
          const stored = JSON.parse(await fs.readFile(feedbackFile, 'utf8'));
          assert.equal(stored.action, record.action); assert.equal(stored.path, record.path); assert.equal(stored.created, record.created);
          const prompt = turn => ({ hook_event_name: 'UserPromptSubmit', session_id: 'upgrade', turn_id: turn, cwd: workspace });
          const summary = await handle(api.hooks.store, prompt('first-after-migration'));
          assert.match(summary.hookSpecificOutput.additionalContext, /0 kept, 1 undone/);
          assert.match(summary.hookSpecificOutput.additionalContext, /reviewed\.txt/);
          await deliver(summary, async output => { assert.match(output, /0 kept, 1 undone/); });
          await assert.rejects(fs.stat(feedbackFile), { code: 'ENOENT' });
          assert.deepEqual(await handle(api.hooks.store, prompt('second-after-migration')), {}, 'The acknowledged summary is not repeated');
          assert.equal(await fs.readFile(path.join(saved.storage, 'request-review.json'), 'utf8'), saved.archive, 'Connect and acknowledgement preserve the old archive');
          assert.equal(await fs.readFile(full, 'utf8'), saved.after);
          assert.equal(await fs.readFile(path.join(workspace, 'reviewed.txt'), 'utf8'), 'original\n');
        }
      }
    }
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true, pendingFiles: 1, pendingHunks: 2, off }));
  } catch (error) { await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
