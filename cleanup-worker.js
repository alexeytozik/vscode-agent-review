'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function run() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 4 * 1024 * 1024) throw new Error('Cleanup limit.');
  }
  const batch = JSON.parse(input), directory = await fs.lstat('.', { bigint: true });
  if (!directory.isDirectory() || String(directory.dev) !== batch.dev || String(directory.ino) !== batch.ino) throw new Error('Cleanup directory changed.');
  if (!Array.isArray(batch.files) || batch.files.length > 2048) throw new Error('Cleanup limit.');
  let removed = 0, failed = 0, skippedActive = 0;
  for (const file of batch.files) {
    if (typeof file.name !== 'string' || !file.name || file.name === '.' || file.name === '..' || path.basename(file.name) !== file.name || /[\\/\0]/.test(file.name)) throw new Error('Cleanup scope.');
    if (file.pid && alive(file.pid)) { skippedActive++; continue; }
    try {
      const stat = await fs.lstat(file.name, { bigint: true });
      if (stat.isDirectory() || String(stat.dev) !== file.dev || String(stat.ino) !== file.ino) { failed++; continue; }
      // The child's CWD pins this directory. Never resolve a mutable parent path
      // again, even if the parent renames it or replaces it with a symlink.
      await fs.unlink(file.name); removed++;
    } catch (error) { if (error.code !== 'ENOENT') failed++; }
  }
  process.stdout.write(JSON.stringify({ removed, failed, skippedActive }));
}
run().catch(() => { process.stderr.write('Cleanup directory changed or could not be checked.\n'); process.exitCode = 1; });
