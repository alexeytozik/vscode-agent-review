'use strict';
const { allowedFull } = require('./files');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readRecord, InvalidRecord } = require('./hook-queue');
function permittedChange(root, change, policy, aliases) {
  return Boolean(change && allowedFull(root, change.path, policy, aliases)) && [change.kind?.move_path, change.kind?.movePath, change.snapshot?.canonical, change.destinationSnapshot?.canonical].filter(full => full !== undefined).every(full => allowedFull(root, full, policy, aliases));
}
function filterEvent(event, root, policy, aliases = []) {
  if (!Array.isArray(event.changes)) return event;
  const changes = event.changes.filter(change => permittedChange(root, change, policy, aliases));
  if (changes.length === event.changes.length) return event;
  if (changes.length) return { ...event, changes, skipReason: 'excluded' };
  return { method: 'item/completed', type: 'externalTool', threadId: event.threadId, turnId: event.turnId, itemId: event.itemId, ...(event.skipReview ? { skipReview: true } : {}), skipReason: 'excluded' };
}
async function scrubPolicyStore(store, root, policy, write) {
  let removed = 0;
  async function names(directory) {
    const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return [];
    return fs.readdir(directory);
  }
  async function read(file, limit) { try { return await readRecord(file, limit); } catch (error) { if (error.code === 'ENOENT' || error instanceof InvalidRecord) return; throw error; } }
  for (const name of (await names(path.join(store, 'pending'))).filter(name => /^[\w-]+\.json$/.test(name))) {
    const file = path.join(store, 'pending', name), record = await read(file, 25 * 1024 * 1024);
    if (Array.isArray(record?.files) && record.files.some(change => !permittedChange(root, change, policy))) {
      await write(file, { unsupported: true, turn: record.turn, reason: 'excluded', ...(record.created ? { created: record.created } : {}) }); removed++;
    }
  }
  for (const name of (await names(path.join(store, 'events'))).filter(name => /^[\w-]+\.json$/.test(name))) {
    const file = path.join(store, 'events', name), record = await read(file, 25 * 1024 * 1024);
    if (!Array.isArray(record?.records) || record.records.some(event => !event || typeof event !== 'object')) continue;
    const records = record.records.map(event => filterEvent(event, root, policy));
    if (records.some((event, index) => event !== record.records[index])) { await write(file, { ...record, records }); removed++; }
  }
  for (const session of (await names(path.join(store, 'feedback'))).filter(name => /^[a-f0-9]{64}$/.test(name))) {
    const directory = path.join(store, 'feedback', session);
    for (const name of (await names(directory)).filter(name => /^[\w-]+\.json$/.test(name))) {
      const file = path.join(directory, name), record = await read(file, 16 * 1024);
      if (typeof record?.path === 'string' && !allowedFull(root, record.path, policy)) { await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); removed++; }
    }
  }
  return removed;
}
module.exports = { permittedChange, filterEvent, scrubPolicyStore };
