'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { createPatch } = require('diff');
const open = fs.open;
let transientRead = false;
if (process.env.REVIEW_TEST_PHASE === 'state-transient') fs.open = async (...args) => {
  if (!transientRead && args[0].endsWith('request-review.json')) { transientRead = true; throw Object.assign(new Error('temporary cache read'), { code: 'EIO' }); }
  return open(...args);
};

module.exports = { run: async () => {
  const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath), phase = process.env.REVIEW_TEST_PHASE;
  let storage;
  try {
    const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready;
    fs.open = open;
    storage = path.dirname(api.hooks.store);
    const cache = path.join(storage, 'request-review.json'), full = path.join(root, 'safe.txt');
    async function inject(turn) {
      await fs.writeFile(full, 'after\n');
      await api.receive({ method: 'item/completed', type: 'fileChange', threadId: 'state', turnId: turn, itemId: 'change', status: 'completed', changes: [{ path: full, kind: { type: 'update' }, diff: createPatch(full, 'before\n', 'after\n'), snapshot: { disk: 'after\n', text: 'after\n', mode: 0o644, canonical: full } }] });
      await api.receive({ method: 'turn/completed', threadId: 'state', turnId: turn });
    }
    const backups = async () => Promise.all((await fs.readdir(storage)).filter(n => n.startsWith('request-review.corrupt-')).map(n => fs.readFile(path.join(storage, n), 'utf8')));
    if (phase === 'state') {
      await inject('seed'); await fs.writeFile(cache, '{');
    } else if (phase === 'state-corrupt') {
      assert.equal(api.entries().length, 0, 'Broken JSON does not prevent startup');
      await api.setEnabled(false); assert.equal(api.isEnabled(), false);
      await api.setEnabled(true); assert.ok((await backups()).includes('{'));
      await inject('valid'); assert.equal(api.entries().length, 1, 'Delivery still works after broken JSON');
      const mixed = api.getState(); mixed.turns.push({ id: 'broken', files: [] });
      mixed.turns[0].files.push({ ...mixed.turns[0].files[0], path: path.join(root, '..', 'outside.txt') });
      await fs.writeFile(cache, JSON.stringify(mixed));
    } else if (phase === 'state-partial') {
      assert.equal(api.entries().length, 1); assert.equal(api.entries()[0].file.path, full);
      assert.ok((await backups()).some(s => s.includes('"id":"broken"')));
      const entry = api.entries()[0];
      await api.decide({ turn: entry.turn.key, path: full, revision: entry.revision, hunk: entry.hunks[0].id }, 'reject');
      assert.equal(await fs.readFile(full, 'utf8'), 'before\n');
      await inject('readonly'); await fs.chmod(storage, 0o500);
    } else if (phase === 'state-readonly') {
      assert.equal(api.entries().length, 1, 'Read-only persistence does not reject ready or discard the recovered queue');
      await api.setEnabled(false); assert.equal(api.isEnabled(), false);
      await fs.chmod(storage, 0o700); await api.refresh();
    } else if (phase === 'state-transient') {
      assert.ok(transientRead, 'The startup cache read must hit the injected EIO');
      assert.equal(api.entries().length, 0);
      const original = JSON.parse(await fs.readFile(cache, 'utf8')), count = (await backups()).length;
      assert.equal(original.turns.length, 1);
      await api.refresh(); assert.equal(api.entries().length, 1, 'Retry must restore the original pending request');
      assert.equal((await backups()).length, count, 'A transient failure is not corrupt data');
      assert.equal(api.getState().turns[0].key, original.turns[0].key);
    } else {
      assert.equal(api.isEnabled(), false); assert.equal(api.entries().length, 1);
      await api.setEnabled(true);
      const entry = api.entries()[0];
      await api.decide({ turn: entry.turn.key, path: full, revision: entry.revision, hunk: entry.hunks[0].id }, 'reject');
      assert.equal(await fs.readFile(full, 'utf8'), 'before\n');
    }
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true }));
  } catch (error) {
    fs.open = open;
    if (storage) await fs.chmod(storage, 0o700).catch(() => {});
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error;
  }
} };
