'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function launch(file, args, env) {
  const child = spawn(process.execPath, [path.join(__dirname, file), ...args], { stdio: 'inherit', env });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { child, done };
}
async function main() {
  const performance = process.argv.includes('--performance'), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'review-browser.')), readyFile = path.join(directory, 'ready.json');
  const editor = launch('run-editor.js', [performance ? '--performance' : '--renderer'], { ...process.env, REVIEW_RENDERER_READY_FILE: readyFile });
  let ready;
  try {
    const deadline = Date.now() + 120000;
    while (!ready && Date.now() < deadline) {
      try { ready = JSON.parse(await fs.readFile(readyFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (editor.child.exitCode !== null || editor.child.signalCode) throw new Error('The isolated editor exited before browser readiness.');
      if (!ready) await delay(50);
    }
    if (!ready) throw new Error('The isolated editor did not become ready.');
    const browser = launch(performance ? 'performance-browser.js' : 'renderer-browser.js', [readyFile], process.env);
    const status = await browser.done;
    if (status !== 0) {
      await fetch('http://127.0.0.1:' + ready.port + '/abort', { method: 'POST' }).catch(() => {});
      throw new Error('Browser validation failed: ' + status);
    }
    if (await editor.done !== 0) throw new Error('The isolated editor rejected browser validation.');
  } catch (error) {
    if (ready) await fetch('http://127.0.0.1:' + ready.port + '/abort', { method: 'POST' }).catch(() => {});
    else editor.child.kill('SIGTERM');
    throw error;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
