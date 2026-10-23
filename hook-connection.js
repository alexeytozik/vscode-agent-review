'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { atomic, hash } = require('./hook-runner');
const { configure, hookCommand } = require('./hook-config');

function createConnection({ storage, extensionPath, executable, root, receive, enabled, report, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') }) {
  const store = path.join(storage, 'lifecycle'), configFile = path.join(home, 'hooks.json'), instance = randomUUID();
  let active = false, timer, watcher, disposed = false, chain = Promise.resolve(), writes = Promise.resolve(), lastEvent;
  const metadata = path.join(store, 'setup.json');
  const bootstrap = path.join(store, 'launch.js');
  const command = hookCommand(executable, bootstrap, store);
  async function update() {
    if (!active || disposed) return;
    writes = writes.catch(() => {}).then(() => { if (active && !disposed) return atomic(path.join(store, 'connection.json'), { root, enabled: enabled(), pid: process.pid, instance, updated: Date.now(), extensionPath }); });
    await writes;
  }
  function drain() {
    chain = chain.then(async () => {
      const directory = path.join(store, 'events');
      const files = (await fs.readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; })).filter(f => /^\d+-[\w-]+\.json$/.test(f)).sort();
      for (const name of files) {
        const file = path.join(directory, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 25 * 1024 * 1024) throw new Error('Invalid lifecycle event file.');
        const payload = JSON.parse(await fs.readFile(file, 'utf8'));
        if (payload.version !== 1 || !Array.isArray(payload.records) || payload.records.length > 2) throw new Error('Invalid lifecycle event.');
        for (const event of payload.records) {
          if (!['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(event.method) || typeof event.threadId !== 'string' || typeof event.turnId !== 'string') throw new Error('Invalid lifecycle event.');
          for (const change of event.changes || []) {
            const relative = path.relative(root, change.path);
            if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Lifecycle path is outside this workspace.');
          }
          await receive(event);
        }
        lastEvent = Date.now(); await fs.unlink(file);
      }
    }).catch(report);
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
    active = true; await update();
    watcher = require('node:fs').watch(path.join(store, 'events'), () => drain());
    watcher.on('error', report);
    timer = setInterval(() => { update().then(drain).catch(report); }, 5000); timer.unref();
    await drain();
  }
  async function available() {
    let owner; try { owner = JSON.parse(await fs.readFile(path.join(store, 'owner.lock'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (owner.instance === instance) return;
    let alive = true; try { process.kill(owner.pid, 0); } catch { alive = false; }
    if (alive) throw new Error('Review is connected in another window for this workspace. Disconnect it there first.');
  }
  async function connect() {
    await available();
    await fs.mkdir(store, { recursive: true, mode: 0o700 });
    const bootstrapText = "'use strict';\nconst fs=require('node:fs'),path=require('node:path');\nconst store=process.argv[2];\nconst runtime=JSON.parse(fs.readFileSync(path.join(store,'runtime.json'),'utf8'));\nrequire(path.join(runtime.extensionPath,'hook-runner.js')).run(store);\n";
    await fs.writeFile(bootstrap, bootstrapText, { mode: 0o600 });
    let existing = {}, previous = [];
    try { existing = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { previous = [JSON.parse(await fs.readFile(metadata, 'utf8')).command]; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const before = JSON.stringify(existing), next = configure(existing, command, previous);
    const stat = await fs.lstat(configFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (stat?.isSymbolicLink()) throw new Error('The hooks configuration is a symbolic link. Configure it at its source.');
    if (stat) await fs.writeFile(path.join(store, 'hooks-backup-' + Date.now() + '.json'), JSON.stringify(existing, null, 2), { mode: 0o600, flag: 'wx' });
    // Recheck before replacement so another setup cannot be silently overwritten.
    let current = {}; try { current = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (JSON.stringify(current) !== before) throw new Error('Hooks configuration changed. Run Connect again.');
    await atomic(configFile, next);
    await atomic(metadata, { command, configFile });
    await start();
  }
  async function disconnect() {
    await available();
    let setup; try { setup = JSON.parse(await fs.readFile(metadata, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    const input = JSON.parse(await fs.readFile(setup.configFile, 'utf8'));
    await atomic(setup.configFile, configure(input, setup.command, [], true));
    await fs.unlink(metadata); active = false; clearInterval(timer); watcher?.close(); await writes; await fs.unlink(path.join(store, 'owner.lock')).catch(() => {}); await fs.unlink(path.join(store, 'connection.json')).catch(() => {});
  }
  async function decision(arg, action) {
    if (!active) return;
    const session = arg.turn.slice(0, arg.turn.lastIndexOf('/'));
    const file = path.join(store, 'feedback', hash(session), Date.now() + '-' + randomUUID() + '.json');
    await atomic(file, { action, path: arg.path });
  }
  function dispose() {
    disposed = true; active = false; clearInterval(timer); watcher?.close();
    writes.finally(async () => {
      for (const name of ['connection.json', 'owner.lock']) {
        try { const data = JSON.parse(await fs.readFile(path.join(store, name), 'utf8')); if (data.instance === instance) await fs.unlink(path.join(store, name)); } catch {}
      }
    }).catch(() => {});
  }
  const ready = fs.readFile(metadata, 'utf8').then(() => start()).catch(e => { if (e.code !== 'ENOENT') report(e); });
  return { ready, connect, disconnect, update, drain, decision, dispose, store, status: () => ({ connected: active, lastEvent }) };
}
module.exports = { createConnection };
