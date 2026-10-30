'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class InvalidRecord extends Error {}
// 128 patterns × 1024 UTF-16 units can exceed 64 KiB, including JSON escaping.
const CONNECTION_LIMIT = 2 * 1024 * 1024;

async function readRecord(file, limit) {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new InvalidRecord('Not a regular file.');
    if (stat.size > limit) throw new InvalidRecord('Record exceeds the size limit.');
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit) throw new InvalidRecord('Record exceeds the size limit or is not a regular file.');
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw Object.assign(new Error('Record changed while opening.'), { code: 'EAGAIN' });
    const bytes = Buffer.alloc(Math.min(opened.size + 1, limit + 1));
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw Object.assign(new Error('Record changed while reading.'), { code: 'EAGAIN' });
    try { return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); }
    catch { throw new InvalidRecord('Malformed JSON.'); }
  } catch (error) {
    if (error.code === 'ELOOP') throw new InvalidRecord('Symbolic link.');
    throw error;
  } finally { await handle?.close(); }
}

// Only rejected transport records are retained here; never pending reviews.
// Keep at most 32 records and 25 MiB of payloads, with private reason receipts.
async function quarantine(directory, file, reason) {
  const source = await fs.lstat(file);
  if (!source.isFile() && !source.isSymbolicLink()) throw new Error('Cannot quarantine a special file.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid quarantine directory.');
  await fs.chmod(directory, 0o700);
  const name = Date.now().toString().padStart(16, '0') + '-' + randomUUID();
  const receipt = path.join(directory, name + '.json'), target = path.join(directory, name + '.record');
  await fs.writeFile(receipt, JSON.stringify({ created: Date.now(), reason, source: path.basename(file) }), { mode: 0o600, flag: 'wx' });
  try { await fs.rename(file, target); }
  catch (error) {
    await fs.unlink(receipt).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (error.code !== 'ENOENT') throw error;
  }
  const moved = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (moved?.isFile()) {
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.chmod(0o600); } finally { await handle.close(); }
  }
  // Include payloads left behind by an interrupted quarantine operation.
  const names = [...new Set((await fs.readdir(directory)).filter(n => /^\d+-[\w-]+\.(json|record)$/.test(n)).map(n => n.replace(/\.(json|record)$/, '')))].sort().reverse();
  let bytes = 0;
  for (const [index, name] of names.entries()) {
    const payload = path.join(directory, name + '.record');
    const info = await fs.lstat(payload).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (index >= 32 || bytes + (info?.size || 0) > 25 * 1024 * 1024) {
      // Remove only quarantined records. A symlink is unlinked, never followed.
      await fs.unlink(payload).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (index >= 32) await fs.unlink(path.join(directory, name + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } else bytes += info?.size || 0;
  }
}

module.exports = { InvalidRecord, readRecord, quarantine, CONNECTION_LIMIT };
