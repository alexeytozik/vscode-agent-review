'use strict';
// This file is copied as a standalone bootstrap. Keep it independent of packages
// and of this extension's installation directory.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const keyFor = root => createHash('sha256').update(root).digest('hex');
const absolute = value => typeof value === 'string' && value.length <= 32768 && path.isAbsolute(value) && !value.includes('\0') && path.normalize(value) === value;
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function live(record, now = Date.now()) {
  return Boolean(record && record.version === 1 && Number.isSafeInteger(record.updated) && Math.abs(now - record.updated) <= 30000 && pidAlive(record.pid));
}
async function read(file, limit = 65536) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid dispatch record.');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(limit)) throw new Error('Invalid dispatch record.');
    const bytes = Buffer.alloc(Number(stat.size) + 1); let length = 0;
    while (length < bytes.length) { const part = await handle.read(bytes, length, bytes.length - length, length); if (!part.bytesRead) break; length += part.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (BigInt(length) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) throw new Error('Dispatch record changed.');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}
async function safeDirectory(directory) {
  const stat = await fs.lstat(directory); return stat.isDirectory() && !stat.isSymbolicLink();
}
async function select(registry, cwd, now = Date.now()) {
  if (!absolute(registry) || !absolute(cwd) || !await safeDirectory(registry)) return;
  const leases = path.join(registry, 'leases');
  if (!await safeDirectory(leases).catch(() => false) || !await safeDirectory(path.join(registry, 'registrations')).catch(() => false)) return;
  const names = await fs.readdir(leases); if (names.length > 2048) throw new Error('Dispatch registry limit.');
  const canonical = await fs.realpath(cwd), candidates = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const lease = await read(path.join(leases, name));
      if (!live(lease, now) || ![lease.root, lease.store, lease.extensionPath].every(absolute) || keyFor(lease.root) + '.json' !== name || typeof lease.instance !== 'string' || typeof lease.token !== 'string') continue;
      const relative = path.relative(lease.root, canonical);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      const registration = await read(path.join(registry, 'registrations', name));
      if (registration.version !== 1 || registration.root !== lease.root || registration.store !== lease.store || registration.token !== lease.token) continue;
      // Match hook-runner's bounded reader for the maximum valid exclusion list.
      const connection = await read(path.join(lease.store, 'connection.json'), 2 * 1024 * 1024);
      if (!live({ ...connection, version: 1 }, now) || connection.root !== lease.root || connection.pid !== lease.pid || connection.instance !== lease.instance || connection.extensionPath !== lease.extensionPath) continue;
      if (await fs.realpath(lease.root) !== lease.root || !await safeDirectory(lease.store) || !await safeDirectory(lease.extensionPath)) continue;
      const runner = await fs.lstat(path.join(lease.extensionPath, 'hook-runner.js'));
      if (!runner.isFile() || runner.isSymbolicLink()) continue;
      candidates.push(lease);
    } catch { /* A damaged neighbouring registration cannot stop this workspace. */ }
  }
  return candidates.sort((a, b) => b.root.length - a.root.length)[0];
}
async function run(registry, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  let input = '';
  try {
    for await (const chunk of stdin) { input += chunk; if (Buffer.byteLength(input) > 20 * 1024 * 1024) throw new Error('Dispatch input limit.'); }
    const event = JSON.parse(input), lease = await select(registry, event.cwd);
    if (!lease) { stdout.write('{}'); return true; }
    return require(path.join(lease.extensionPath, 'hook-runner.js')).run(lease.store, { stdin: Readable.from([input]), stdout, stderr });
  } catch {
    stderr.write('Agent Review could not route this operation; review its changes manually.\n');
    stdout.write(JSON.stringify({ systemMessage: 'Agent Review could not route this operation; review its changes manually.' })); return false;
  }
}
module.exports = { run, select, live, pidAlive, keyFor };
if (require.main === module) run(process.argv[2]);
