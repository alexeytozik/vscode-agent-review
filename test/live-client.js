'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const assert = require('node:assert/strict');
const { isolatedHome, verifyLiveHooks } = require('./live-trust');

async function appServer(cli, cwd, store, extensionPath) {
  const home = await isolatedHome(process.env.CODEX_HOME, cwd, store);
  const child = spawn(cli, ['app-server'], {
    cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map(), turns = new Map(), listeners = new Map(), transcript = [];
  let next = 0, stderr = '', failure, closing = false;
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  function fail(error) {
    failure = error;
    for (const job of pending.values()) job.reject(error);
    for (const job of listeners.values()) job.reject(error);
    pending.clear(); listeners.clear();
  }
  child.on('error', fail);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.on('exit', code => { if (!closing) fail(new Error('Live app-server exited: ' + code)); });
  child.stdin.on('error', error => { if (!closing) fail(error); });
  child.stderr.on('data', data => { stderr += data; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line); transcript.push(message);
      if (message.id !== undefined && !message.method) {
        const job = pending.get(message.id); pending.delete(message.id);
        if (message.error) job?.reject(new Error(message.error.message)); else job?.resolve(message.result);
      } else if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: 'No interactive requests in this test.' } });
      } else if (message.method === 'turn/completed') {
        const turn = message.params.turn; turns.set(turn.id, turn);
        listeners.get(turn.id)?.resolve(turn); listeners.delete(turn.id);
      }
    } catch (error) { fail(error); child.kill(); }
  });
  const timeout = setTimeout(() => { fail(new Error('Live app-server timed out.')); child.kill(); }, 150000);
  function request(method, params) {
    if (failure) return Promise.reject(failure);
    const id = ++next;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }); });
  }
  async function close() {
    if (closing) return;
    closing = true; clearTimeout(timeout); lines.close(); child.stdin.end(); child.kill();
    let timer;
    try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000); })]); }
    finally { clearTimeout(timer); }
  }
  try {
    await request('initialize', { clientInfo: { name: 'review-check', title: 'Review check', version: '0.1.0' } });
    send({ method: 'initialized' });
    // Explicitly trust only the five vetted test handlers, through the public config API.
    const listed = await request('hooks/list', { cwds: [cwd] });
    const hooks = listed.data.flatMap(entry => entry.hooks);
    const { state } = await verifyLiveHooks({ home: process.env.CODEX_HOME, cwd, store, extensionPath, hooks });
    await request('config/value/write', { keyPath: 'hooks.state', value: state, mergeStrategy: 'upsert', filePath: path.join(home, 'config.toml') });
    const trusted = await request('hooks/list', { cwds: [cwd] });
    const trustedHooks = trusted.data.flatMap(entry => entry.hooks);
    await verifyLiveHooks({ home: process.env.CODEX_HOME, cwd, store, extensionPath, hooks: trustedHooks });
    assert.ok(trustedHooks.every(hook => hook.trustStatus === 'trusted'));
    const result = await request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'workspace-write' });
    return {
      async turn(text) {
        const start = await request('turn/start', { threadId: result.thread.id, input: [{ type: 'text', text }] });
        const turn = turns.get(start.turn.id) || await new Promise((resolve, reject) => {
          if (failure) reject(failure); else listeners.set(start.turn.id, { resolve, reject });
        });
        if (turn.status !== 'completed') throw new Error('Live turn failed: ' + (turn.error?.message || turn.status));
        return turn.items.filter(item => item.type === 'agentMessage').map(item => item.text).join('\n');
      },
      close,
      contexts: () => transcript.filter(message => message.method === 'hook/completed' && message.params?.run?.eventName === 'userPromptSubmit').flatMap(message => (message.params.run.entries || []).filter(entry => entry.kind === 'context').map(entry => entry.text)),
      log: () => transcript.map(item => JSON.stringify(item)).join('\n') + '\n' + stderr
    };
  } catch (error) { await close(); throw error; }
}

module.exports = { appServer };
