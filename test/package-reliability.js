'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

// Exercise the installed runtime modules, not copies from the development tree.
module.exports = async (api, root, extensionPath) => {
  const { createConnection } = require(path.join(extensionPath, 'hook-connection.js'));
  const { atomic, handle, deliver, hash } = require(path.join(extensionPath, 'hook-runner.js'));
  const storage = path.join(root, 'transport'), home = path.join(root, 'home');
  const errors = [];
  const connection = createConnection({ storage, home, extensionPath, executable: process.execPath, root, enabled: () => true, receive: api.receive, report: e => errors.push(e) });
  try {
    await connection.ready;
    const common = { threadId: 'reliability', turnId: 'turn' }, full = path.join(root, 'complex.txt');
    const before = 'old\n'.repeat(6000), after = 'new\n'.repeat(6000);
    const safe = path.join(root, 'safe.txt');
    await fs.writeFile(full, after); await fs.writeFile(safe, 'new\n');
    const event = { ...common, method: 'item/completed', type: 'fileChange', itemId: 'change', status: 'completed', changes: [
      { path: full, kind: { type: 'update' }, diff: '--- complex.txt\n+++ complex.txt\n@@ -1,6000 +1,6000 @@\n' + '-old\n'.repeat(6000) + '+new\n'.repeat(6000), snapshot: { disk: after, text: after, mode: 0o644 } },
      { path: safe, kind: { type: 'update' }, diff: '--- safe.txt\n+++ safe.txt\n@@ -1 +1 @@\n-old\n+new\n', snapshot: { disk: 'new\n', text: 'new\n', mode: 0o644 } }
    ] };
    await atomic(path.join(connection.store, 'events', '001-invalid.json'), {});
    await atomic(path.join(connection.store, 'events', '002-valid.json'), { version: 1, records: [event, { ...common, method: 'turn/completed' }] });
    await connection.drain(); await connection.drain();
    assert.equal(errors.length, 1); assert.equal(connection.status().incomplete, true);
    const entries = api.entries();
    assert.match(entries.find(e => e.file.path === full).file.error, /diff is too large/);
    assert.equal(entries.find(e => e.file.path === safe).hunks.length, 1);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const view = api.reviewView.inspect();
      if (view.ready && view.rendered === view.state?.id && view.state.path === 'safe.txt') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const view = api.reviewView.inspect(); assert.equal(view.state.path, 'safe.txt');
    await api.reviewView.receive({ action: 'reject', id: view.state.id });
    assert.equal(await fs.readFile(safe, 'utf8'), 'old\n'); assert.equal(await fs.readFile(full, 'utf8'), after);
    await api.setEnabled(false); assert.equal(api.isEnabled(), false);
    await api.setEnabled(true);
    await atomic(path.join(connection.store, 'connection.json'), { root, pid: process.pid, enabled: true, updated: Date.now() });
    const feedback = path.join(connection.store, 'feedback', hash('reliability'));
    await atomic(path.join(feedback, '001-valid.json'), { action: 'reject', path: safe });
    await fs.writeFile(path.join(feedback, '002-corrupt.json'), '{');
    const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'reliability', turn_id: 'next', cwd: root };
    const response = await handle(connection.store, prompt);
    assert.match(response.hookSpecificOutput.additionalContext, /0 kept, 1 undone/);
    await assert.rejects(deliver(response, async () => { throw new Error('closed pipe'); }), /closed pipe/);
    const retry = await handle(connection.store, prompt); assert.deepEqual(retry, response);
    await deliver(retry, async text => assert.match(text, /safe.txt/));
    assert.deepEqual(await handle(connection.store, prompt), {});
    console.log('PASS: installed VSIX isolates complex diff and corrupt events, keeps OFF usable, and retries feedback after output failure');
  } finally { connection.dispose(); }
};
