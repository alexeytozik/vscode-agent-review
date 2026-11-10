'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

async function prepareStateFixture(phase, result, user) {
  if (!['state', 'state-corrupt', 'state-partial'].includes(phase)) return;
  if (result?.passed !== true || typeof result.stateFixture !== 'string') throw new Error('The state phase did not provide its next restart fixture.');
  const profile = await fs.realpath(user), storage = await fs.realpath(result.stateFixture);
  const relative = path.relative(profile, storage);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('The state fixture is outside its isolated test profile.');
  const cache = path.join(storage, 'request-review.json');
  const stat = await fs.lstat(cache);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The state fixture must be a regular queue file.');
  if (phase === 'state') await fs.writeFile(cache, '{');
  else if (phase === 'state-corrupt') {
    const mixed = JSON.parse(await fs.readFile(cache, 'utf8'));
    const file = mixed.turns?.find(turn => turn.files?.length)?.files[0];
    if (!file || typeof file.path !== 'string') throw new Error('The partial recovery fixture needs a pending file.');
    mixed.turns.push({ id: 'broken', files: [] });
    const turn = mixed.turns.find(entry => entry.files?.includes(file));
    turn.files.push({ ...file, path: path.join(path.dirname(path.dirname(file.path)), 'outside.txt') });
    await fs.writeFile(cache, JSON.stringify(mixed));
  } else {
    const directory = await fs.open(storage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const original = await directory.stat();
      if (!original.isDirectory()) throw new Error('The state fixture storage must be a directory.');
      await directory.chmod(0o500);
      let closed = false;
      return async () => {
        if (closed) return;
        closed = true;
        try { await directory.chmod(original.mode & 0o777); }
        finally { await directory.close(); }
      };
    } catch (error) { await directory.close(); throw error; }
  }
}

module.exports = { prepareStateFixture };
