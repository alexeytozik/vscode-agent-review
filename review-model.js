'use strict';
const path = require('node:path');
const { parsePatch, reversePatch, applyPatch } = require('diff');
const { changes, decide, lines, revision } = require('./core');
const { validateState } = require('./review-state');
const safeMessage = value => String(value || 'The change could not be prepared.').replaceAll('\0', '\uFFFD').slice(0, 4096);

function strictApply(text, patch) {
  const firstOld = patch.hunks[0]?.lines.find(l => l[0] === ' ' || l[0] === '-');
  if (text.startsWith('\uFEFF') && patch.hunks[0]?.oldStart === 1 && firstOld && !firstOld.slice(1).startsWith('\uFEFF')) return '\uFEFF' + strictApply(text.slice(1), patch);
  const tokens = lines(text);
  for (const hunk of patch.hunks) {
    let index = hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart;
    for (const line of hunk.lines) {
      if (![' ', '-'].includes(line[0])) continue;
      if (tokens[index]?.replace(/\r?\n$/, '') !== line.slice(1).replace(/\r$/, '')) throw new Error('Text does not match the patch.');
      index++;
    }
  }
  const output = applyPatch(text, patch, { fuzzFactor: 0 });
  if (output === false) throw new Error('The patch cannot be applied to the current text.');
  return output;
}

function transition(change, start) {
  const snap = change.snapshot;
  if (!snap || snap.error) throw new Error(snap?.error || 'No file snapshot is available.');
  const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
  if (change.kind?.movePath || change.kind?.move_path) throw new Error('Renames currently require manual review.');
  if (kind === 'add' && snap.disk === '' && !change.diff?.trim()) return { before: null, after: '', current: snap.text, mode: snap.mode ?? 0o644, canonical: snap.canonical };
  if (kind === 'delete' && snap.disk === null && start?.disk === '' && !change.diff?.trim()) return { before: '', after: null, current: snap.text, mode: start.mode ?? 0o644, canonical: start.canonical };
  const patches = parsePatch(change.diff || '');
  if (patches.length !== 1 || !patches[0].hunks.length) throw new Error('No unambiguous text patch was received.');
  const patch = patches[0], current = snap.disk;
  let before, after;
  if (kind === 'add') {
    if (current === null || strictApply('', patch) !== current) throw new Error('The new file changed after it was written.');
    before = null; after = current;
  } else if (kind === 'delete') {
    if (current !== null) throw new Error('The deleted file reappeared.');
    before = strictApply('', reversePatch(patch)); after = null;
  } else {
    if (current === null) throw new Error('The modified file is missing.');
    before = strictApply(current, reversePatch(patch)); after = current;
    if (strictApply(before, patch) !== after) throw new Error('Patch verification failed.');
  }
  // Prefer the exact pre-operation bytes when the event really preceded the write.
  if (start && !start.error && start.disk !== null && strictCandidate(start.disk, patch, after)) before = start.disk;
  return { before, after, current: snap.text, mode: start?.mode ?? snap.mode ?? 0o644, canonical: start?.canonical || snap.canonical };
}
function strictCandidate(before, patch, after) { try { return strictApply(before, patch) === after; } catch { return false; } }

function transitions(change, start) {
  const destination = change.kind?.move_path || change.kind?.movePath;
  if (!destination) return [{ path: change.path, ...transition(change, start?.snapshot) }];
  if (!path.isAbsolute(destination) || start?.snapshot?.disk == null || start.destinationSnapshot?.disk !== null || change.snapshot?.disk !== null || change.destinationSnapshot?.disk == null) throw new Error('Could not verify the original rename state.');
  const patches = parsePatch(change.diff || '');
  if (patches.length !== 1 || strictApply(start.snapshot.disk, patches[0]) !== change.destinationSnapshot.disk) throw new Error('The renamed file content changed.');
  return [
    { path: change.path, before: start.snapshot.disk, after: null, current: change.snapshot.text, mode: start.snapshot.mode, canonical: start.snapshot.canonical },
    { path: destination, before: null, after: change.destinationSnapshot.disk, current: change.destinationSnapshot.text, mode: start.snapshot.mode, canonical: change.destinationSnapshot.canonical }
  ];
}

function intersects(a, b) { return a.newStart <= b.oldEnd && b.oldStart <= a.newEnd; }
function rebase(baseline, expected, current) {
  if (expected === current) return { baseline, expected };
  if (baseline === expected) return { baseline: current, expected: current };
  if (current === null) throw new Error('The file was removed after this request. Automatic rejection is unavailable.');
  if (expected === null) throw new Error('The file was recreated after this request. Automatic rejection is unavailable.');
  if (baseline === null) throw new Error('The new file has later edits. Automatic deletion is unavailable.');
  const pending = changes(baseline, expected).hunks;
  const manual = changes(expected, current).hunks;
  for (const m of manual) if (pending.some(h => intersects(h, m))) throw new Error('A manual or later edit overlaps with this change. Automatic rejection was stopped.');
  const offset = at => at + pending.filter(h => h.newEnd < at).reduce((n, h) => n + (h.oldEnd - h.oldStart) - (h.newEnd - h.newStart), 0);
  let next = baseline;
  for (const m of [...manual].reverse()) next = next.slice(0, offset(m.oldStart)) + m.after + next.slice(offset(m.oldEnd));
  return { baseline: next, expected: current };
}

class ReviewModel {
  constructor(saved, options) {
    this.turns = new Map(); this.operations = new Map(); this.retired = new Map(); this.feedback = []; this.diffs = new WeakMap();
    this.restoreIssues = [];
    if (saved) {
      const restored = validateState(saved, options); this.restoreIssues = restored.issues;
      this.retired = new Map((restored.state.retired || []).map(turn => [turn.key, turn]));
      this.feedback = restored.state.feedback || [];
      for (const turn of restored.state.turns) {
        this.turns.set(turn.key, { ...turn, running: false, files: new Map(turn.files.map(f => [f.path, f])) });
      }
    }
  }
  turn(event) {
    if (typeof event.threadId !== 'string' || typeof event.turnId !== 'string') return;
    const key = event.threadId + '/' + event.turnId;
    if (!this.turns.has(key)) {
      const previous = this.retired.get(key);
      if (previous && (!event.itemId || previous.seen.includes(event.itemId))) return;
      this.retired.delete(key);
      this.turns.set(key, { key, id: event.turnId, threadId: event.threadId, created: Date.now(), warnings: [], seen: [], ...previous, running: !previous, files: new Map() });
    }
    return this.turns.get(key);
  }
  receive(event) {
    const turn = this.turn(event); if (!turn) return;
    if (event.skipReason === 'excluded' && !turn.warnings.includes('excluded')) turn.warnings.push('excluded');
    if (event.method === 'turn/started') turn.running = true;
    if (event.method === 'turn/completed') turn.running = false;
    if (event.type === 'commandExecution' && !event.readOnly && !turn.warnings.includes('shell')) turn.warnings.push('shell');
    if (event.type === 'externalTool' && !turn.warnings.includes('external')) turn.warnings.push('external');
    if (event.type !== 'fileChange') return turn;
    const operationKey = turn.key + '/' + event.itemId;
    if (turn.seen.includes(event.itemId)) return turn;
    if (event.method === 'item/started') { this.operations.set(operationKey, event.changes); return turn; }
    if (event.method !== 'item/completed') return turn;
    turn.seen.push(event.itemId);
    const starts = this.operations.get(operationKey) || [];
    this.operations.delete(operationKey);
    if (!['completed', 'succeeded'].includes(event.status)) {
      turn.warnings.push('The operation ended without a confirmed write: ' + event.status); return turn;
    }
    for (const change of event.changes || []) {
      if (!path.isAbsolute(change.path)) { turn.warnings.push('A relative path was skipped.'); continue; }
      try {
        for (const update of transitions(change, starts.find(c => c.path === change.path))) {
          let file = turn.files.get(update.path);
          if (file?.error) throw new Error(file.error);
          if (!file) file = { path: update.path, baseline: update.before, expected: update.before, mode: update.mode, canonical: update.canonical };
          const next = rebase(file.baseline, file.expected, update.before);
          file.baseline = next.baseline; file.expected = update.after;
          const manual = rebase(file.baseline, file.expected, update.current);
          Object.assign(file, manual); delete file.error;
          turn.files.set(file.path, file);
        }
      } catch (e) {
        const existing = turn.files.get(change.path);
        turn.files.set(change.path, existing ? { ...existing, error: safeMessage(e.message) } : { path: change.path, baseline: null, expected: null, mode: 0o644, error: safeMessage(e.message) });
      }
    }
    return turn;
  }
  refresh(turnKey, full, current) {
    const f = this.turns.get(turnKey)?.files.get(full);
    if (!f) return f;
    // A failed diff is not a disk conflict: rereading identical bytes cannot fix it.
    if (f.diffError?.revision === revision(f.baseline, f.expected)) return f;
    if (f.error) {
      if (f.baseline !== f.expected && current === f.expected) delete f.error;
      else {
        if (f.error === 'File creation or deletion overlaps with later edits.') {
          try { rebase(f.baseline, f.expected, current); } catch (e) { f.error = e.message; }
        }
        return f;
      }
    }
    try { Object.assign(f, rebase(f.baseline, f.expected, current)); }
    catch (e) { f.error = e.message; }
    return f;
  }
  entries(key) {
    const turns = key ? [this.turns.get(key)].filter(Boolean) : [...this.turns.values()];
    return turns.flatMap(t => [...t.files.values()].map(f => {
      const cached = this.diffs.get(f);
      if (cached && cached.baseline === f.baseline && cached.expected === f.expected) {
        if (f.diffError) f.error ||= f.diffError.message;
        return { turn: t, file: f, ...cached.result };
      }
      const remember = result => {
        this.diffs.set(f, { baseline: f.baseline, expected: f.expected, result });
        return { turn: t, file: f, ...result };
      };
      if (f.diffError) {
        if (f.diffError.revision === revision(f.baseline, f.expected)) {
          f.error ||= f.diffError.message;
          return remember({ revision: f.diffError.revision, hunks: [] });
        }
        if (f.error === f.diffError.message) delete f.error;
        delete f.diffError;
      }
      try { return remember(changes(f.baseline, f.expected)); }
      catch (error) {
        f.diffError = { revision: revision(f.baseline, f.expected), message: error.message };
        f.error ||= error.message;
        return remember({ revision: f.diffError.revision, hunks: [] });
      }
    }).filter(e => e.file.error || e.hunks.length));
  }
  decide(key, full, revision, hunk, action) {
    const turn = this.turns.get(key), file = turn?.files.get(full);
    if (!file || file.error || turn.running) throw new Error(file?.error || 'Wait for the request to finish.');
    return decide(file.baseline, file.expected, revision, hunk, action);
  }
  save() {
    const turns = [], recent = new Map(this.retired);
    for (const t of this.turns.values()) {
      const files = [...t.files.values()].filter(f => f.error || f.decision || f.baseline !== f.expected).map(f => ({ ...f,
        ...(f.error ? { error: safeMessage(f.error) } : {}), ...(f.diffError ? { diffError: { ...f.diffError, message: safeMessage(f.diffError.message) } } : {}) }));
      if (files.length || t.running) { turns.push({ ...t, files }); recent.delete(t.key); }
      else {
        recent.delete(t.key);
        recent.set(t.key, { key: t.key, id: t.id, threadId: t.threadId, created: t.created, running: false, warnings: t.warnings.slice(-16), seen: t.seen.slice(-4096) });
      }
    }
    // History never displaces an unresolved payload at the 40 MiB queue limit.
    const budget = Math.max(0, Math.min(256 * 1024, 40 * 1024 * 1024 - Buffer.byteLength(JSON.stringify([turns, this.feedback])) - 128));
    const retired = []; let bytes = 0, ids = 0;
    for (const t of [...recent.values()].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(t)) + 1;
      if (retired.length >= 512 || ids + t.seen.length > 4096 || bytes + size > budget) break;
      retired.unshift(t); bytes += size; ids += t.seen.length;
    }
    return { version: 2, turns, retired, feedback: this.feedback };
  }
  compact(saved = this.save()) {
    this.retired = new Map(saved.retired.map(t => [t.key, t]));
    for (const [key, turn] of this.turns) {
      for (const [full, file] of turn.files) if (!file.error && !file.decision && file.baseline === file.expected) turn.files.delete(full);
      if (!turn.running && !turn.files.size) {
        this.turns.delete(key);
        for (const operation of this.operations.keys()) if (operation.startsWith(key + '/')) this.operations.delete(operation);
      }
    }
  }
}
module.exports = { ReviewModel, strictApply, transition, rebase };
