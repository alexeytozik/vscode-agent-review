'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), vscode = require('vscode');
const { createPatch } = require('diff');
const { handle, atomic, hash } = require('../hook-runner');
module.exports = { run: async () => {
  try {
    const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath), api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready; await api.hooks.ready;
    if (!api.hooks.status().connected) await vscode.commands.executeCommand('changeReview.connect');
    const full = path.join(root, 'late.txt'), pending = path.join(api.hooks.store, 'pending', hash('retention/request/operation') + '.json');
    const event = hook => ({ cwd: root, session_id: 'retention', turn_id: 'request', tool_use_id: 'operation', tool_name: 'apply_patch', hook_event_name: hook, tool_input: { command: '*** Begin Patch\n*** Update File: late.txt\n@@\n-before\n+after\n*** End Patch' } });
    if (process.env.REVIEW_TEST_PHASE === 'retention') {
      await fs.writeFile(full, 'before\n'); await handle(api.hooks.store, event('UserPromptSubmit')); await handle(api.hooks.store, event('PreToolUse')); await handle(api.hooks.store, event('Interrupt')); await api.hooks.drain();
      const record = JSON.parse(await fs.readFile(pending, 'utf8')); assert.ok(Number.isSafeInteger(record.created)); record.created = 4102444800000; await atomic(pending, record);
      assert.equal(api.entries().length, 0); await fs.writeFile(full, 'after\n');
    } else {
      assert.equal((await fs.stat(pending)).isFile(), true, 'Restart and clock skew cannot expire a tool snapshot');
      await handle(api.hooks.store, event('PostToolUse')); await api.hooks.drain();
      const entry = api.entries().find(e => e.file.path === full); assert.ok(entry); assert.equal(entry.turn.running, false, 'A late Post for a known completed request stays reviewable');
      const original = { baseline: entry.file.baseline, expected: entry.file.expected, mode: entry.file.mode };
      await assert.rejects(api.cleanup('pending'), /Disconnect/);
      await vscode.commands.executeCommand('changeReview.disconnect');
      const second = path.join(root, 'outbox.txt'); await fs.writeFile(second, 'new\n');
      await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', itemId: 'edit', threadId: 'retention', turnId: 'outbox', changes: [{ path: second, kind: { type: 'update' }, diff: createPatch(second, 'old\n', 'new\n'), snapshot: { disk: 'new\n', text: 'new\n', mode: 0o644, canonical: second } }] }); await api.receive({ method: 'turn/completed', threadId: 'retention', turnId: 'outbox' });
      const outbox = api.entries().find(e => e.file.path === second); await api.decide({ turn: outbox.turn.key, path: second, revision: outbox.revision, hunk: outbox.hunks[0].id }, 'accept');
      assert.equal(api.getState().feedback.length, 1); const result = await api.cleanup('feedback'); assert.equal(result.outbox, 1); assert.equal(api.getState().feedback.length, 0);
      await atomic(path.join(api.hooks.store, 'pending', 'manual.json'), { created: 1, files: [] });
      await atomic(path.join(api.hooks.store, 'events', '001-manual.json'), { version: 1, records: [] });
      const report = await api.hooks.inspectData(); assert.ok(!JSON.stringify(report).includes(root)); assert.ok(report.categories.pending.files);
      await api.cleanup('pending'); await api.cleanup('events');
      const kept = api.entries().find(e => e.file.path === full); assert.deepEqual({ baseline: kept.file.baseline, expected: kept.file.expected, mode: kept.file.mode }, original);
      const state = JSON.parse(await fs.readFile(path.join(path.dirname(api.hooks.store), 'request-review.json'), 'utf8')); assert.ok(state.turns.some(t => t.files.some(f => f.path === full)));
      assert.equal(await fs.readFile(full, 'utf8'), 'after\n'); assert.equal(await fs.readFile(second, 'utf8'), 'new\n');
    }
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true }));
  } catch (error) { await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
