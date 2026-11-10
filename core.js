'use strict';

const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { diffArrays } = require('diff');
const maxEditLength = 10000, diffTimeout = 200;

function alignedParts(oldLines, newLines, deadline) {
  if (oldLines.length !== newLines.length || oldLines.length < 256) return;
  const expired = index => (index & 1023) === 0 && performance.now() >= deadline;
  let edits = 0;
  for (let index = 0; index < oldLines.length; index++) {
    if (expired(index)) return;
    if (oldLines[index] !== newLines[index]) edits++;
  }
  // Small edits already take the linear common-prefix path in Myers.
  if (edits < 64) return;
  const oldValues = new Set(), newValues = new Set();
  for (let index = 0; index < oldLines.length; index++) {
    if (expired(index)) return;
    oldValues.add(oldLines[index]); newValues.add(newLines[index]);
  }
  for (let index = 0; index < oldLines.length; index++) {
    if (expired(index)) return;
    if (oldLines[index] !== newLines[index] && (newValues.has(oldLines[index]) || oldValues.has(newLines[index]))) return;
  }
  // Changed tokens cannot match across versions; all unchanged lines form a
  // longest common subsequence, with exactly two edits per change.
  if (edits * 2 > maxEditLength) throw new Error('The diff is too large. Split the change into smaller parts.');
  const parts = [];
  for (let start = 0; start < oldLines.length;) {
    const common = oldLines[start] === newLines[start];
    let end = start + 1;
    if (expired(start)) return;
    while (end < oldLines.length && (oldLines[end] === newLines[end]) === common) {
      if (expired(end)) return;
      end++;
    }
    const count = end - start;
    if (common) parts.push({ count, value: oldLines.slice(start, end) });
    else parts.push({ count, removed: true, value: oldLines.slice(start, end) }, { count, added: true, value: newLines.slice(start, end) });
    start = end;
  }
  return parts;
}

function diffParts(oldLines, newLines) {
  const deadline = performance.now() + diffTimeout;
  const aligned = alignedParts(oldLines, newLines, deadline);
  const remaining = deadline - performance.now();
  if (remaining <= 0) return;
  return aligned || diffArrays(oldLines, newLines, { timeout: remaining, maxEditLength });
}

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
  const parts = diffParts(oldLines, newLines);
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
