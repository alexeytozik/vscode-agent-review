'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { createPatch } = require('diff');
const { handle, deliver } = require('../hook-runner');
const ioFactory = require('../review-io'), originalIO = ioFactory.createReviewIO;
let failure;
ioFactory.createReviewIO = (...args) => {
  const io = originalIO(...args);
  return {
    create: edit => { if (failure?.kind === 'create') { failure.hit = true; return Promise.resolve(false); } return io.create(edit); },
    remove: uri => { if (failure?.kind === 'remove') { failure.hit = true; throw new Error('delete unavailable'); } return io.remove(uri); },
    save: doc => {
      if (failure?.kind === 'save' && failure.path === doc.uri.fsPath) { failure.hit = true; return Promise.resolve(false); }
      return io.save(doc);
    },
    edit: (editor, callback) => {
      if (failure?.kind === 'edit' && failure.path === editor.document.uri.fsPath) { failure.hit = true; return Promise.resolve(false); }
      if (failure?.kind === 'later-edit' && !failure.hit && failure.path === editor.document.uri.fsPath) {
        failure.hit = true;
        return io.edit(editor, callback).then(async result => {
          await io.edit(editor, edit => edit.insert(editor.document.positionAt(editor.document.getText().length), 'later manual\n'));
          return result;
        });
      }
      return io.edit(editor, callback);
    }
  };
};

module.exports = { run: async () => {
  const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  try {
    const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready; await api.hooks.ready;
    if (!api.hooks.status().connected) await api.hooks.connect();
    let sequence = 0;
    async function inject(name, threadId = 'decisions', before = 'one\nanchor\nthree\n', after = 'ONE\nanchor\nTHREE\n', mode = 0o644) {
      const full = path.join(root, name), turnId = 'turn-' + ++sequence;
      if (after === null) await fs.unlink(full).catch(error => { if (error.code !== 'ENOENT') throw error; });
      else { await fs.writeFile(full, after); await fs.chmod(full, mode); }
      await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', itemId: 'edit', threadId, turnId, changes: [{ path: full, kind: { type: before === null ? 'add' : after === null ? 'delete' : 'update' }, diff: createPatch(full, before || '', after || ''), snapshot: { disk: after, text: after, mode, canonical: full } }] });
      await api.receive({ method: 'turn/completed', threadId, turnId });
      return { full, threadId, turnId, before, after };
    }
    async function feedback(session) {
      const result = await handle(api.hooks.store, { hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: 'next', cwd: root });
      await deliver(result, async () => {}); return result.hookSpecificOutput?.additionalContext;
    }
    const argument = full => { const e = api.entries().find(e => e.file.path === full); return { turn: e.turn.key, path: full, revision: e.revision, hunk: e.hunks[0].id }; };
    if (process.env.REVIEW_TEST_PHASE === 'decisions-restore') {
      assert.equal(api.isEnabled(), false); await api.setEnabled(true); await api.refresh();
      assert.equal(await fs.readFile(path.join(root, 'restart-undo.txt'), 'utf8'), 'old\n');
      assert.equal(api.entries().length, 1, 'An interrupted Keep is not accepted automatically on restart');
      assert.equal(api.entries()[0].file.path, path.join(root, 'restart-pending-keep.txt'));
      assert.equal(await feedback('pending-keep'), undefined);
      assert.match(await feedback('restart-undo'), /0 kept, 1 undone/);
      assert.match(await feedback('restart-keep'), /1 kept, 0 undone/);
      await api.decide(argument(path.join(root, 'restart-pending-keep.txt')), 'accept');
      assert.match(await feedback('pending-keep'), /1 kept, 0 undone/);
      assert.equal(api.entries().length, 0);
      assert.equal(api.getState().feedback.length, 0);
      await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true })); return;
    }
    const first = await inject('first.txt'), other = await inject('other.txt', 'other', 'old\n', 'new\n');
    await api.acceptAll();
    assert.match(await feedback('decisions'), /2 kept, 0 undone/);
    assert.match(await feedback('other'), /1 kept, 0 undone/);
    assert.equal(await feedback('decisions'), undefined);
    assert.equal(await fs.readFile(first.full, 'utf8'), first.after); assert.equal(await fs.readFile(other.full, 'utf8'), other.after);
    const failed = await inject('persist.txt', 'failure');
    const rename = fs.rename;
    fs.rename = async (...args) => { if (args[1].endsWith('request-review.json')) throw Object.assign(new Error('persist failed'), { code: 'EIO' }); return rename(...args); };
    try { await assert.rejects(api.acceptAll(), /persist failed/); }
    finally { fs.rename = rename; }
    assert.equal(api.entries().find(e => e.file.path === failed.full).hunks.length, 2, 'Failed persist must not mark Keep All complete');
    assert.equal(await feedback('failure'), undefined);
    assert.equal(await fs.readFile(failed.full, 'utf8'), failed.after);
    const entry = api.entries().find(e => e.file.path === failed.full);
    await api.bulk({ turn: entry.turn.key, path: failed.full }, 'reject');
    assert.match(await feedback('failure'), /0 kept, 2 undone/); assert.equal(await fs.readFile(failed.full, 'utf8'), failed.before);
    const output = await inject('feedback.txt', 'retry-feedback', 'old\n', 'new\n');
    const decision = api.hooks.decision;
    api.hooks.decision = async () => { throw new Error('feedback unavailable'); };
    try { await api.acceptAll(); } finally { api.hooks.decision = decision; }
    assert.equal(api.getState().feedback.length, 1, 'A saved decision must stay retryable when feedback storage fails');
    await api.refresh(); assert.match(await feedback('retry-feedback'), /1 kept, 0 undone/);
    assert.equal(api.getState().feedback.length, 0); assert.equal(await fs.readFile(output.full, 'utf8'), output.after);
    const repeated = await inject('repeated.txt', 'repeated', 'old\n', 'new\n');
    await api.decide(argument(repeated.full), 'reject');
    await fs.writeFile(repeated.full, 'new\n');
    const repeatedDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === repeated.full);
    for (let i = 0; repeatedDoc.getText() !== 'new\n' && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(repeatedDoc.getText(), 'new\n', 'VS Code must load the second actual external write before reviewing it');
    await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', itemId: 'second-edit', threadId: repeated.threadId, turnId: repeated.turnId,
      changes: [{ path: repeated.full, kind: { type: 'update' }, diff: createPatch(repeated.full, 'old\n', 'new\n'), snapshot: { disk: 'new\n', text: 'new\n', mode: 0o644, canonical: repeated.full } }] });
    await api.receive({ method: 'turn/completed', threadId: repeated.threadId, turnId: repeated.turnId });
    await api.decide(argument(repeated.full), 'reject');
    assert.match(await feedback('repeated'), /0 kept, 2 undone/, 'Different equal-content operations must keep both decision counts');
    console.log('PASS: single/bulk/Accept All counts, failed persist and retryable feedback');

    const failedSave = await inject('save.txt', 'save', 'old\n', 'new\n');
    const doc = await vscode.workspace.openTextDocument(failedSave.full);
    const saveFailure = failure = { kind: 'save', path: failedSave.full };
    try { await assert.rejects(api.decide(argument(failedSave.full), 'reject'), /not saved/); }
    finally { failure = undefined; }
    assert.ok(saveFailure.hit);
    assert.equal(doc.getText(), 'old\n'); assert.ok(doc.isDirty);
    assert.equal(await fs.readFile(failedSave.full, 'utf8'), 'new\n');
    await api.refresh(); assert.match(api.entries().find(e => e.file.path === failedSave.full).file.error, /saving failed/);
    assert.equal(await feedback('save'), undefined);
    await doc.save(); await api.refresh(); assert.match(await feedback('save'), /0 kept, 1 undone/);

    const failedWrite = await inject('write.txt', 'write', 'old\n', 'new\n');
    const editFailure = failure = { kind: 'edit', path: failedWrite.full };
    try { await assert.rejects(api.decide(argument(failedWrite.full), 'reject'), /did not finish/); }
    finally { failure = undefined; }
    assert.ok(editFailure.hit); assert.equal(await fs.readFile(failedWrite.full, 'utf8'), 'new\n');
    await api.refresh(); assert.equal(api.entries().find(e => e.file.path === failedWrite.full).file.error, undefined);
    assert.equal(await feedback('write'), undefined); await api.discardSnapshot(argument(failedWrite.full).turn);

    for (const [kind, before, after] of [['create', 'old\n', null], ['remove', null, 'new\n']]) {
      const item = await inject(kind + '-failure.txt', kind, before, after), injected = failure = { kind };
      try { await assert.rejects(api.decide(argument(item.full), 'reject'), /did not finish/); } finally { failure = undefined; }
      assert.ok(injected.hit); assert.equal(await fs.readFile(item.full, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return null; }), after);
      assert.equal(await feedback(kind), undefined); await api.refresh();
      assert.equal(api.entries().find(e => e.file.path === item.full).file.error, undefined);
      await api.decide(argument(item.full), 'reject');
      assert.equal(await fs.readFile(item.full, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; return null; }), before);
      assert.match(await feedback(kind), /0 kept, 1 undone/);
    }

    const later = await inject('later.txt', 'later', 'old\n', 'new\n');
    failure = { kind: 'later-edit', path: later.full };
    try { await assert.rejects(api.decide(argument(later.full), 'reject'), /not saved/); }
    finally { failure = undefined; }
    const laterDoc = await vscode.workspace.openTextDocument(later.full);
    assert.equal(laterDoc.getText(), 'old\nlater manual\n', 'Failure recovery must not roll back a later manual edit');
    assert.equal(await fs.readFile(later.full, 'utf8'), 'new\n');
    await api.discardSnapshot(argument(later.full).turn); await laterDoc.save();

    const permissions = await inject('permissions.txt', 'permissions', 'restored\n', null, 0o755), chmod = fs.chmod;
    fs.chmod = async (...args) => { if (args[0] === permissions.full) throw new Error('chmod failed'); return chmod(...args); };
    try { await assert.rejects(api.decide(argument(permissions.full), 'reject'), /chmod failed/); }
    finally { fs.chmod = chmod; }
    assert.equal(await fs.readFile(permissions.full, 'utf8'), 'restored\n');
    await api.refresh(); assert.match(api.entries().find(e => e.file.path === permissions.full).file.error, /permissions differ/);
    assert.equal(await feedback('permissions'), undefined);
    await fs.chmod(permissions.full, 0o755); await api.refresh();
    assert.match(await feedback('permissions'), /0 kept, 1 undone/);
    console.log('PASS: failed buffer write/save/chmod retain snapshots and recover without overwriting later data');

    async function interruptCommit(full, stop = false, action = 'reject') {
      let intentId, blocked = false;
      fs.rename = async (...args) => {
        if (args[1].endsWith('request-review.json')) {
          const candidate = JSON.parse(await fs.readFile(args[0], 'utf8'));
          intentId ||= candidate.turns.flatMap(t => t.files).find(f => f.path === full)?.decision?.id;
          if (intentId && candidate.feedback.some(record => record.id === intentId)) { blocked = true; throw new Error('commit interrupted'); }
        }
        return rename(...args);
      };
      try {
        await assert.rejects(api.decide(argument(full), action), /not saved|did not finish/);
        if (stop) await api.setEnabled(false);
      } finally { fs.rename = rename; }
      assert.ok(blocked, 'Inject the decision commit rather than an unrelated scheduled refresh');
      assert.equal(await fs.readFile(full, 'utf8'), action === 'reject' ? 'old\n' : 'new\n');
    }
    const conflict = await inject('interrupted.txt', 'interrupted', 'old\n', 'new\n');
    await interruptCommit(conflict.full); await fs.writeFile(conflict.full, 'later manual\n'); await api.refresh();
    assert.equal(await fs.readFile(conflict.full, 'utf8'), 'later manual\n');
    assert.match(api.entries().find(e => e.file.path === conflict.full).file.error, /later edits/);
    assert.equal(await feedback('interrupted'), undefined); await api.discardSnapshot(argument(conflict.full).turn);

    await inject('restart-keep.txt', 'restart-keep', 'old\n', 'new\n');
    api.hooks.decision = async () => { throw new Error('feedback unavailable'); };
    try { await api.acceptAll(); } finally { api.hooks.decision = decision; }
    // Keep this already committed summary pending through the following restart.
    api.hooks.decision = async () => false;
    const pendingKeep = await inject('restart-pending-keep.txt', 'pending-keep', 'old\n', 'new\n');
    const restart = await inject('restart-undo.txt', 'restart-undo', 'old\n', 'new\n');
    await interruptCommit(pendingKeep.full, false, 'accept');
    await interruptCommit(restart.full, true);
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true }));
  } catch (error) { await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
