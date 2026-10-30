'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createConnection } = require('../hook-connection');
const { atomic } = require('../hook-runner');
const { commandArgs, hookCommand, configure } = require('../hook-config');
const legacy = process.env.REVIEW_BENCH_ARCH === 'legacy';
const executable = process.env.REVIEW_HOOK_EXECUTABLE || process.execPath;
const repetitions = Number(process.env.REVIEW_BENCH_REPETITIONS || 5);
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
async function invoke(command, input) {
  const start = performance.now();
  const args = commandArgs(command); if (!args) throw new Error('Unrecognized benchmark hook command.');
  const child = spawn('/usr/bin/time', ['-lp', ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', usage = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { usage += b; }); child.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error('Hook subprocess failed: ' + code);
  JSON.parse(output);
  const seconds = type => Number(usage.match(new RegExp('^' + type + ' ([\\d.]+)$', 'm'))?.[1] || 0);
  return { wall_ms: performance.now() - start, cpu_ms: (seconds('user') + seconds('sys')) * 1000 };
}
async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-connections.'))), results = [];
  try {
    for (const count of [1, 5, 20]) {
      const directory = path.join(root, String(count)), home = path.join(directory, 'home'), connections = [], errors = [];
      await atomic(path.join(home, 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign-command' }] }] } });
      try {
        for (let i = 0; i < count; i++) {
          const workspace = path.join(directory, 'workspace-' + i); await fs.mkdir(workspace, { recursive: true });
          const storage = path.join(directory, 'profile-' + i), store = path.join(storage, 'lifecycle');
          if (legacy) {
            const script = path.join(store, 'launch.js'), command = hookCommand(executable, script, store), configFile = path.join(home, 'hooks.json');
            await fs.mkdir(store, { recursive: true });
            await fs.writeFile(script, "'use strict';\nconst fs=require('node:fs'),path=require('node:path');\nconst store=process.argv[2];\nconst runtime=JSON.parse(fs.readFileSync(path.join(store,'runtime.json'),'utf8'));\nrequire(path.join(runtime.extensionPath,'hook-runner.js')).run(store);\n");
            await atomic(path.join(store, 'setup.json'), { command, configFile });
            await atomic(configFile, configure(JSON.parse(await fs.readFile(configFile, 'utf8')), command));
          }
          const connection = createConnection({ storage, extensionPath: path.resolve(__dirname, '..'), executable, root: workspace, home, enabled: () => true, receive: async () => {}, report: error => errors.push(error.message) });
          await connection.ready; if (!legacy) await connection.connect(); connections.push(connection);
        }
        const configured = JSON.parse(await fs.readFile(path.join(home, 'hooks.json'), 'utf8'));
        const commands = Object.values(configured.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
        const eventCommands = configured.hooks.UserPromptSubmit.flatMap(group => group.hooks.map(hook => hook.command));
        const input = { hook_event_name: 'UserPromptSubmit', session_id: 'benchmark', cwd: path.join(directory, 'workspace-0') };
        for (const mode of ['serial', 'parallel']) {
          const samples = [];
          for (let round = 0; round < repetitions; round++) {
            const start = performance.now(), event = { ...input, turn_id: mode + '-' + round };
            let children;
            if (mode === 'parallel') children = await Promise.all(eventCommands.map(command => invoke(command, event)));
            else { children = []; for (const command of eventCommands) children.push(await invoke(command, event)); }
            samples.push({ wall_ms: performance.now() - start, cpu_ms: children.reduce((sum, child) => sum + child.cpu_ms, 0), individual_ms: children.map(child => child.wall_ms) });
          }
          const result = { workspaces: count, configured_commands: commands.length, processes_per_event: eventCommands.length, mode, repetitions, wall_p50_ms: +percentile(samples.map(s => s.wall_ms), .5).toFixed(2), wall_p95_ms: +percentile(samples.map(s => s.wall_ms), .95).toFixed(2), cpu_p50_ms: +percentile(samples.map(s => s.cpu_ms), .5).toFixed(2), samples };
          results.push(result); console.log(JSON.stringify(result));
        }
        if (errors.length) throw new Error('Fixture connection errors: ' + errors.length);
      } finally { for (const connection of connections) { await connection.disconnect(); await connection.dispose(); } }
    }
    await fs.writeFile(process.env.REVIEW_BENCH_REPORT || '/tmp/review-connections-bench.json', JSON.stringify({ architecture: legacy ? 'legacy' : 'shared', runtime: process.versions.node, executable, fresh_process_each_event: true, os_caches_flushed: false, cpu_scope: 'child user+sys from macOS time, 10ms resolution', results }, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
