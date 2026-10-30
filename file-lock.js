'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { readRecord, InvalidRecord } = require('./hook-queue');
const namePattern = /^(\d+)-[a-f0-9-]{36}\.json$/;
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
// Each contender owns a unique ticket. Reaping a dead PID can never unlink
// another contender's new lock, and a slow live owner is never evicted by TTL.
async function withDirectoryLock(directory, work, { timeout = 5000 } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = await fs.lstat(directory, { bigint: true }), canonical = await fs.realpath(directory);
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('Review lock directory is unsafe.');
  async function check() {
    const stat = await fs.lstat(directory, { bigint: true });
    if (stat.isSymbolicLink() || identity.dev !== stat.dev || identity.ino !== stat.ino || await fs.realpath(directory) !== canonical) throw new Error('Review lock directory changed.');
  }
  const id = process.pid + '-' + randomUUID() + '.json', own = path.join(directory, id), started = performance.now();
  async function peers() {
    await check();
    const names = (await fs.readdir(directory)).filter(name => namePattern.test(name));
    if (names.length > 2048) throw new Error('Review lock is busy.');
    const result = [];
    for (const name of names) {
      if (name === id) continue;
      const pid = Number(name.match(namePattern)[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Review lock metadata is invalid.');
      if (!alive(pid)) { await fs.unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; }); continue; }
      try {
        const record = await readRecord(path.join(directory, name), 1024);
        result.push({ name, ticket: record.pid === pid && Number.isSafeInteger(record.ticket) && record.ticket > 0 ? record.ticket : 0 });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (!(error instanceof InvalidRecord) && error.code !== 'EAGAIN') throw error;
        result.push({ name, ticket: 0 });
      }
    }
    return result;
  }
  let published = false;
  try {
    await check();
    await fs.writeFile(own, JSON.stringify({ pid: process.pid, choosing: true }), { mode: 0o600, flag: 'wx' }); published = true;
    const ticket = Math.max(0, ...(await peers()).map(peer => peer.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('Review lock ticket limit.');
    // A partial rewrite remains a choosing/busy ticket to every peer.
    await fs.writeFile(own, JSON.stringify({ pid: process.pid, ticket }), { mode: 0o600 });
    while ((await peers()).some(peer => !peer.ticket || peer.ticket < ticket || peer.ticket === ticket && peer.name < id)) {
      if (performance.now() - started > timeout) throw new Error('Review storage is busy; retry the operation.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await check();
    return await work();
  } finally {
    if (published) await fs.unlink(own).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
const withCaptureLock = (store, work) => withDirectoryLock(path.join(store, 'capture-lock'), work);
module.exports = { withDirectoryLock, withCaptureLock };
