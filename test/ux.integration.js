'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { createPatch } = require('diff');
module.exports = { run: async () => {
  try {
    const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
    const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready;
    let sequence = 0;
    const auto = value => vscode.workspace.getConfiguration('changeReview').update('autoOpen', value, vscode.ConfigurationTarget.Workspace);
    async function inject(files) {
      const turnId = 'request-' + ++sequence, changes = [];
      for (const [name, before, after, invalid = false, mode = 0o644] of files) {
        const full = path.join(root, name);
        if (after === null) await fs.unlink(full).catch(e => { if (e.code !== 'ENOENT') throw e; }); else await fs.writeFile(full, after);
        if (after === null && before === '') await api.receive({ method: 'item/started', type: 'fileChange', itemId: 'edit', threadId: 'ux', turnId, changes: [{ path: full, snapshot: { disk: '', text: '', mode, canonical: full } }] });
        changes.push({ path: full, kind: { type: before === null ? 'add' : after === null ? 'delete' : 'update' }, diff: invalid ? 'invalid patch' : before === '' && after === null || before === null && after === '' ? '' : createPatch(full, before || '', after || ''), snapshot: { disk: after, text: after, mode, canonical: full } });
      }
      await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', itemId: 'edit', threadId: 'ux', turnId, changes });
      await api.receive({ method: 'turn/completed', threadId: 'ux', turnId }); return 'ux/' + turnId;
    }
    async function state() {
      for (let i = 0; i < 400; i++) { const view = api.reviewView.inspect(); if (view.visible && view.ready && view.rendered === view.state?.id) return view.state; await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.fail('Current review state was not rendered');
    }
    await auto(false); const older = await inject([['older.txt', 'old\n', 'new\n']]); assert.equal(api.reviewView.inspect().visible, false);
    const firstPatch = api.getStatus().lastPatch; assert.ok(firstPatch); assert.equal(api.getStatus().ready, 1); assert.equal(api.getStatus().autoOpenReason, 'disabled in settings');
    await auto(true); const allError = await inject([['error.txt', 'old\n', 'new\n', true]]);
    let current = await state(); assert.equal(current.arg.turn, allError); assert.ok(current.error); assert.equal(current.canNavigate, false);
    assert.equal(api.getStatus().lastPatch, firstPatch, 'A lifecycle event with an invalid patch is not a confirmed queued patch');
    assert.equal(api.getStatus().blocked, 1); assert.match(api.getStatus().autoOpenReason, /paused/);
    await assert.rejects(api.reviewView.receive({ action: 'accept', id: current.id }), /patch/);
    const mixed = await inject([['a-error.txt', 'old\n', 'new\n', true], ['b-ready.txt', 'old\n', 'new\n'], ['c-ready.txt', 'old\n', 'new\n']]);
    current = await state(); assert.equal(current.path, 'b-ready.txt'); assert.equal(current.blocked, 1);
    const blocked = api.entries().find(e => e.turn.key === mixed && e.file.error);
    await api.show({ turn: mixed, path: blocked.file.path }); current = await state(); assert.equal(current.canNavigate, true);
    await api.reviewView.receive({ action: 'previous', id: current.id }); current = await state(); assert.equal(current.path, 'c-ready.txt'); assert.equal(current.arg.turn, mixed);
    await api.show({ turn: mixed, path: blocked.file.path }); current = await state();
    await api.reviewView.receive({ action: 'next', id: current.id }); current = await state(); assert.equal(current.path, 'b-ready.txt');
    await api.reviewView.receive({ action: 'next', id: current.id - 1 }); assert.equal((await state()).path, 'b-ready.txt');
    assert.equal(await fs.readFile(blocked.file.path, 'utf8'), 'new\n');
    api.reviewView.dispose();
    await api.receive({ method: 'item/completed', type: 'externalTool', itemId: 'external', threadId: 'ux', turnId: 'unsupported' });
    await api.receive({ method: 'turn/completed', threadId: 'ux', turnId: 'unsupported' });
    current = await state(); assert.ok(current.complete); assert.ok(current.outcome.paused); assert.match(current.outcome.message, /No confirmed text patches/); assert.equal(current.arg, undefined);
    assert.equal(api.getStatus().skipped, 1); assert.match(api.getStatus().autoOpenReason, /unsupported/);
    api.reviewView.dispose(); await api.receive({ method: 'turn/started', threadId: 'ux', turnId: 'read-only' }); await api.receive({ method: 'turn/completed', threadId: 'ux', turnId: 'read-only' });
    assert.equal(api.reviewView.inspect().visible, false, 'A read-only request does not open a review of older errors');
    assert.equal(api.getStatus().skipped, 0); assert.equal(api.getStatus().autoOpenReason, 'no confirmed text changes');
    await auto(false); await inject([['no-auto.txt', 'old\n', 'new\n', true]]); assert.equal(api.reviewView.inspect().visible, false);
    await api.setEnabled(false); await auto(true); await inject([['off.txt', 'old\n', 'new\n', true]]); assert.equal(api.reviewView.inspect().visible, false);
    assert.equal(api.getStatus().autoOpenReason, 'review is OFF'); assert.equal(api.getStatus().skipped, 1);
    await api.setEnabled(true);
    for (const mode of [0o600, 0o755, 0]) {
      const turn = await inject([['deleted-' + mode, '', null, false, mode]]); current = await state(); assert.equal(current.kind, 'delete');
      await api.decide(current.arg, 'reject'); assert.equal((await fs.stat(path.join(root, 'deleted-' + mode))).mode & 0o777, mode); assert.equal((await fs.stat(path.join(root, 'deleted-' + mode))).size, 0);
      assert.ok(!api.entries().some(e => e.turn.key === turn));
    }
    const created = await inject([['created-empty.txt', null, '']]); current = await state(); assert.equal(current.kind, 'create'); await api.decide(current.arg, 'reject');
    assert.equal(await fs.stat(path.join(root, 'created-empty.txt')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }), false);
    assert.ok(!api.entries().some(e => e.turn.key === created));
    await inject([['kept-empty.txt', null, '']]); current = await state(); await api.decide(current.arg, 'accept'); assert.equal((await fs.stat(path.join(root, 'kept-empty.txt'))).size, 0);
    await inject([['kept-delete.txt', '', null]]); current = await state(); await api.decide(current.arg, 'accept'); assert.equal(await fs.stat(path.join(root, 'kept-delete.txt')).then(() => true, () => false), false);
    assert.ok(api.entries().some(e => e.turn.key === older), 'Other requests remain untouched');
    await api.receive({ method: 'turn/started', threadId: 'interleaved', turnId: 'a' });
    await api.receive({ method: 'item/completed', type: 'commandExecution', itemId: 'shell-a', readOnly: false, threadId: 'interleaved', turnId: 'a' });
    assert.equal(api.getStatus().skipped, 1);
    await api.receive({ method: 'turn/started', threadId: 'interleaved', turnId: 'b' });
    await api.receive({ method: 'turn/completed', threadId: 'interleaved', turnId: 'a' });
    assert.equal(api.getStatus().skipped, 1, 'Interleaving another request must not erase the skipped count');
    for (const turn of api.getState().turns) await api.discardSnapshot(turn.key);
    await inject([['after-unsupported.txt', 'old\n', 'new\n']]); await state(); await api.acceptAll(); current = await state();
    assert.equal(current.complete, true); assert.ok(!current.outcome?.paused); assert.match(current.outcome?.message, /kept|reviewed/);
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true }));
  } catch (error) { await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
