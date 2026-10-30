'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
module.exports = { run: async () => {
  try {
    const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready; await api.hooks.ready;
    assert.equal(api.hooks.status().connected, false);
    const directory = path.join(api.hooks.store, 'events'); await fs.mkdir(directory, { recursive: true });
    const event = path.join(directory, '0000000000000001-pending.json');
    await fs.writeFile(event, JSON.stringify({ version: 1, records: [{ method: 'turn/started', threadId: 'connection', turnId: 'pending' }] }));
    let timer;
    try { await Promise.race([vscode.commands.executeCommand('changeReview.connect'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Registered Connect deadlocked with pending events')), 5000); })]); }
    finally { clearTimeout(timer); }
    assert.equal(api.hooks.status().connected, true);
    await api.hooks.drain();
    assert.ok(api.getState().turns.some(t => t.key === 'connection/pending'));
    assert.equal(await fs.stat(event).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }), false);
    await api.setEnabled(false); await api.setEnabled(true);
    await vscode.commands.executeCommand('changeReview.disconnect'); assert.equal(api.hooks.status().connected, false);
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: true }));
  } catch (error) { await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error; }
} };
