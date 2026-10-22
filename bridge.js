'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
let connection, provider, subscription, modeSubscription, delivery = Promise.resolve(), count = 0, errorShown = false;
const activeTurns = new Set(), ignoredTurns = new Set();
const pending = new Map();
const MAX = 1024 * 1024;

function capture(full) {
  if (!path.isAbsolute(full)) return { error: 'Relative paths are not supported.' };
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isFile()) return { error: 'Only regular files are supported.' };
    if (stat.size > MAX) return { error: 'File exceeds 1 MiB.' };
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0) || !Buffer.from(buffer.toString('utf8')).equals(buffer)) return { error: 'Only UTF-8 text is supported.' };
    const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === full);
    const bom = buffer.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
    return { disk: buffer.toString('utf8'), text: doc?.isDirty ? (bom ? '\uFEFF' : '') + doc.getText() : buffer.toString('utf8'), mode: stat.mode & 0o777, dirty: Boolean(doc?.isDirty), canonical: fs.realpathSync(full) };
  } catch (e) { return e.code === 'ENOENT' ? { disk: null, text: null, mode: 0o644, dirty: false } : { error: 'Could not read the file: ' + e.code }; }
}

function select(event) {
  const p = event.params || {}, item = p.item;
  const common = { method: event.method, threadId: p.threadId || p.thread?.id, turnId: p.turnId || p.turn?.id };
  if (event.method === 'thread/started') return { ...common, cwd: p.thread?.cwd };
  if (event.method === 'turn/started' || event.method === 'turn/completed') return { ...common, status: p.turn?.status };
  if (!['item/started', 'item/completed'].includes(event.method)) return;
  if (item?.type === 'commandExecution') return { ...common, itemId: item.id, type: item.type, status: item.status, readOnly: Boolean(item.commandActions?.length && item.commandActions.every(a => ['read', 'search', 'listFiles'].includes(a.type))) };
  if (['mcpToolCall', 'dynamicToolCall', 'collabToolCall'].includes(item?.type)) return { ...common, itemId: item.id, type: 'externalTool', status: item.status };
  if (item?.type !== 'fileChange') return;
  return { ...common, itemId: item.id, type: item.type, status: item.status,
    changes: (item.changes || []).map(c => {
      const destination = c.kind?.move_path || c.kind?.movePath;
      return { path: c.path, kind: c.kind, diff: c.diff, snapshot: capture(c.path), ...(destination ? { destinationSnapshot: capture(destination) } : {}) };
    }) };
}

function attach(client) {
  if (connection === client) return { dispose() {} };
  connection = client;
  modeSubscription = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('changeReview.enabled') && !vscode.workspace.getConfiguration('changeReview').get('enabled', true)) for (const key of activeTurns) ignoredTurns.add(key);
  });
  subscription = client.registerInternalNotificationHandler(event => {
    if (!vscode.extensions.getExtension('local-tools.change-review')) return;
    const p = event.params || {}, threadId = p.threadId, turnId = p.turnId || p.turn?.id;
    const key = threadId && turnId ? threadId + '/' + turnId : undefined;
    if (key && event.method !== 'turn/completed') activeTurns.add(key);
    const enabled = vscode.workspace.getConfiguration('changeReview').get('enabled', true);
    if (!enabled && key) ignoredTurns.add(key);
    const skip = !enabled || ignoredTurns.has(key);
    if (event.method === 'turn/completed' && key) { activeTurns.delete(key); ignoredTurns.delete(key); }
    if (skip && event.method !== 'turn/completed') return;
    let payload;
    try { payload = select(event); } catch { return; }
    if (!payload) return;
    if (skip) payload.skipReview = true;
    delivery = delivery.then(async () => {
      const extension = vscode.extensions.getExtension('local-tools.change-review');
      if (!extension) return;
      const api = await extension.activate();
      await api.receive(payload);
    }).catch(() => {
      vscode.commands.executeCommand('setContext', 'changeReview.bridgeError', true);
      if (!errorShown) { errorShown = true; vscode.window.showWarningMessage('Could not process review events. New changes may be missing from the queue; check the integration status.'); }
    });
  });
  provider = client.registerProvider('change-review', { onResult(message) {
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id); clearTimeout(job.timer);
    if (message.error) job.reject(new Error(message.error.message || 'Request failed'));
    else job.resolve(message.result);
  } });
  return { dispose() { subscription?.dispose(); modeSubscription?.dispose(); provider?.dispose(); activeTurns.clear(); ignoredTurns.clear(); connection = undefined; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); } pending.clear(); } };
}

function request(method, params = {}) {
  if (!connection) return Promise.reject(new Error('Bridge is not attached'));
  const id = 'review-' + (++count);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Request timed out: ' + method)); }, 60000);
    pending.set(id, { resolve, reject, timer });
    connection.sendRequest('change-review', id, method, params);
  });
}

module.exports = { attach, request, drain: () => delivery, select, isAttached: () => Boolean(connection) };
