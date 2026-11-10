'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { spawn, spawnSync } = require('node:child_process');

async function run() {
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath, root = await fs.realpath(folder);
  const manifest = require('../package.json');
  const extension = vscode.extensions.getExtension(manifest.publisher + '.' + manifest.name);
  const api = await extension.activate(); await api.ready; await api.hooks.ready;
  assert.ok(!(await vscode.commands.getCommands()).includes('_changeReview.nativeInspect'));
  await fs.writeFile(path.join(root, 'first.txt'), 'before\n');
  await fs.writeFile(path.join(root, 'second.txt'), 'old\n');
  const cli = process.env.REVIEW_AGENT_CLI;
  if (!cli) throw Error('REVIEW_AGENT_CLI is required for a live request');
  const prompt = 'Use apply_patch only. In first.txt replace before with after. In second.txt replace old with new. Preserve final newlines and all other files. Do not run shell commands, delegate or read credentials. Reply done.';
  let server;
  try {
    await api.hooks.connect();
    if ((process.env.REVIEW_LIVE_TRANSPORT || 'app-server') === 'app-server') {
      server = await require('./live-client').appServer(cli, root, api.hooks.store, extension.extensionPath);
      await server.turn(prompt);
    } else {
      const help = spawnSync(cli, ['--help'], { encoding: 'utf8' }).stdout || '';
      const args = [...(help.includes('--no-daemon') ? ['--no-daemon'] : []), '--dangerously-bypass-hook-trust', '-a', 'never', '-s', 'workspace-write', '-C', root, 'exec', '--skip-git-repo-check', '--json', prompt];
      const child = spawn(cli, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '', force;
      child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { err += bytes; });
      const timeout = setTimeout(() => { child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 2000); }, 150000);
      let status;
      try { status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
      finally { clearTimeout(timeout); clearTimeout(force); }
      await fs.writeFile(path.join(folder, 'live-events.log'), out + '\n' + err, { mode: 0o600 });
      assert.equal(status, 0, 'Live request must finish successfully; inspect the isolated live-events.log');
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await api.hooks.drain();
      if (api.entries().length === 2 && api.entries().every(entry => !entry.turn.running)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const entries = api.entries();
    assert.equal(entries.length, 2, 'Actual lifecycle hooks produce exactly two files');
    assert.ok(entries.every(entry => !entry.file.error && !entry.turn.running));
    assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'after\n');
    assert.equal(await fs.readFile(path.join(root, 'second.txt'), 'utf8'), 'new\n');
    const first = entries.find(entry => path.basename(entry.file.path) === 'first.txt');
    const view = vscode.workspace.getConfiguration('changeReview').get('view', 'review');
    async function rendered() {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        const current = api.reviewView.inspect();
        if (current.visible && current.ready && current.rendered === current.state?.id) return current.state;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail('The current review tab did not render');
    }
    if (view === 'review') {
      const initial = await rendered();
      assert.equal(initial.arg.path, entries[0].file.path, 'Automatically open the first change');
      assert.equal(initial.blocks.filter(block => block.kind !== 'removed').map(block => block.text).join(''), await fs.readFile(initial.arg.path, 'utf8'));
      const cache = path.join(path.dirname(api.hooks.store), 'request-review.json');
      const saved = JSON.parse(await fs.readFile(cache, 'utf8'));
      api.reviewView.dispose();
      assert.equal(api.reviewView.inspect().visible, false);
      assert.equal(api.entries().length, 2, 'Closing preserves both pending files');
      assert.deepEqual(JSON.parse(await fs.readFile(cache, 'utf8')), saved, 'Closing makes no implicit decisions');
      await vscode.commands.executeCommand('changeReview.show'); await rendered();
      await api.show({ turn: first.turn.key, path: first.file.path });
      const keep = await rendered();
      await api.reviewView.receive({ action: 'accept', id: keep.id });
      const undo = await rendered();
      assert.equal(path.basename(undo.arg.path), 'second.txt', 'Keep advances to the next file');
      await Promise.all([api.reviewView.receive({ action: 'reject', id: undo.id }), api.reviewView.receive({ action: 'reject', id: undo.id })]);
    } else {
      assert.equal(view, 'editor', 'Only explicitly supported live views may be tested');
      assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, entries[0].file.path, 'Automatically open the first change');
      const { actionAt } = require('./review-actions');
      await api.show({ turn: first.turn.key, path: first.file.path });
      const keep = await actionAt(vscode.window.activeTextEditor.document, 0, 'accept');
      await vscode.commands.executeCommand(keep.command, ...keep.arguments);
      const undo = await actionAt(vscode.window.activeTextEditor.document, 0, 'reject');
      await Promise.all([vscode.commands.executeCommand(undo.command, ...undo.arguments), vscode.commands.executeCommand(undo.command, ...undo.arguments)]);
    }
    assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'after\n');
    assert.equal(await fs.readFile(path.join(root, 'second.txt'), 'utf8'), 'old\n');
    assert.equal(api.entries().length, 0);
    const connection = JSON.parse(await fs.readFile(path.join(api.hooks.store, 'connection.json'), 'utf8'));
    assert.ok(connection.enabled);
    if (server) {
      const reply = await server.turn('Do not use any tools. What does the automatic local review summary say? Reply only as kept=X undone=Y using the counts in that summary.');
      assert.match(reply, /kept=1\s+undone=1/, 'The next real request receives the batched review decisions');
      assert.equal(server.contexts().length, 1, 'Exactly one review summary was delivered to the next request');
      assert.match(server.contexts()[0], /1 kept, 1 undone/);
      if (view === 'review') {
        api.reviewView.dispose(); assert.equal(api.reviewView.inspect().visible, false);
        await server.turn('Use apply_patch only. In first.txt replace after with final. Preserve final newlines and all other files. Do not run shell commands, delegate or read credentials. Reply done.');
        const until = Date.now() + 15000;
        while (Date.now() < until) {
          await api.hooks.drain();
          if (api.entries().length === 1 && api.entries().every(entry => !entry.turn.running)) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(api.entries().length, 1);
        assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'final\n');
        const incoming = await rendered();
        assert.equal(incoming.arg.path, first.file.path, 'New incoming changes reopen a previously closed review tab');
        assert.equal(server.contexts().length, 1, 'Old decisions are not delivered again on the following request');
        await api.reviewView.receive({ action: 'reject', id: incoming.id });
        assert.equal(await fs.readFile(path.join(root, 'first.txt'), 'utf8'), 'after\n', 'Undo of the new request preserves the previously kept change');
        assert.equal(await fs.readFile(path.join(root, 'second.txt'), 'utf8'), 'old\n');
        assert.equal(api.entries().length, 0);
      }
    } else {
      const { handle } = require('../hook-runner');
      const summary = await handle(api.hooks.store, { hook_event_name: 'UserPromptSubmit', session_id: first.turn.threadId, turn_id: 'summary-check', cwd: root });
      assert.match(summary.hookSpecificOutput.additionalContext, /1 kept, 1 undone/);
    }
  } finally {
    try { if (server) await fs.writeFile(path.join(folder, 'live-events.log'), server.log(), { mode: 0o600 }); }
    finally { if (server) await server.close(); await api.hooks.disconnect(); }
  }
}
module.exports = { run: async () => {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  try { await run(); await fs.writeFile(path.join(root, 'hook-live-result.json'), JSON.stringify({ passed: true })); }
  catch (error) { await fs.writeFile(path.join(root, 'hook-live-result.json'), JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
