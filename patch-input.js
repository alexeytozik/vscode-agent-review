'use strict';
// Verify the exact text produced by the supported patch syntax. Ambiguous edits need manual review.
function parse(command) {
  if (typeof command !== 'string' || !command.startsWith('*** Begin Patch\n') || !command.trimEnd().endsWith('*** End Patch')) throw new Error('Unrecognized patch.');
  const files = []; let file;
  for (const row of command.trimEnd().split('\n').slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(row);
    if (header) { file = { kind: header[1].toLowerCase(), path: header[2], rows: [] }; files.push(file); }
    else if (row.startsWith('*** Move to: ') && file?.kind === 'update') file.move = row.slice(13);
    else if (file) file.rows.push(row);
    else throw new Error('Unrecognized patch.');
  }
  if (!files.length || files.length > 200) throw new Error('The patch exceeds the review limits.');
  return files;
}
function apply(file, before) {
  if (file.kind === 'delete') { if (before === null) throw new Error('Missing source.'); return null; }
  if (file.kind === 'add') {
    if (before !== null || file.rows.some(row => !row.startsWith('+'))) throw new Error('Invalid creation.');
    return file.rows.length ? file.rows.map(row => row.slice(1)).join('\n') + '\n' : '';
  }
  if (before === null) throw new Error('Missing source.');
  let lines = before.split(/\r?\n/); if (lines.at(-1) === '') lines.pop();
  let cursor = 0, rows = [], groups = [];
  for (const row of file.rows) {
    if (row.startsWith('@@')) { if (rows.length) groups.push(rows); rows = []; }
    else if (row === '*** End of File') { /* trailing position is verified below */ }
    else if (/^[ +\-]/.test(row)) rows.push(row);
    else throw new Error('Unsupported patch row.');
  }
  if (rows.length) groups.push(rows);
  if (!groups.length) throw new Error('No verified changes.');
  for (const group of groups) {
    const old = group.filter(row => row[0] !== '+').map(row => row.slice(1));
    const next = group.filter(row => row[0] !== '-').map(row => row.slice(1));
    if (!old.length) throw new Error('Insertion has no unambiguous context.');
    const matches = [];
    for (let i = cursor; i + old.length <= lines.length; i++) if (old.every((row, n) => row === lines[i + n])) matches.push(i);
    if (matches.length !== 1) throw new Error('Patch context is ambiguous.');
    const at = matches[0]; lines.splice(at, old.length, ...next); cursor = at + next.length;
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
module.exports = { parse, apply };
