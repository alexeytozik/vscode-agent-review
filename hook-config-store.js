'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const LIMIT = 5 * 1024 * 1024;
const changed = () => new Error('Hooks configuration changed. Retry the operation.');
async function snapshot(file) {
  const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return { text: null, value: {} };
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The hooks configuration is not a regular file or is a symbolic link. Configure it at its source.');
  if (stat.size > LIMIT) throw new Error('Hooks configuration exceeds 5 MiB.');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) throw changed();
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw changed();
    const text = bytes.subarray(0, offset).toString('utf8');
    return { text, value: JSON.parse(text), ino: stat.ino, dev: stat.dev, mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}
async function editHookConfig(file, backups, transform) {
  const original = await snapshot(file), value = transform(original.value);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(backups)).isDirectory() || (await fs.lstat(backups)).isSymbolicLink()) throw new Error('Invalid hooks backup directory.');
  if (original.text !== null) await fs.writeFile(path.join(backups, 'hooks-backup-' + Date.now() + '-' + randomUUID() + '.json'), original.text, { mode: 0o600, flag: 'wx' });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: original.mode ?? 0o600, flag: 'wx' });
    // Write the candidate first, then compare bytes and identity immediately
    // before replacement. This does not lock unrelated configuration editors.
    const current = await snapshot(file);
    if (current.text !== original.text || current.ino !== original.ino || current.dev !== original.dev) throw changed();
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return value;
}
module.exports = { editHookConfig };
