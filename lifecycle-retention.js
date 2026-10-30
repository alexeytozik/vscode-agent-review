'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const categories = ['pending', 'events', 'feedback', 'quarantine', 'backups', 'temporary'];
const temporary = /\.(?:(\d+)-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function createDataWalker(store) {
  let anchor;
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  async function open(directory, canonical) {
    const stat = await fs.lstat(directory, { bigint: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
    if (await fs.realpath(directory) !== canonical) throw new Error('Cleanup directory changed.');
    const handle = await fs.opendir(directory);
    try {
      const after = await fs.lstat(directory, { bigint: true });
      if (!same(stat, after) || after.isSymbolicLink() || await fs.realpath(directory) !== canonical) throw new Error('Cleanup directory changed.');
    } catch (error) { await handle.close(); throw error; }
    return { handle, identity: { path: directory, dev: String(stat.dev), ino: String(stat.ino) } };
  }
  function record(file, category, stat, directory, pid) {
    return { file, category, bytes: stat.isFile() ? Number(stat.size) : 0, regular: stat.isFile() && !stat.isSymbolicLink(), pid,
      dev: String(stat.dev), ino: String(stat.ino), directory };
  }
  async function* visit(directory, canonical, category, depth = 0) {
    const opened = await open(directory, canonical); if (!opened) return;
    for await (const entry of opened.handle) {
      const full = path.join(directory, entry.name), info = await fs.lstat(full, { bigint: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!info) { yield null; continue; }
      let kind = category;
      if (!kind) {
        kind = ['pending', 'events', 'feedback'].includes(entry.name) ? entry.name : ['event-quarantine', 'feedback-quarantine', 'pending-quarantine'].includes(entry.name) ? 'quarantine' : undefined;
        if (!kind && /^hooks-backup-\d+(?:-[a-f0-9-]+)?\.json$/.test(entry.name)) kind = 'backups';
      }
      const temp = entry.name.match(temporary);
      if (temp) kind = 'temporary';
      if (info.isDirectory() && !info.isSymbolicLink()) {
        yield null;
        if (kind && depth < 3) yield* visit(full, path.join(canonical, entry.name), kind, depth + 1);
      } else yield kind ? record(full, kind, info, opened.identity, temp?.[1] ? Number(temp[1]) : undefined) : null;
    }
  }
  async function* walk() {
    const storage = path.dirname(store), parent = await fs.lstat(storage, { bigint: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!parent?.isDirectory() || parent.isSymbolicLink()) return;
    anchor = await fs.realpath(storage);
    if (!same(parent, await fs.lstat(storage, { bigint: true }))) throw new Error('Cleanup directory changed.');
    yield* visit(store, path.join(anchor, path.basename(store)));
    const opened = await open(storage, anchor); if (!opened) return;
    for await (const entry of opened.handle) {
      const backup = /^request-review\.corrupt-[a-f0-9-]+\.json$/.test(entry.name), temp = entry.name.startsWith('request-review.json.') && entry.name.match(temporary);
      if (!backup && !temp) { yield null; continue; }
      const file = path.join(storage, entry.name), stat = await fs.lstat(file, { bigint: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
      yield stat && !stat.isDirectory() ? record(file, backup ? 'backups' : 'temporary', stat, opened.identity, temp?.[1] ? Number(temp[1]) : undefined) : null;
    }
  }
  return walk();
}
async function removeRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = JSON.stringify(record.directory);
    if (!groups.has(key)) groups.set(key, { ...record.directory, files: [] });
    groups.get(key).files.push({ name: path.basename(record.file), dev: record.dev, ino: record.ino, pid: record.category === 'temporary' ? record.pid : undefined });
  }
  const total = { removed: 0, failed: 0, skippedActive: 0 };
  for (const group of groups.values()) {
    const result = await new Promise(resolve => {
      const child = childProcess.spawn(process.execPath, [path.join(__dirname, 'cleanup-worker.js')], { cwd: group.path, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '', failed = false;
      child.on('error', () => { failed = true; });
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024) { failed = true; child.kill(); } });
      child.stdin.on('error', () => { failed = true; });
      const timer = setTimeout(() => { failed = true; child.kill(); }, 10000); timer.unref();
      child.on('close', code => {
        clearTimeout(timer);
        try {
          const value = JSON.parse(output);
          if (failed || code !== 0 || !['removed', 'failed', 'skippedActive'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) || value.removed + value.failed + value.skippedActive > group.files.length) throw new Error();
          resolve(value);
        } catch { resolve({ removed: 0, failed: group.files.length, skippedActive: 0 }); }
      });
      child.stdin.end(JSON.stringify(group));
    });
    for (const key of Object.keys(total)) total[key] += result[key];
  }
  return total;
}
async function inventory(store, maxEntries = 2048, walker) {
  const cursor = walker || createDataWalker(store), entries = []; let scanned = 0, done = false;
  try {
    while (scanned < maxEntries) {
      const next = await cursor.next(); if (next.done) { done = true; break; }
      scanned++; if (next.value) entries.push(next.value);
    }
  } finally { if (!walker) await cursor.return(); }
  return { entries, scanned, truncated: !done };
}
async function inspectData(store, options = {}) {
  const records = await inventory(store, options.maxEntries);
  const counts = Object.fromEntries(categories.map(category => [category, { files: 0, bytes: 0 }]));
  for (const record of records.entries) { counts[record.category].files++; counts[record.category].bytes += record.bytes; }
  return { categories: counts, scanned: records.scanned, truncated: records.truncated };
}
async function cleanOrphanTemps(store, { maxEntries = 256, maxRemove = 32, isAlive = alive, walker } = {}) {
  const records = await inventory(store, maxEntries, walker), selected = [];
  for (const record of records.entries) {
    if (selected.length >= maxRemove) break;
    if (record.category !== 'temporary' || !record.regular || !Number.isSafeInteger(record.pid) || record.pid <= 0 || isAlive(record.pid)) continue;
    selected.push(record);
  }
  const { removed, failed } = await removeRecords(selected);
  return { removed, failed, scanned: records.scanned, truncated: records.truncated };
}
async function clearData(store, selected, { connected = true, maxEntries = 2048, isAlive = alive, walker } = {}) {
  if (!Array.isArray(selected) || !selected.length || selected.some(category => !categories.includes(category))) throw new Error('Invalid cleanup scope. Saved review queues and project files cannot be selected.');
  if (connected && selected.some(category => category !== 'temporary')) throw new Error('Disconnect review before clearing retained transport data. Pending tools may lose capture when their snapshots are removed.');
  const records = await inventory(store, maxEntries, walker), selectedRecords = []; let skippedActive = 0;
  for (const record of records.entries) {
    if (!selected.includes(record.category)) continue;
    if (record.category === 'temporary' && record.pid && isAlive(record.pid)) { skippedActive++; continue; }
    selectedRecords.push(record);
  }
  const result = await removeRecords(selectedRecords);
  return { ...result, skippedActive: result.skippedActive + skippedActive, scanned: records.scanned, truncated: records.truncated };
}
module.exports = { cleanOrphanTemps, inspectData, clearData, createDataWalker };
