'use strict';
const path = require('node:path');

function createWatchIndex(files, platform = process.platform) {
  const directories = new Map(), fold = platform === 'darwin' || platform === 'win32';
  const add = (index, name, full) => { if (!index.has(name)) index.set(name, new Set()); index.get(name).add(full); };
  for (const file of files) {
    const directory = path.dirname(file.path);
    if (!directories.has(directory)) directories.set(directory, { exact: new Map(), folded: new Map() });
    const group = directories.get(directory);
    for (const name of new Set([path.basename(file.path), path.basename(file.canonical || file.path)])) {
      add(group.exact, name, file.path);
      if (fold) add(group.folded, name.toLowerCase(), file.path);
    }
  }
  return {
    get(directory, eventPath) {
      const group = directories.get(directory), name = path.basename(eventPath);
      return group?.exact.get(name) || (fold ? group?.folded.get(name.toLowerCase()) : undefined);
    }
  };
}
module.exports = { createWatchIndex };
