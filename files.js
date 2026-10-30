'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const picomatch = require('picomatch');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const excludedDirs = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', 'target', 'dist', 'build', '.ssh', '.aws', '.kube', '.gnupg']);
const credentialNames = new Set(['.npmrc', '.netrc', 'kubeconfig', 'token.secret', '.pypirc', '.pgpass', 'secrets.yaml', 'secrets.yml', 'secrets.json']);
const credentialDirs = new Set(['.ssh', '.aws', '.kube', '.gnupg']);
function credentialPath(full) {
  const parts = full.split(/[\\/]/).map(part => part.toLowerCase());
  return parts.some(part => credentialDirs.has(part)) || parts.some((part, index) => part === '.docker' && parts[index + 1] === 'config.json');
}

function allowed(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative)) return false;
  const parts = relative.split(/[\\/]/);
  return !parts.some(p => p === '..' || excludedDirs.has(p.toLowerCase()) || credentialNames.has(p.toLowerCase())) && !parts.some(p => /^\.env(?:\.|rc$|$)/i.test(p) || /^(?:auth|credentials)\.json$/i.test(p) || /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/i.test(p) || /\.(?:pem|key|p12|pfx|kubeconfig)$/i.test(p)) && !/(^|\/)\.docker\/config\.json$/i.test(parts.join('/'));
}
function createPathPolicy(patterns = []) {
  if (!Array.isArray(patterns) || patterns.length > 128 || patterns.some(p => typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0') || p.startsWith('!') || path.isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error('Invalid review exclusion patterns. Use up to 128 relative globs without negation.');
  const matches = patterns.map(pattern => picomatch(pattern.replaceAll('\\', '/').replace(/^\.\//, ''), { dot: true, nonegate: true, maxLength: 1024 }));
  return { allowed: relative => allowed(relative) && !matches.some(match => match(relative.replaceAll('\\', '/'))) };
}
function allowedFull(root, full, policy, aliases = []) {
  if (typeof full !== 'string' || !path.isAbsolute(full) || full.includes('\0') || credentialPath(full)) return false;
  return [root, ...aliases].some(base => {
    if (!base) return false;
    const relative = path.relative(base, full);
    return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && policy.allowed(relative);
  });
}

function resolveInside(root, relative, policy = { allowed }) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Invalid path.');
  const full = path.resolve(root, relative);
  const back = path.relative(root, full);
  if (!back || back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) throw new Error('The path is outside the selected folder.');
  if (!policy.allowed(back) || credentialPath(full)) throw Object.assign(new Error('The path is protected or excluded from review.'), { code: 'REVIEW_EXCLUDED' });
  return full;
}

async function assertSafe(root, relative, policy = { allowed }) {
  const full = resolveInside(root, relative, policy);
  let existing = full;
  while (true) {
    try {
      const stat = await fs.lstat(existing);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links cannot be changed.');
      break;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(existing);
      if (parent === existing) throw e;
      existing = parent;
    }
  }
  const realRoot = await fs.realpath(root);
  const realExisting = await fs.realpath(existing);
  const back = path.relative(realRoot, realExisting);
  if (back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) throw new Error('The symbolic link points outside the selected folder.');
  if (credentialPath(realExisting) || credentialPath(path.resolve(realRoot, relative)) || back && !policy.allowed(back)) throw Object.assign(new Error('The resolved path is excluded from review.'), { code: 'REVIEW_EXCLUDED' });
  return full;
}

function decode(buffer) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error('File exceeds 1 MiB.');
  if (buffer.includes(0)) throw new Error('Binary file.');
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw new Error('Only UTF-8 text files are supported.');
  return text;
}

async function scan(root, documents = new Map()) {
  const files = new Map(), skipped = [];
  let count = 0, bytes = 0;
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name), relative = path.relative(root, full);
      if (!allowed(relative) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      if (++count > MAX_FILES) throw new Error('The folder contains more than 2,000 files. Select a smaller folder.');
      try {
        const stat = await fs.stat(full);
        if (stat.size > MAX_FILE_BYTES) throw new Error('File exceeds 1 MiB.');
        const text = documents.has(full) ? documents.get(full) : decode(await fs.readFile(full));
        const size = Buffer.byteLength(text);
        if (size > MAX_FILE_BYTES) throw new Error('File exceeds 1 MiB.');
        bytes += size;
        if (bytes > MAX_TOTAL_BYTES) throw Object.assign(new Error('The folder contains more than 20 MiB of text. Select a smaller folder.'), { fatal: true });
        files.set(relative, text);
      } catch (e) {
        if (e.fatal) throw e;
        if (e.code !== 'ENOENT') skipped.push({ path: relative, reason: e.message });
      }
    }
  }
  await walk(root);
  for (const [full, text] of documents) {
    const relative = path.relative(root, full);
    if (files.has(relative) || !allowed(relative)) continue;
    try {
      await assertSafe(root, relative);
      decode(Buffer.from(text));
      if (++count > MAX_FILES || (bytes += Buffer.byteLength(text)) > MAX_TOTAL_BYTES) throw Object.assign(new Error('Select a smaller folder.'), { fatal: true });
      files.set(relative, text);
    } catch (e) { if (e.fatal) throw e; }
  }
  return { files, skipped };
}

module.exports = { MAX_FILE_BYTES, allowed, createPathPolicy, allowedFull, resolveInside, assertSafe, decode, scan };
