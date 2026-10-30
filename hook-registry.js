'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readRecord } = require('./hook-queue');
const { withDirectoryLock } = require('./file-lock');
const { configure, hookCommand, isConfigured } = require('./hook-config');
const { editHookConfig } = require('./hook-config-store');
const { atomic } = require('./hook-runner');
const { pidAlive, keyFor } = require('./hook-dispatch');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function optional(file, limit = 65536) { try { return await readRecord(file, limit); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Review registry directory is unsafe.');
}
function createRegistry(home) {
  const directory = path.join(home, 'review-hooks'), configFile = path.join(home, 'hooks.json'), setupFile = path.join(directory, 'setup.json'), script = path.join(directory, 'dispatch-v1.js');
  const file = (kind, root) => path.join(directory, kind, keyFor(root) + '.json');
  async function lock(work) {
    await privateDirectory(directory);
    return withDirectoryLock(path.join(directory, 'setup-lock'), async () => {
      for (const kind of ['registrations', 'leases']) await privateDirectory(path.join(directory, kind));
      return work();
    });
  }
  function validSetup(setup) {
    if (!setup || setup.version !== 1 || typeof setup.executable !== 'string' || !path.isAbsolute(setup.executable) || typeof setup.scriptHash !== 'string' || !/^[a-f0-9]{64}$/.test(setup.scriptHash) || setup.pendingScriptHash !== undefined && !/^[a-f0-9]{64}$/.test(setup.pendingScriptHash) || setup.command !== hookCommand(setup.executable, script, directory)) throw new Error('The shared hooks ownership record is invalid.');
    if (setup.pendingCommand !== undefined && (typeof setup.pendingExecutable !== 'string' || !path.isAbsolute(setup.pendingExecutable) || setup.pendingCommand !== hookCommand(setup.pendingExecutable, script, directory))) throw new Error('The shared hooks transition record is invalid.');
    return setup;
  }
  async function setup() { const value = await optional(setupFile); return value && validSetup(value); }
  async function ownScript(previous) {
    const original = await scriptSnapshot();
    if (original && (!previous || ![previous.scriptHash, previous.pendingScriptHash].includes(digest(original.bytes)))) throw new Error('The shared hook bootstrap was changed by another writer.');
    return original;
  }
  async function scriptSnapshot() {
    let handle;
    try {
      handle = await fs.open(script, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat({ bigint: true }); if (!stat.isFile() || stat.size > 65536n) throw new Error('The shared hook bootstrap is unsafe.');
      const bytes = Buffer.alloc(Number(stat.size) + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat({ bigint: true });
      if (BigInt(bytesRead) !== stat.size || stat.size !== after.size || stat.mtimeNs !== after.mtimeNs) throw new Error('The shared hook bootstrap changed.');
      return { bytes: bytes.subarray(0, bytesRead), dev: stat.dev, ino: stat.ino };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
  }
  async function replaceScript(expected, bytes) {
    const candidate = script + '.' + process.pid + '-' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(candidate, bytes, { mode: 0o600, flag: 'wx' });
      const current = await scriptSnapshot();
      if (Boolean(expected) !== Boolean(current) || current && (current.dev !== expected.dev || current.ino !== expected.ino || !current.bytes.equals(expected.bytes))) throw new Error('The shared hook bootstrap changed.');
      await fs.rename(candidate, script);
    } finally { await fs.unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function registration(root) { return optional(file('registrations', root)); }
  async function available(root, instance) {
    const lease = await optional(file('leases', root));
    if (lease && (!Number.isSafeInteger(lease.pid) || lease.pid <= 0)) throw new Error('The workspace lease is invalid.');
    if (lease && pidAlive(lease.pid) && lease.instance !== instance) throw new Error('Review is connected in another window for this workspace. Disconnect it there first.');
  }
  async function register({ root, store, instance, executable, token = randomUUID(), previous = [] }) {
    return lock(async () => withDirectoryLock(path.join(directory, 'lease-lock-' + keyFor(root)), async () => {
      await available(root, instance);
      const oldSetup = await setup(), oldRegistration = await registration(root), oldLease = await optional(file('leases', root));
      const oldScript = await ownScript(oldSetup);
      const source = await fs.readFile(path.join(__dirname, 'hook-dispatch.js')), command = hookCommand(executable, script, directory);
      const next = { version: 1, executable, command, scriptHash: digest(source) }, record = { version: 1, root, store, token };
      let primary = oldSetup || next;
      if (oldSetup?.pendingCommand) {
        const config = await optional(configFile, 5 * 1024 * 1024);
        if (isConfigured(config, oldSetup.pendingCommand)) primary = { ...oldSetup, command: oldSetup.pendingCommand, executable: oldSetup.pendingExecutable };
      }
      let scriptChanged = false;
      try {
        // Publish the two known package hashes before replacement. Either side
        // remains owned after a process crash; arbitrary foreign bytes do not.
        await atomic(setupFile, { ...primary, pendingScriptHash: next.scriptHash, pendingCommand: next.command, pendingExecutable: next.executable });
        await replaceScript(oldScript, source); scriptChanged = true;
        await atomic(file('registrations', root), record);
        // Reserve this root before Connect returns to start its local watcher.
        // A second window must not steal the gap before the first heartbeat.
        const reservation = oldLease?.instance === instance && oldLease.token === token ? oldLease : { ...record, pid: process.pid, instance, updated: Date.now(), connecting: true };
        await atomic(file('leases', root), reservation);
        await editHookConfig(configFile, store, input => configure(input, command, [...previous, oldSetup?.command, oldSetup?.pendingCommand]));
        // The staged ownership record accepts either command while hooks.json
        // switches. If finalization fails, it remains valid and retryable.
        await atomic(setupFile, next).catch(() => {});
        return { ...record, command };
      } catch (error) {
        if (oldRegistration) await atomic(file('registrations', root), oldRegistration); else await fs.unlink(file('registrations', root)).catch(() => {});
        if (oldLease) await atomic(file('leases', root), oldLease); else await fs.unlink(file('leases', root)).catch(() => {});
        if (oldSetup) await atomic(setupFile, oldSetup).catch(() => {}); else await fs.unlink(setupFile).catch(() => {});
        if (scriptChanged) {
          const current = await scriptSnapshot().catch(() => undefined);
          if (current && digest(current.bytes) === next.scriptHash) {
            if (oldScript) await replaceScript(current, oldScript.bytes).catch(() => {}); else await fs.unlink(script).catch(() => {});
          }
        }
        throw error;
      }
    }));
  }
  async function heartbeat(record, connection) {
    // Per-root ticket lock also serializes with explicit Disconnect. It never
    // edits global configuration and does not acquire the global setup lock.
    return withDirectoryLock(path.join(directory, 'lease-lock-' + keyFor(record.root)), async () => {
      const owned = await registration(record.root);
      if (!owned || owned.token !== record.token || owned.store !== record.store) return false;
      const existing = await optional(file('leases', record.root));
      if (existing && pidAlive(existing.pid) && existing.instance !== connection.instance) throw new Error('Review is connected in another window for this workspace. Disconnect it there first.');
      await atomic(file('leases', record.root), { ...record, command: undefined, pid: connection.pid, instance: connection.instance, updated: connection.updated, extensionPath: connection.extensionPath }); return true;
    });
  }
  async function release(record, instance) {
    return withDirectoryLock(path.join(directory, 'lease-lock-' + keyFor(record.root)), async () => {
      const lease = await optional(file('leases', record.root));
      if (lease?.instance === instance && lease.token === record.token) await fs.unlink(file('leases', record.root));
    });
  }
  async function unregister(record, instance) {
    return lock(async () => withDirectoryLock(path.join(directory, 'lease-lock-' + keyFor(record.root)), async () => {
      await available(record.root, instance);
      const owned = await registration(record.root);
      if (!owned || owned.token !== record.token || owned.store !== record.store) throw new Error('This workspace registration is owned by another profile.');
      const names = (await fs.readdir(path.join(directory, 'registrations'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      const current = await setup(); if (!current) throw new Error('The shared hooks ownership record is missing.');
      if (names.length === 1) await editHookConfig(configFile, record.store, input => configure(input, current.command, [current.pendingCommand], true));
      await fs.unlink(file('registrations', record.root));
      const lease = await optional(file('leases', record.root));
      if (lease?.instance === instance && lease.token === record.token) await fs.unlink(file('leases', record.root));
    }));
  }
  async function health() {
    return lock(async () => {
      const current = await setup(); if (!current) return { configured: false };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const input = await readRecord(configFile, 5 * 1024 * 1024), command = [current.command, current.pendingCommand].filter(Boolean).find(value => isConfigured(input, value));
          return { configured: Boolean(command), command: command || current.command };
        } catch (error) { if (error.code !== 'EAGAIN') return { configured: false, command: current.command }; }
      }
      return { configured: false, command: current.command };
    });
  }
  return { directory, setup, registration, register, unregister, heartbeat, release, available, health };
}
module.exports = { createRegistry };
