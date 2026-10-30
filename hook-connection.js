'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { atomic, hash } = require('./hook-runner');
const { configure, hookCommand, commandArgs, isConfigured } = require('./hook-config');
const { editHookConfig } = require('./hook-config-store');
const { createPathPolicy, allowedFull } = require('./files');
const { filterEvent, scrubPolicyStore } = require('./capture-policy');
const { cleanOrphanTemps, inspectData, clearData, createDataWalker } = require('./lifecycle-retention');
const { InvalidRecord, readRecord, quarantine } = require('./hook-queue');
const { withCaptureLock } = require('./file-lock');
const { createRegistry } = require('./hook-registry');

function validatePayload(payload, root) {
  const string = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');
  const text = value => value === null || typeof value === 'string' && Buffer.byteLength(value) <= 1024 * 1024 && Buffer.from(value).toString('utf8') === value;
  function inside(full) {
    if (!string(full, 32768) || !path.isAbsolute(full) || path.normalize(full) !== full) return false;
    const relative = path.relative(root, full);
    return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  if (!payload || payload.version !== 1 || !Array.isArray(payload.records) || !payload.records.length || payload.records.length > 2 || payload.created !== undefined && (!Number.isSafeInteger(payload.created) || payload.created < 0)) throw new InvalidRecord('Invalid lifecycle envelope.');
  for (const event of payload.records) {
    if (!event || !['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(event.method) ||
        ![event.threadId, event.turnId].every(id => string(id, 512)) ||
        (event.skipReview !== undefined && typeof event.skipReview !== 'boolean') || (event.readOnly !== undefined && typeof event.readOnly !== 'boolean') || (event.skipReason !== undefined && event.skipReason !== 'excluded')) throw new InvalidRecord('Invalid lifecycle event.');
    if (event.method.startsWith('item/') && (!['fileChange', 'externalTool', 'commandExecution'].includes(event.type) || !string(event.itemId, 512))) throw new InvalidRecord('Invalid lifecycle item.');
    if (event.type === 'fileChange' && event.method === 'item/completed' && !string(event.status, 128)) throw new InvalidRecord('Invalid lifecycle status.');
    if (event.changes !== undefined && !Array.isArray(event.changes)) throw new InvalidRecord('Invalid lifecycle changes.');
    if (event.type === 'fileChange' && !Array.isArray(event.changes)) throw new InvalidRecord('Missing lifecycle changes.');
    for (const change of event.changes || []) {
      if (!change || !inside(change.path) || [change.kind?.move_path, change.kind?.movePath].some(full => full !== undefined && !inside(full))) throw new InvalidRecord('Invalid lifecycle path or path outside this workspace.');
      if (change.diff !== undefined && typeof change.diff !== 'string') throw new InvalidRecord('Invalid lifecycle diff.');
      if (event.method === 'item/completed' && (!change.kind || !['add', 'delete', 'update'].includes(change.kind.type))) throw new InvalidRecord('Invalid lifecycle change kind.');
      const snapshot = change.snapshot;
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
          !(string(snapshot.error, 4096) || [snapshot.disk, snapshot.text].every(text)) ||
          (snapshot.error !== undefined && !string(snapshot.error, 4096)) ||
          (snapshot.mode !== undefined && (!Number.isInteger(snapshot.mode) || snapshot.mode < 0 || snapshot.mode > 0o777)) ||
          (snapshot.canonical !== undefined && !inside(snapshot.canonical))) throw new InvalidRecord('Invalid lifecycle snapshot.');
    }
  }
}

function createConnection({ storage, extensionPath, executable, root, receive, enabled, report, exclude = () => [], changed = () => {}, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') }) {
  const store = path.join(storage, 'lifecycle'), configFile = path.join(home, 'hooks.json'), instance = randomUUID();
  const registry = createRegistry(home);
  let shared;
  let active = false, configured = false, timer, watcher, disposed = false, disposal, chain = Promise.resolve(), writes = Promise.resolve(), setupChanges = Promise.resolve(), lastEvent;
  const editSetup = work => { const job = setupChanges.then(work); setupChanges = job.catch(() => {}); return job; };
  const metadata = path.join(store, 'setup.json');
  const health = path.join(store, 'event-health.json');
  let incomplete = false;
  let scrubbedPolicy, captureBlocked = false;
  let maintenanceWalker, maintenanceJob, lastMaintenance = 0;
  const cleanupWalkers = new Map();
  function maintain(force = false) {
    if (disposed) return Promise.resolve();
    if (maintenanceJob) return maintenanceJob;
    const now = Date.now();
    if (!force && now >= lastMaintenance && now - lastMaintenance < 5 * 60 * 1000) return Promise.resolve();
    lastMaintenance = now;
    maintenanceJob = (async () => {
      maintenanceWalker ||= createDataWalker(store);
      const result = await cleanOrphanTemps(store, { walker: maintenanceWalker });
      if (!result.truncated) { await maintenanceWalker.return(); maintenanceWalker = undefined; }
      if (result.failed) reportOnce('cleanup', new Error('Some abandoned temporary review data could not be cleaned.'));
      else failures.delete('cleanup');
    })().catch(async () => {
      await maintenanceWalker?.return().catch(() => {}); maintenanceWalker = undefined;
      if (!disposed) reportOnce('cleanup', new Error('Some abandoned temporary review data could not be cleaned.'));
    }).finally(() => { maintenanceJob = undefined; });
    return maintenanceJob;
  }
  async function cleanup(categories) {
    if (!Array.isArray(categories) || categories.length !== 1) throw new Error('Select one cleanup scope.');
    const key = categories[0]; let walker = cleanupWalkers.get(key);
    if (!walker) { walker = createDataWalker(store); cleanupWalkers.set(key, walker); }
    try {
      const result = await clearData(store, categories, { connected: active, walker });
      if (!result.truncated) { await walker.return(); cleanupWalkers.delete(key); }
      return result;
    } catch (error) { await walker.return().catch(() => {}); cleanupWalkers.delete(key); throw error; }
  }
  const failures = new Map();
  function reportOnce(name, error) {
    const message = error.code || error.message;
    if (failures.get(name) === message) return;
    if (failures.size >= 128) failures.delete(failures.keys().next().value);
    failures.set(name, message); report(error);
  }
  const bootstrap = path.join(store, 'launch.js');
  let command = hookCommand(executable, bootstrap, store);
  const bootstrapText = "'use strict';\nconst fs=require('node:fs'),path=require('node:path');\nconst store=process.argv[2];\nconst runtime=JSON.parse(fs.readFileSync(path.join(store,'runtime.json'),'utf8'));\nrequire(path.join(runtime.extensionPath,'hook-runner.js')).run(store);\n";
  function sharedSetup(setup) {
    if (setup.version !== 2 || setup.registry !== registry.directory || setup.root !== root || setup.store !== store || typeof setup.token !== 'string' || !/^[a-f0-9-]{36}$/.test(setup.token)) throw new Error('The saved shared hooks ownership record is invalid.');
    return { version: 1, root, store, token: setup.token };
  }
  async function legacyCommands(setup) {
    if (!setup) return [];
    const values = setup.version === 2 ? setup.previous || [] : [setup.command];
    if (setup.configFile !== configFile || !Array.isArray(values) || values.length > 1) throw new Error('The saved hooks ownership record is invalid.');
    for (const value of values) {
      const args = commandArgs(value);
      if (!args || !path.isAbsolute(args[0]) || args[1] !== bootstrap || args[2] !== store || await fs.readFile(bootstrap, 'utf8') !== bootstrapText) throw new Error('The legacy hook command cannot be verified.');
    }
    return values;
  }
  async function scrubCurrentPolicy() {
    const patterns = exclude(), key = JSON.stringify(patterns), policy = createPathPolicy(patterns);
    if (scrubbedPolicy !== key) await withCaptureLock(store, async () => {
      await scrubPolicyStore(store, root, policy, atomic); scrubbedPolicy = key;
    });
  }
  async function update() {
    if (disposed) return;
    if (!active) {
      try { await scrubCurrentPolicy(); captureBlocked = false; }
      catch (error) { captureBlocked = true; changed(); throw error; }
      return;
    }
    writes = writes.catch(() => {}).then(() => withCaptureLock(store, async () => {
      if (!active || disposed) return;
      const previous = configured;
      const wasBlocked = captureBlocked;
      if (shared) {
        const setup = await registry.setup(), owned = await registry.registration(root);
        if (!setup || owned?.token !== shared.token || owned.store !== store) { configured = false; lastEvent = undefined; changed(); throw new Error('This workspace registration is missing or owned by another profile. Reconnect review.'); }
        const current = await registry.health(); configured = current.configured; command = current.command || setup.command;
      } else {
        try { configured = isConfigured(await readRecord(configFile, 5 * 1024 * 1024), command); } catch { configured = false; }
      }
      if (!configured) lastEvent = undefined;
      if (!active || disposed) return;
      let patterns = exclude(), policy;
      try { policy = createPathPolicy(patterns); captureBlocked = false; } catch { patterns = []; captureBlocked = true; }
      const connection = { root, enabled: enabled() && configured && !captureBlocked, pid: process.pid, instance, updated: Date.now(), extensionPath, exclude: patterns };
      const policyKey = JSON.stringify(patterns);
      if (policy && scrubbedPolicy !== policyKey) {
        await atomic(path.join(store, 'connection.json'), { ...connection, enabled: false });
        try { await scrubPolicyStore(store, root, policy, atomic); scrubbedPolicy = policyKey; }
        catch (error) { captureBlocked = true; changed(); throw error; }
      }
      await atomic(path.join(store, 'connection.json'), connection);
      if (shared) {
        if (configured) {
          if (!await registry.heartbeat(shared, connection)) { configured = false; lastEvent = undefined; changed(); throw new Error('This workspace registration is owned by another profile. Reconnect review.'); }
        } else await registry.release(shared, instance);
      }
      if (previous !== configured || wasBlocked !== captureBlocked) changed();
    }));
    await writes;
  }
  function drain() {
    chain = chain.then(async () => {
      if (!incomplete && await fs.stat(health).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) { incomplete = true; changed(); }
      const directory = path.join(store, 'events');
      const files = (await fs.readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).filter(f => /^\d+-[\w-]+\.json$/.test(f)).sort();
      for (const name of files) {
        const file = path.join(directory, name);
        let payload;
        try {
          payload = await readRecord(file, 25 * 1024 * 1024);
          validatePayload(payload, root);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          if (error instanceof InvalidRecord) {
            incomplete = true; changed();
            try {
              await atomic(health, { incomplete: true });
              await quarantine(path.join(store, 'event-quarantine'), file, error.message);
              reportOnce(name, new Error('Review coverage is incomplete: a lifecycle event was quarantined. ' + error.message));
            } catch (failure) { reportOnce(name, new Error('Review coverage is incomplete: an invalid lifecycle event could not be quarantined. ' + (failure.code || 'Storage failure.'))); }
            continue;
          }
          // A read failure is not evidence of corruption. Preserve ordering for retry.
          reportOnce(name, error); break;
        }
        try {
          const records = await withCaptureLock(store, async () => {
            // Scrub may have changed this file since the first validation. Read
            // and filter its current bytes under the same policy commit lock.
            payload = await readRecord(file, 25 * 1024 * 1024); validatePayload(payload, root);
            const policy = createPathPolicy(exclude()), filtered = payload.records.map(event => filterEvent(event, root, policy));
            if (filtered.some((event, index) => event !== payload.records[index])) await atomic(file, { ...payload, records: filtered });
            return filtered;
          });
          for (const event of records) await receive(event);
          await fs.unlink(file);
          failures.delete(name);
          lastEvent = configured ? Date.now() : undefined; changed();
        } catch (error) {
          // receive may have partially applied a batch; its item IDs remain the dedupe key.
          reportOnce(name, error); break;
        }
      }
    }).catch(error => reportOnce('drain', error));
    return chain;
  }
  async function start() {
    if (active || disposed) return;
    await fs.mkdir(path.join(store, 'events'), { recursive: true, mode: 0o700 });
    const lock = path.join(store, 'owner.lock');
    try { await fs.writeFile(lock, JSON.stringify({ pid: process.pid, instance }), { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
      let alive = true; try { process.kill(owner.pid, 0); } catch { alive = false; }
      if (alive) throw new Error('Review is connected in another window for this workspace. Disconnect it there first.');
      await fs.unlink(lock); await fs.writeFile(lock, JSON.stringify({ pid: process.pid, instance }), { mode: 0o600, flag: 'wx' });
    }
    await atomic(path.join(store, 'runtime.json'), { extensionPath });
    if (disposed) return;
    active = true;
    try { await update(); }
    catch (error) { active = false; await fs.unlink(lock).catch(() => {}); throw error; }
    if (disposed) return;
    watcher = require('node:fs').watch(path.join(store, 'events'), () => drain());
    watcher.on('error', report);
    timer = setInterval(() => { update().then(drain).then(() => maintain()).catch(report); }, 5000); timer.unref();
    await drain();
  }
  async function available() {
    let owner; try { owner = JSON.parse(await fs.readFile(path.join(store, 'owner.lock'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (owner.instance === instance) return;
    let alive = true; try { process.kill(owner.pid, 0); } catch { alive = false; }
    if (alive) throw new Error('Review is connected in another window for this workspace. Disconnect it there first.');
  }
  async function connect() {
    if (disposed) throw new Error('Review connection is closed.');
    await available();
    await fs.mkdir(store, { recursive: true, mode: 0o700 });
    let oldSetup;
    try { oldSetup = await readRecord(metadata, 65536); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const previous = await legacyCommands(oldSetup);
    const registration = oldSetup?.version === 2 ? sharedSetup(oldSetup) : { version: 1, root, store, token: randomUUID() };
    const nextSetup = { version: 2, registry: registry.directory, root, store, token: registration.token, configFile, ...(previous.length ? { previous } : {}) };
    await registry.available(root, instance);
    await atomic(metadata, nextSetup);
    try {
      const result = await registry.register({ ...registration, instance, executable, previous });
      shared = registration; command = result.command;
    } catch (error) {
      if (oldSetup) await atomic(metadata, oldSetup); else await fs.unlink(metadata).catch(() => {});
      throw error;
    }
    lastEvent = undefined;
    try { await start(); await update(); changed(); }
    catch (error) {
      active = false; configured = false; clearInterval(timer); watcher?.close(); await registry.release(shared, instance).catch(() => {}); throw error;
    }
  }
  async function disconnect() {
    await available();
    let setup; try { setup = JSON.parse(await fs.readFile(metadata, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (setup.version === 2) await registry.unregister(sharedSetup(setup), instance);
    else { const previous = await legacyCommands(setup); await editHookConfig(configFile, store, input => configure(input, previous[0], [], true)); }
    await fs.unlink(metadata); active = false; configured = false; lastEvent = undefined; clearInterval(timer); watcher?.close(); await writes.catch(() => {});
    await withCaptureLock(store, async () => { await fs.unlink(path.join(store, 'owner.lock')).catch(() => {}); await fs.unlink(path.join(store, 'connection.json')).catch(() => {}); }); changed();
  }
  async function decision(arg, action) {
    if (disposed || !active) return false;
    const session = arg.turn.slice(0, arg.turn.lastIndexOf('/'));
    const file = path.join(store, 'feedback', hash(session), (arg.id ? hash(arg.id) : Date.now() + '-' + randomUUID()) + '.json');
    return withCaptureLock(store, async () => {
      if (disposed || !active || !allowedFull(root, arg.path, createPathPolicy(exclude()))) return false;
      await atomic(file, { action, path: arg.path, created: arg.created ?? Date.now() });
      return true;
    });
  }
  async function diagnosticState() {
    let input, configRead = 'ok';
    try { input = await readRecord(configFile, 5 * 1024 * 1024); }
    catch (error) { configRead = error.code === 'ENOENT' ? 'missing' : error instanceof InvalidRecord ? 'invalid' : 'unreadable'; }
    const groups = input?.hooks && typeof input.hooks === 'object' ? Object.values(input.hooks).flatMap(value => Array.isArray(value) ? value : []) : [];
    const ownedCommandCount = groups.reduce((count, group) => count + (Array.isArray(group?.hooks) ? group.hooks.filter(hook => hook?.type === 'command' && hook.command === command).length : 0), 0);
    const metadataPresent = await fs.lstat(metadata).then(stat => stat.isFile() && !stat.isSymbolicLink(), () => false);
    return { active, configured: isConfigured(input, command), ownedCommandCount, metadataPresent, captureBlocked, incomplete, configRead };
  }
  function dispose() {
    if (disposal) return disposal;
    disposed = true; active = false; clearInterval(timer); watcher?.close();
    disposal = (async () => {
      await setupChanges; await writes.catch(() => {});
      await maintenanceJob;
      await Promise.allSettled([maintenanceWalker?.return(), ...[...cleanupWalkers.values()].map(walker => walker.return())]);
      for (const name of ['connection.json', 'owner.lock']) {
        try { const data = JSON.parse(await fs.readFile(path.join(store, name), 'utf8')); if (data.instance === instance) await fs.unlink(path.join(store, name)); } catch {}
      }
      if (shared) await registry.release(shared, instance);
    })().catch(() => {});
    return disposal;
  }
  const ready = editSetup(async () => {
    root = await fs.realpath(root);
    await maintain(true);
    try {
      await scrubCurrentPolicy(); const setup = await readRecord(metadata, 65536);
      if (setup.version === 2) shared = sharedSetup(setup);
      await start();
    }
    catch (error) { if (error.code !== 'ENOENT') { captureBlocked = true; report(error); changed(); } }
  });
  return { ready, connect: () => editSetup(connect), disconnect: () => editSetup(disconnect), update, drain, decision, dispose, store, diagnosticState,
    inspectData: async () => ({ ...await inspectData(store), connected: active }), cleanup: categories => editSetup(() => cleanup(categories)),
    status: () => ({ connected: active && configured, lastEvent, ...(incomplete ? { incomplete: true } : {}), ...(captureBlocked ? { captureBlocked: true } : {}) }) };
}
module.exports = { createConnection };
