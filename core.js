'use strict';

const { createHash } = require('node:crypto');
const { diffArrays } = require('diff');

function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function revision(before, after) {
  return createHash('sha256').update(JSON.stringify([before, after])).digest('hex');
}

function changes(before, after) {
  const rev = revision(before, after);
  if (before === after) return { revision: rev, hunks: [] };
  if (before === null || after === null) {
    return { revision: rev, hunks: [{ id: rev + ':0', kind: before === null ? 'create' : 'delete', oldStart: 0, oldEnd: (before || '').length, newStart: 0, newEnd: (after || '').length, oldLine: 1, newLine: 1, before: before || '', after: after || '', contextBefore: '', contextAfter: '' }] };
  }
  const oldLines = lines(before), newLines = lines(after);
  const parts = diffArrays(oldLines, newLines, { timeout: 200, maxEditLength: 10000 });
  if (!parts) throw new Error('The diff is too large. Split the change into smaller parts.');
  const hunks = [];
  let oldOffset = 0, newOffset = 0, oldLine = 1, newLine = 1, pending;
  const finish = () => {
    if (!pending) return;
    pending.oldEnd = oldOffset;
    pending.newEnd = newOffset;
    pending.contextBefore = newLines.slice(Math.max(0, pending.newLine - 3), pending.newLine - 1).join('');
    pending.contextAfter = newLines.slice(newLine - 1, newLine + 1).join('');
    hunks.push(pending);
    pending = undefined;
  };
  for (const part of parts) {
    const text = part.value.join('');
    if (!part.added && !part.removed) {
      finish();
      oldOffset += text.length; newOffset += text.length;
      oldLine += part.count; newLine += part.count;
      continue;
    }
    pending ||= { id: rev + ':' + hunks.length, kind: 'edit', oldStart: oldOffset, newStart: newOffset, oldLine, newLine, before: '', after: '' };
    if (part.removed) { pending.before += text; oldOffset += text.length; oldLine += part.count; }
    if (part.added) { pending.after += text; newOffset += text.length; newLine += part.count; }
  }
  finish();
  return { revision: rev, hunks };
}

function decide(before, after, expectedRevision, id, action) {
  if (!['accept', 'reject'].includes(action)) throw new Error('Unknown action.');
  const current = changes(before, after);
  if (current.revision !== expectedRevision) throw new Error('The file changed. The list was refreshed; select the change again.');
  const hunk = current.hunks.find(h => h.id === id);
  if (!hunk) throw new Error('This change has already been modified. Refresh the list.');
  if (action === 'accept') {
    const baseline = hunk.kind === 'create' ? after : hunk.kind === 'delete' ? null : before.slice(0, hunk.oldStart) + hunk.after + before.slice(hunk.oldEnd);
    return { baseline, current: after, hunk };
  }
  const next = hunk.kind === 'create' ? null : hunk.kind === 'delete' ? before : after.slice(0, hunk.newStart) + hunk.before + after.slice(hunk.newEnd);
  return { baseline: before, current: next, hunk };
}

module.exports = { lines, revision, changes, decide };
