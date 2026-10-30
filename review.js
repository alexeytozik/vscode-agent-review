'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { ReviewModel } = require('./review-model');
const { changes, revision, decide: computeDecision } = require('./core');
const { decode, createPathPolicy, allowedFull } = require('./files');
const { filterEvent, permittedChange } = require('./capture-policy');
const { createModeStatus, statusDetails } = require('./mode-status');
const { actions, decisionGate } = require('./public-controls');
const { createConnection } = require('./hook-connection');
const { createReviewView, viewState } = require('./review-view');
const { createStateStore } = require('./review-state');
const { createReviewIO } = require('./review-io');
const { createRequestHistory } = require('./review-metrics');
const { buildDiagnostics } = require('./review-diagnostics');

function activate(context) {
  const io = createReviewIO(vscode);
  let model = new ReviewModel(), archiveLoaded = false, serial = Promise.resolve(), selected, outcome, lastPatch, latestRequest, timer, owned = false, resumeOnOpen = false, nativeLoaded = false;
  const ignoredTurns = new Set();
  const requestHistory = createRequestHistory();
  let pathPolicy, pathPolicyKey;
  function policy() {
    const patterns = vscode.workspace.getConfiguration('changeReview').get('exclude', []), key = JSON.stringify(patterns);
    if (key !== pathPolicyKey) { pathPolicy = createPathPolicy(patterns); pathPolicyKey = key; }
    return pathPolicy;
  }
  const aliases = () => folder ? [folder.uri.fsPath] : [];
  const permitted = full => allowedFull(root, full, policy(), aliases());
  function applyPolicy() {
    let removed = 0;
    for (const turn of model.turns.values()) for (const [full, file] of turn.files) if (!permitted(full) || file.canonical && !permitted(file.canonical)) {
      turn.files.delete(full); if (!turn.warnings.includes('excluded')) turn.warnings.push('excluded'); removed++;
    }
    for (const [key, changes] of model.operations) {
      const kept = changes.filter(change => permittedChange(root, change, policy(), aliases()));
      if (kept.length) model.operations.set(key, kept); else model.operations.delete(key);
      removed += changes.length - kept.length;
    }
    const feedback = model.feedback.filter(record => permitted(record.path)); removed += model.feedback.length - feedback.length; model.feedback = feedback;
    if (removed) {
      if (selected && !permitted(selected.path)) selected = undefined;
      outcome = { paused: true, message: 'Protected or excluded paths were removed from review storage. Their files were kept unchanged.' };
    }
    return removed;
  }
  const enabled = () => vscode.workspace.getConfiguration('changeReview').get('enabled', true);
  const reviewTab = () => vscode.workspace.getConfiguration('changeReview').get('view', 'review') !== 'editor';
  let hooks;
  const supportedWorkspace = () => vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length === 1 && vscode.workspace.workspaceFolders[0].uri.scheme === 'file';
  function reviewStatus() {
    const pending = entries();
    const latest = pending.filter(e => e.turn.key === latestRequest?.key);
    const reason = latestRequest?.reason === 'ready changes opened' && !latest.some(e => !e.file.error) ? (latest.length ? 'review paused because changes could not be prepared' : 'all recorded changes reviewed') : latestRequest?.reason;
    return { lastPatch, lastResult: latestRequest?.result || 'not-observed', pendingFiles: pending.length, ready: pending.filter(e => !e.file.error && !e.turn.running).reduce((n, e) => n + e.hunks.length, 0), blocked: pending.filter(e => e.file.error).length, running: pending.filter(e => e.turn.running && !e.file.error).length,
      skipped: latestRequest?.skipped.size || 0, skippedAtLeast: Boolean(latestRequest?.skippedAtLeast), autoOpenReason: !enabled() ? 'review is OFF' : !vscode.workspace.getConfiguration('changeReview').get('autoOpen', true) ? 'disabled in settings' : reason || 'waiting for a completed request' };
  }
  const statusState = () => ({ available: supportedWorkspace(), ...hooks?.status(), ...reviewStatus() });
  const modeStatus = createModeStatus(vscode, enabled, statusState);
  context.subscriptions.push(modeStatus);
  const inserted = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground') });
  const removed = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground') });
  const lensesChanged = new vscode.EventEmitter();
  const controls = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(inserted, removed, controls, lensesChanged);
  const watchers = new Map(), trackedPaths = new Set(), canonicalPaths = new Map(), dirtyPaths = new Set(), documents = new Map();
  const storage = context.storageUri || context.globalStorageUri;
  const cache = path.join(storage.fsPath, 'request-review.json');
  const stateStore = createStateStore(cache);
  const report = e => { vscode.window.showWarningMessage('Agent Review: ' + e.message); };
  const exclusive = fn => { const job = serial.then(fn); serial = job.catch(() => {}); return job; };
  const keyFor = e => ({ turn: e.turn.key, path: e.file.path, revision: e.revision });
  const reviewView = createReviewView(vscode, context, includeBlocks => viewState(entries(), selected, root, includeBlocks, outcome), async (action, arg) => {
    requireEnabled();
    if (action === 'accept' || action === 'reject') return decideOnce(arg, action, true);
    return exclusive(async () => {
      if (action === 'select') return show(arg);
      if (action === 'next' || action === 'previous') return move(arg, action === 'next' ? 1 : -1);
    });
  });
  context.subscriptions.push(reviewView);
  const virtual = (scheme, arg) => vscode.Uri.from({ scheme, path: arg.path, query: JSON.stringify({ turn: arg.turn }) });
  function argument(uri) { try { return { path: uri.fsPath || uri.path, turn: JSON.parse(uri.query).turn }; } catch { return; } }
  function entries() { return model.entries().sort((a, b) => a.turn.created - b.turn.created || a.file.path.localeCompare(b.file.path)); }
  async function persist() {
    if (!archiveLoaded) throw new Error('The saved queue must be read successfully before saving. Retry Open or refresh.');
    const saved = model.save();
    await stateStore.save(saved);
    model.compact(saved);
  }
  function queueFeedback(arg, action, id, created = Date.now()) {
    if (!model.feedback.some(record => record.id === id)) model.feedback.push({ id, turn: arg.turn, path: arg.path, action, created });
  }
  async function flushFeedback() {
    for (const record of [...model.feedback]) {
      if (!await hooks?.decision(record, record.action)) return;
      model.feedback = model.feedback.filter(item => item.id !== record.id);
      try { await persist(); }
      catch (error) { model.feedback.unshift(record); throw error; }
    }
  }
  function recoverDecision(entry, state) {
    const file = entry.file, intent = file.decision;
    if (!intent) return;
    if (intent.action === 'accept' || state.text === file.expected) { delete file.decision; delete file.error; return; }
    try {
      const result = computeDecision(file.baseline, file.expected, intent.revision, intent.hunk, intent.action);
      if (state.canonical !== intent.canonical || state.text !== result.current) throw new Error('An interrupted Undo conflicts with later edits. The original snapshot is retained for manual recovery.');
      if (!intent.wasDirty && state.doc?.isDirty) throw new Error('Undo changed the buffer, but saving failed. Save or restore the buffer before retrying recovery.');
      if (file.expected === null && state.mode !== file.mode) throw new Error('Undo restored the file, but its permissions differ. Restore the original permissions before retrying recovery.');
      file.expected = result.current; delete file.decision; delete file.error;
      queueFeedback({ turn: entry.turn.key, path: file.path }, intent.action, intent.id, intent.created);
    } catch (error) { file.error = error.message; }
  }
  async function indexDocuments(force = false) {
    const open = new Set(vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file'));
    for (const doc of documents.keys()) if (!open.has(doc)) documents.delete(doc);
    await Promise.all([...open].map(async doc => {
      if (force || !documents.has(doc)) documents.set(doc, await fs.realpath(doc.uri.fsPath).catch(() => path.resolve(doc.uri.fsPath)));
    }));
  }
  async function actual(full, verifyDocuments = true) {
    if (!permitted(full)) throw new Error('The path is protected or excluded from review.');
    let bytes, mode;
    try {
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Symbolic links and special files cannot be changed.');
      if (stat.size > 1024 * 1024) throw new Error('File exceeds 1 MiB.');
      mode = stat.mode & 0o777;
      bytes = await fs.readFile(full); decode(bytes);
    } catch (e) { if (e.code === 'ENOENT') bytes = null; else throw e; }
    let existing = full, suffix = [], canonical;
    for (;;) {
      try { canonical = path.join(await fs.realpath(existing), ...suffix); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; const parent = path.dirname(existing); if (parent === existing) throw e; suffix.unshift(path.basename(existing)); existing = parent; }
    }
    const relative = root && path.relative(root, canonical);
    if (!root || !relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('The resolved file path is outside this workspace.');
    if (!permitted(canonical)) throw new Error('The resolved path is protected or excluded from review.');
    let doc;
    if (verifyDocuments) await indexDocuments(true);
    for (const [d, indexed] of documents) {
      if (indexed !== canonical && d.uri.fsPath !== full) continue;
      // Recheck a candidate: a symlink may have changed since it was indexed.
      const resolved = await fs.realpath(d.uri.fsPath).catch(() => path.resolve(d.uri.fsPath)); documents.set(d, resolved);
      if (resolved === canonical) { doc = d; break; }
    }
    const bom = bytes?.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
    return { text: doc?.isDirty ? (bom ? '\uFEFF' : '') + doc.getText() : bytes === null ? null : bytes.toString('utf8'), disk: bytes, doc, canonical, bom: Boolean(bom), mode };
  }
  function update() {
    modeStatus.update();
    const pending = entries();
    vscode.commands.executeCommand('setContext', 'changeReview.enabled', enabled());
    vscode.commands.executeCommand('setContext', 'changeReview.nativeControls', nativeLoaded);
    vscode.commands.executeCommand('setContext', 'changeReview.hasPending', enabled() && pending.length > 0);
    vscode.commands.executeCommand('setContext', 'changeReview.inEditor', enabled() && !reviewTab() && Boolean(selected && pending.some(e => e.turn.key === selected.turn && e.file.path === selected.path)));
    for (const t of model.turns.values()) for (const f of t.files.values()) {
      const arg = { turn: t.key, path: f.path }; contentChanged.fire(virtual('review-base', arg)); contentChanged.fire(virtual('review-current', arg));
    }
    trackedPaths.clear(); canonicalPaths.clear();
    const directories = new Set();
    for (const e of enabled() ? pending : []) {
      trackedPaths.add(e.file.path);
      const canonical = e.file.canonical || e.file.path;
      if (!canonicalPaths.has(canonical)) canonicalPaths.set(canonical, new Set());
      canonicalPaths.get(canonical).add(e.file.path);
      const directory = path.dirname(e.file.path); directories.add(directory);
      if (!watchers.has(directory)) {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'));
        w.onDidChange(uri => schedule(uri.fsPath)); w.onDidCreate(uri => schedule(uri.fsPath)); w.onDidDelete(uri => schedule(uri.fsPath)); watchers.set(directory, w);
      }
    }
    for (const [directory, w] of watchers) if (!directories.has(directory)) { w.dispose(); watchers.delete(directory); }
    decorate(); lensesChanged.fire(); reviewView.update();
  }
  async function hideHover() {
    if ((await vscode.commands.getCommands(true)).includes('editor.action.hideHover')) await vscode.commands.executeCommand('editor.action.hideHover');
  }
  async function refresh(paths) {
    if (!paths) { clearTimeout(timer); dirtyPaths.clear(); }
    await loadArchive();
    await indexDocuments(!paths);
    for (const entry of entries().filter(e => !paths || paths.has(e.file.path))) {
      try {
        const state = await actual(entry.file.path, false);
        if (entry.file.canonical && entry.file.canonical !== state.canonical) throw new Error('The file path changed through a symbolic link. Automatic rejection was stopped.');
        recoverDecision(entry, state);
        if (entry.file.decision) continue;
        model.refresh(entry.turn.key, entry.file.path, state.text);
      }
      catch (e) { entry.file.error = e.message; }
    }
    await persist();
    await flushFeedback().catch(() => report(new Error('Decisions are saved locally; feedback delivery is pending and will be retried.')));
    update();
  }
  function schedule(full) {
    if (!enabled()) return;
    if (trackedPaths.has(full)) dirtyPaths.add(full);
    for (const candidate of canonicalPaths.get(full) || []) dirtyPaths.add(candidate);
    if (!dirtyPaths.size) return;
    clearTimeout(timer); timer = setTimeout(() => {
      const paths = new Set(dirtyPaths); dirtyPaths.clear();
      exclusive(() => refresh(paths)).catch(report);
    }, 250);
  }
  async function scheduleDocument(doc) {
    if (!enabled() || doc.uri.scheme !== 'file') return;
    const canonical = await fs.realpath(doc.uri.fsPath).catch(() => path.resolve(doc.uri.fsPath));
    documents.set(doc, canonical); schedule(doc.uri.fsPath); schedule(canonical);
  }
  async function loadArchive() {
    if (archiveLoaded) return;
    try {
      const legacy = path.join(path.dirname(storage.fsPath), 'local-tools.change-review', 'request-review.json');
      const restored = await stateStore.load(legacy, { root: root || null, aliases: folder ? [folder.uri.fsPath] : [] });
      model = new ReviewModel(restored.state);
      archiveLoaded = true;
      const removed = applyPolicy();
      if (restored.issues.length) report(new Error(stateStore.status().issue));
      if (restored.migrated || removed) await persist();
      if (removed) report(new Error('Protected or excluded snapshots were removed from local review storage; current files were kept unchanged.'));
    } catch (error) {
      // Invalid JSON may recover into a new queue after preserving its original.
      // A transient read error must load the existing queue before any mutation.
      if (!stateStore.status().retry) archiveLoaded = true;
      throw error;
    }
  }
  const ready = exclusive(async () => {
    try { await loadArchive(); if (enabled()) await refresh(); else update(); }
    catch (e) { report(new Error(stateStore.status().issue || 'The saved queue could not be loaded or saved. Review remains available; retry after resolving the storage problem.')); }
    update();
  });
  // Keep a rejection handled even if startup is not explicitly awaited by a command.
  ready.catch(() => {});

  const contentChanged = new vscode.EventEmitter();
  context.subscriptions.push(contentChanged,
    vscode.workspace.registerTextDocumentContentProvider('review-base', { onDidChange: contentChanged.event, provideTextDocumentContent(uri) {
      const a = argument(uri); return model.turns.get(a?.turn)?.files.get(a?.path)?.baseline || '';
    } }),
    vscode.workspace.registerTextDocumentContentProvider('review-current', { onDidChange: contentChanged.event, provideTextDocumentContent(uri) {
      const a = argument(uri), f = model.turns.get(a?.turn)?.files.get(a?.path); return f?.expected ?? f?.baseline ?? '';
    } })
  );
  function entryFor(arg) { return entries().find(e => e.turn.key === arg?.turn && e.file.path === arg?.path); }
  function documentEntry(document) {
    if (document.uri.scheme === 'review-current') return entryFor(argument(document.uri));
    if (document.uri.scheme !== 'file') return;
    const matching = entries().filter(e => e.file.path === document.uri.fsPath);
    return matching.find(e => e.turn.key === selected?.turn) || matching[0];
  }
  function hunkRange(doc, hunk) {
    const bom = doc.uri.scheme === 'file' && documentEntry(doc)?.file.expected?.startsWith('\uFEFF') ? 1 : 0;
    const first = Math.min(doc.positionAt(Math.max(0, hunk.newStart - bom)).line, doc.lineCount - 1);
    const last = hunk.kind === 'delete' ? doc.lineCount - 1 : Math.min(doc.positionAt(Math.max(0, hunk.newStart - bom, hunk.newEnd - bom - 1)).line, doc.lineCount - 1);
    return new vscode.Range(first, 0, last, doc.lineAt(last).text.length);
  }
  function decorate() {
    for (const editor of vscode.window.visibleTextEditors) {
      const entry = enabled() && !reviewTab() ? documentEntry(editor.document) : undefined, additions = [], deletions = [];
      if (entry && !entry.file.error && !entry.turn.running) for (const h of entry.hunks) {
        const item = { range: hunkRange(editor.document, h) };
        (h.after && h.kind !== 'delete' ? additions : deletions).push(item);
      }
      editor.setDecorations(inserted, additions); editor.setDecorations(removed, deletions);
      const items = nativeLoaded && !reviewTab() ? controlItems(editor.document) : [];
      editor.setDecorations(controls, items.length ? [{ range: new vscode.Range(0, 0, 0, 0), hoverMessage: new vscode.MarkdownString('<!-- change-review-controls:v1 -->' + JSON.stringify(items)) }] : []);
    }
  }
  function controlItems(document) {
    const entry = enabled() ? documentEntry(document) : undefined;
    if (!entry || entry.file.error || entry.turn.running) return [];
    return entry.hunks.map(hunk => {
      const range = hunkRange(document, hunk);
      return { start: range.start.line + 1, end: range.end.line + 1, arg: { ...keyFor(entry), hunk: hunk.id } };
    });
  }
  function codeLenses(document) {
    if (nativeLoaded || reviewTab()) return [];
    return actions(controlItems(document)).map(item => new vscode.CodeLens(new vscode.Range(item.line, 0, item.line, 0), { title: item.title, command: item.command, arguments: item.arguments }));
  }
  context.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'review-current' }], { onDidChangeCodeLenses: lensesChanged.event, provideCodeLenses: codeLenses }));
  function requireEnabled() { if (!enabled()) throw new Error('Review is disabled. Run Agent Review: Toggle Review or press ⌘⌥⇧R.'); }
  async function show(arg) {
    await ready;
    await loadArchive();
    requireEnabled();
    const entry = entryFor(arg) || entryFor(pendingQueue()[0]);
    if (!entry) {
      vscode.window.showInformationMessage(entries().length ? 'No changes are ready for review. Saved conflicts are available in Agent Review: Review Queue.' : 'No pending changes.');
      return;
    }
    if (entry.file.error && !reviewTab()) { report(new Error(path.basename(entry.file.path) + ': ' + entry.file.error)); return; }
    const hunk = entry.hunks.find(h => h.id === arg?.hunk) || entry.hunks[0];
    outcome = undefined;
    await hideHover();
    selected = { ...keyFor(entry), hunk: hunk?.id }; update();
    if (reviewTab()) { reviewView.show(); return; }
    const right = entry.file.expected === null ? virtual('review-current', selected) : vscode.Uri.file(entry.file.path);
    const doc = await vscode.workspace.openTextDocument(right);
    const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    selected = { ...keyFor(entry), hunk: hunk?.id };
    const oldDiffs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => !t.isDirty && t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === 'review-base');
    if (oldDiffs.length) await vscode.window.tabGroups.close(oldDiffs, true);
    if (hunk) {
      if (editor) {
        const line = Math.min(hunk.newLine - 1, editor.document.lineCount - 1);
        const range = new vscode.Range(line, 0, line, 0); editor.selection = new vscode.Selection(range.start, range.end); editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
    decorate();
  }
  function hover(document, position) {
    if (!enabled() || reviewTab()) return;
    const entry = documentEntry(document);
    if (!entry || entry.turn.running) return;
    if (entry.file.error) {
      const content = new vscode.MarkdownString(); content.appendText('Review paused: ' + entry.file.error);
      return new vscode.Hover(content);
    }
    if (nativeLoaded) return;
    const item = controlItems(document).find(item => item.start <= position.line + 1 && position.line + 1 <= item.end);
    if (item) {
      const md = new vscode.MarkdownString();
      for (const a of actions([item])) md.appendMarkdown(`[${a.title}](command:${a.command}?${encodeURIComponent(JSON.stringify(a.arguments))})  `);
      md.isTrusted = { enabledCommands: ['changeReview.accept', 'changeReview.reject'] };
      return new vscode.Hover(md, new vscode.Range(item.start - 1, 0, item.end - 1, 0));
    }
  }
  context.subscriptions.push(vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'review-current' }], { provideHover: hover }));

  function pendingQueue(turn) {
    return entries().filter(e => (!turn || e.turn.key === turn) && !e.file.error && !e.turn.running).flatMap(e => e.hunks.map(h => ({ ...keyFor(e), hunk: h.id })));
  }
  async function resumeReview(document) {
    if (!enabled() || !vscode.workspace.getConfiguration('changeReview').get('autoOpen', true)) return;
    const entry = document.uri.scheme === 'file'
      ? entries().filter(e => e.file.path === document.uri.fsPath && !e.file.error && !e.turn.running).at(-1)
      : documentEntry(document);
    if (entry && !entry.file.error && !entry.turn.running) await show(pendingQueue(entry.turn.key)[0]);
  }
  async function continueReview(turn, index = 0) {
    const remaining = pendingQueue(turn);
    if (remaining.length) return show(remaining[Math.max(0, index) % remaining.length]);
    const conflicts = entries().filter(e => e.turn.key === turn && e.file.error);
    if (conflicts.length && reviewTab()) return show(keyFor(conflicts[0]));
    selected = undefined; outcome = { message: 'All recorded changes in this request reviewed.' };
    update();
    if (reviewTab() && reviewView.inspect().state) reviewView.show();
    await hideHover();
    const blocked = entries().some(e => e.turn.key === turn);
    vscode.window.showInformationMessage(blocked ? 'All available changes reviewed. This request still has saved conflicts.' : 'All recorded changes in this request reviewed.');
  }

  async function apply(arg, action, advance = true) {
    await ready;
    await loadArchive();
    requireEnabled();
    const entry = entryFor(arg); if (!entry) throw new Error('This change has already been reviewed.');
    const state = await actual(entry.file.path);
    if (entry.file.canonical && entry.file.canonical !== state.canonical) throw new Error('The file path changed through a symbolic link.');
    model.refresh(arg.turn, arg.path, state.text);
    if (entry.file.error) { await persist(); update(); throw new Error(entry.file.error); }
    const nextIndex = pendingQueue(arg.turn).findIndex(a => a.path === arg.path && a.hunk === arg.hunk);
    const result = model.decide(arg.turn, arg.path, arg.revision, arg.hunk, action);
    const previous = { baseline: entry.file.baseline, expected: entry.file.expected };
    if (model.feedback.length >= 10000) throw new Error('Review feedback is full. Restore its delivery before recording more decisions.');
    const id = randomBytes(32).toString('hex');
    const intent = { id, created: Date.now(), action, revision: arg.revision, hunk: arg.hunk, wasDirty: Boolean(state.doc?.isDirty), canonical: state.canonical };
    entry.file.decision = intent;
    try { await persist(); } catch (error) { delete entry.file.decision; throw error; }
    await hideHover();
    owned = true;
    try {
      if (action === 'accept') entry.file.baseline = result.baseline;
      else {
        const again = await actual(arg.path);
        if (again.canonical !== state.canonical || revision(entry.file.baseline, again.text) !== arg.revision) throw new Error('The file changed. Refresh the change.');
        const uri = vscode.Uri.file(arg.path);
        if (result.current === null) {
          if (state.doc?.isDirty) throw new Error('Save the new file first.');
          await io.remove(uri);
        } else if (state.text === null) {
          await fs.mkdir(path.dirname(arg.path), { recursive: true });
          if ((await actual(arg.path)).canonical !== state.canonical) throw new Error('The restore path changed.');
          const edit = new vscode.WorkspaceEdit(); edit.createFile(uri, { contents: Buffer.from(result.current), overwrite: false, ignoreIfExists: false });
          if (!await io.create(edit)) throw new Error('Could not restore the file.');
          await fs.chmod(arg.path, entry.file.mode);
        } else {
          const doc = state.doc || await vscode.workspace.openTextDocument(uri), dirty = doc.isDirty;
          const docText = (state.bom ? '\uFEFF' : '') + doc.getText();
          if (docText !== state.text) throw new Error('The editor buffer changed. Refresh the change.');
          const bom = state.bom ? 1 : 0, h = result.hunk;
          const replacement = h.newStart === 0 && bom && h.before.startsWith('\uFEFF') ? h.before.slice(1) : h.before;
          const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
          const range = new vscode.Range(doc.positionAt(Math.max(0, h.newStart - bom)), doc.positionAt(Math.max(0, h.newEnd - bom)));
          if (state.bom !== result.current.startsWith('\uFEFF')) throw new Error('Changing the BOM requires manual review.');
          const desired = state.bom ? result.current.slice(1) : result.current;
          if (desired.includes('\r\n') && /(^|[^\r])\n/.test(desired)) throw new Error('Mixed line endings require manual review.');
          if ((state.bom ? '\uFEFF' : '') + doc.getText() !== state.text) throw new Error('The editor buffer changed. Refresh the change.');
          const desiredEol = desired.includes('\r\n') ? vscode.EndOfLine.CRLF : desired.includes('\n') ? vscode.EndOfLine.LF : doc.eol;
          if (!await io.edit(editor, edit => { edit.replace(range, replacement); edit.setEndOfLine(desiredEol); })) throw new Error('Could not reject the change.');
          if (doc.getText() !== desired) {
            throw new Error('The editor did not preserve the restored text. The change was not saved.');
          }
          if (!dirty && !await io.save(doc)) throw new Error('The change has not been saved.');
        }
        entry.file.expected = result.current;
      }
      delete entry.file.decision;
      queueFeedback(arg, action, id, intent.created);
      await persist();
    } catch (e) {
      Object.assign(entry.file, previous); entry.file.decision = intent;
      model.feedback = model.feedback.filter(record => record.id !== id);
      const current = await actual(arg.path).catch(() => undefined);
      const changed = action === 'reject' && (!current || current.text !== previous.expected);
      entry.file.error = (changed ? 'Undo may have changed the file or buffer, but its decision was not saved. The original snapshot is retained. ' : 'The decision did not finish. The original snapshot is retained. ') + e.message;
      await persist().catch(() => {});
      throw new Error(entry.file.error);
    } finally { owned = false; update(); }
    await refresh(new Set([arg.path]));
    if (advance) await continueReview(arg.turn, nextIndex);
    return result;
  }
  async function move(arg, direction) {
    requireEnabled();
    const queue = pendingQueue(arg?.turn);
    if (!queue.length) return;
    let index = queue.findIndex(a => a.turn === arg?.turn && a.path === arg?.path && a.hunk === arg?.hunk);
    index = index < 0 ? (direction > 0 ? 0 : queue.length - 1) : (index + direction + queue.length) % queue.length;
    return show(queue[index]);
  }
  async function bulk(arg, action, all = false) {
    requireEnabled();
    const group = entries().filter(e => e.turn.key === arg.turn && (all || e.file.path === arg.path));
    if (!group.length) return;
    for (const e of group) {
      if (e.file.error || e.turn.running) throw new Error(e.file.error || 'The request is still running.');
      if ((await actual(e.file.path)).text !== e.file.expected) throw new Error('A file changed. Refresh the queue first.');
    }
    for (const e of group) while (entryFor(keyFor(e))) {
      const latest = entryFor(keyFor(e)); if (latest.file.error) throw new Error(latest.file.error);
      await apply({ ...keyFor(latest), hunk: latest.hunks[0].id }, action, false);
    }
    await continueReview(arg.turn);
  }
  async function choose() {
    await ready; requireEnabled(); await refresh();
    const choices = entries().map(e => ({ label: (e.file.error ? '$(warning) ' : '$(diff) ') + path.basename(e.file.path), description: `${e.hunks.length} changes · ${new Date(e.turn.created).toLocaleTimeString()} · ${e.turn.id.slice(0, 8)}`, detail: e.file.error || e.file.path, arg: keyFor(e) }));
    if (!choices.length) { vscode.window.showInformationMessage('No pending changes.'); return; }
    const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Changes by request and file' }); if (picked) return show(picked.arg);
  }
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand('changeReview.' + id, (...args) => exclusive(() => fn(...args)).catch(report)));
  register('show', arg => show(arg)); register('queue', choose);
  async function modeChanged() {
    modeStatus.update();
    await hooks?.update();
    if (!enabled()) {
      clearTimeout(timer);
      dirtyPaths.clear();
      reviewView.dispose();
      await hideHover();
      for (const t of model.turns.values()) if (t.running) ignoredTurns.add(t.key);
      update();
    } else await refresh();
  }
  async function setEnabled(value) {
    const config = vscode.workspace.getConfiguration('changeReview');
    const setting = config.inspect('enabled');
    if (!setting) throw new Error('The updated settings are not loaded yet. Run Developer: Reload Window after this request, then toggle review again.');
    const owner = setting.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('enabled', value, owner);
    await modeChanged();
  }
  register('toggle', () => setEnabled(!enabled()));
  register('enable', () => setEnabled(true)); register('disable', () => setEnabled(false));
  async function acceptAll() {
    await loadArchive();
    requireEnabled();
    const readyFiles = entries().filter(e => !e.turn.running && !e.file.error);
    for (const e of readyFiles) while (entryFor(keyFor(e))) {
      const latest = entryFor(keyFor(e));
      if (latest.file.error) throw new Error(latest.file.error);
      await apply({ ...keyFor(latest), hunk: latest.hunks[0].id }, 'accept', false);
    }
    selected = undefined;
    outcome = { paused: entries().length > 0, message: entries().length ? 'All available changes kept. Paused or running reviews remain in the queue.' : 'All available changes kept.' };
    await hideHover();
    update();
    if (entries().length) vscode.window.showInformationMessage('All available changes kept. Running or blocked reviews remain pending.');
  }
  register('acceptAll', acceptAll);
  const decideOnce = decisionGate((arg, action, advance) => exclusive(() => apply(arg, action, advance)));
  for (const action of ['accept', 'reject']) context.subscriptions.push(vscode.commands.registerCommand('changeReview.' + action, arg => decideOnce(arg || selected, action, true).catch(report)));
  register('next', arg => move(arg || selected, 1)); register('previous', arg => move(arg || selected, -1));
  register('fileActions', async arg => {
    arg ||= selected; if (!arg) return;
    const choice = await vscode.window.showQuickPick(['Accept File', 'Reject File', 'Accept Request', 'Reject Request', 'Show Review Queue'], { placeHolder: 'Actions for pending changes' });
    if (choice === 'Show Review Queue') return choose();
    if (choice) return bulk(arg, choice.startsWith('Accept') ? 'accept' : 'reject', choice.endsWith('Request'));
  });
  async function discardSnapshot(key) {
    const previous = model.turns.get(key); if (!previous) return;
    model.turns.delete(key);
    try { await persist(); } catch (error) { model.turns.set(key, previous); throw error; }
    update();
  }
  register('forget', async () => {
    const pick = await vscode.window.showQuickPick([...model.turns.values()].map(t => ({ label: t.id.slice(0, 12), detail: 'Discard the snapshot and keep current files unchanged', turn: t.key })));
    if (pick) await discardSnapshot(pick.turn);
  });
  register('status', async () => vscode.window.showInformationMessage(`Connection: ${!hooks ? 'open one local, trusted workspace folder' : !hooks.status().connected ? 'not configured' : hooks.status().incomplete ? 'incomplete coverage; an invalid lifecycle event was skipped; review affected changes manually' : hooks.status().lastEvent ? 'event delivery observed; an idle session needs no new event' : 'configured; waiting for trusted hooks'}. ${statusDetails(statusState())} Only confirmed apply_patch edits are queued after writing; shell and Python writes require manual review.`));
  async function diagnostics() {
    await ready;
    const [connection, data, stateBytes] = await Promise.all([hooks?.diagnosticState(), hooks?.inspectData(), fs.lstat(cache).then(stat => stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0, () => 0)]);
    const recovery = stateStore.status(), config = vscode.workspace.getConfiguration('changeReview');
    return buildDiagnostics({ extensionVersion: context.extension?.packageJSON.version || require('./package.json').version, editorVersion: vscode.version, nodeVersion: process.versions.node, platform: process.platform, remote: Boolean(vscode.env.remoteName), trusted: vscode.workspace.isTrusted,
      settings: { enabled: enabled(), view: config.get('view', 'review'), autoOpen: config.get('autoOpen', true), exclude: config.get('exclude', []) }, status: statusState(), connection, data, stateBytes,
      recovery: { loaded: archiveLoaded, retryRead: recovery.retry === true, backupPresent: Boolean(recovery.backup), warningOccurred: Boolean(recovery.issue) } });
  }
  register('diagnostics', async () => {
    const report = await diagnostics(), document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) });
    await vscode.window.showTextDocument(document, { preview: false });
  });
  // Connection draining delivers receive() through the review serial queue.
  // Setup must not hold that queue while waiting for those deliveries.
  const registerConnection = (name, work) => context.subscriptions.push(vscode.commands.registerCommand('changeReview.' + name, () => work().catch(report)));
  registerConnection('connect', async () => {
    if (!hooks) throw new Error('Open one local, trusted workspace folder first.');
    await hooks.connect();
    vscode.window.showInformationMessage('Review hooks configured. Restart your session, open /hooks and trust the pending hooks to start recording edits.');
  });
  registerConnection('disconnect', async () => { await hooks?.disconnect(); vscode.window.showInformationMessage('Review hooks disconnected. Saved decisions are preserved.'); });
  async function cleanupData(category) {
    await ready; await exclusive(loadArchive);
    if (!hooks) throw new Error('Open one local, trusted workspace folder first.');
    const result = await hooks.cleanup([category]); let outbox = 0;
    if (category === 'feedback') await exclusive(async () => {
      const previous = model.feedback; outbox = previous.length; model.feedback = [];
      try { await persist(); } catch (error) { model.feedback = previous; throw error; }
    });
    return { ...result, outbox };
  }
  registerConnection('cleanup', async () => {
    await ready; await exclusive(loadArchive);
    if (!hooks) throw new Error('Open one local, trusted workspace folder first.');
    const data = await hooks.inspectData();
    const options = [
      ['temporary', 'Temporary drafts', 'Active writer processes are kept.'],
      ['pending', 'Tool snapshots waiting for PostToolUse', 'Clearing these drops capture for tools that may still be running.'],
      ['events', 'Undelivered lifecycle events', 'Clearing these drops review capture for those recorded events.'],
      ['feedback', 'Undelivered decision summaries', 'Includes summaries saved in the local outbox; reviewed files are kept.'],
      ['quarantine', 'Invalid messages and reasons', 'Removes quarantined payloads and their reason receipts.'],
      ['backups', 'Recovery backups', 'Removes saved hook configuration and corrupt-queue recovery copies.']
    ].map(([category, label, detail]) => ({ category, label, detail, description: `${data.truncated ? 'at least ' : ''}${data.categories[category].files} files, ${data.categories[category].bytes} bytes${category === 'feedback' ? `; ${model.feedback.length} outbox decisions` : ''}` }));
    const pick = await vscode.window.showQuickPick(options, { placeHolder: 'Choose exactly which local data to remove. Project files and unresolved review snapshots are kept.' });
    if (!pick) return;
    if (data.connected && pick.category !== 'temporary') throw new Error('Run Agent Review: Disconnect before clearing retained transport data.');
    const confirmation = await vscode.window.showWarningMessage(`Remove ${pick.label.toLowerCase()}? ${pick.description}. ${pick.detail} Project files and unresolved review snapshots are kept. Each batch scans at most 2048 entries.`, { modal: true }, 'Remove data');
    if (confirmation !== 'Remove data') return;
    const result = await cleanupData(pick.category);
    vscode.window.showInformationMessage(`Removed ${result.removed} local data files${result.outbox ? ` and ${result.outbox} outbox decisions` : ''}. ${result.skippedActive} active drafts kept. ${result.failed} removals failed.${result.truncated ? ' More data may remain; run cleanup again for the next batch.' : ''}`);
  });
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (!editor) return;
    if (reviewTab()) return;
    const a = argument(editor.document.uri);
    if (a && entryFor(a)) selected = a;
    const match = documentEntry(editor.document);
    if (match && !a) selected = { ...keyFor(match), hunk: match.hunks[0]?.id };
    vscode.commands.executeCommand('setContext', 'changeReview.inEditor', enabled() && Boolean(match)); decorate();
    if (resumeOnOpen) {
      resumeOnOpen = false;
      exclusive(() => resumeReview(editor.document)).catch(report);
    }
  }), vscode.workspace.onDidChangeTextDocument(e => { scheduleDocument(e.document).catch(report); }),
    vscode.workspace.onDidSaveTextDocument(d => { scheduleDocument(d).catch(report); }),
    vscode.workspace.onDidOpenTextDocument(d => { scheduleDocument(d).catch(report); }),
    vscode.workspace.onDidCloseTextDocument(d => { const canonical = documents.get(d); documents.delete(d); schedule(d.uri.fsPath); if (canonical) schedule(canonical); }),
    vscode.window.onDidChangeVisibleTextEditors(decorate),
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (!e.kind || !enabled() || reviewTab()) return;
      const entry = documentEntry(e.textEditor.document); if (!entry) return;
      const line = e.selections[0]?.active.line ?? 0;
      const hunk = entry.hunks.filter(h => h.newLine - 1 <= line).at(-1) || entry.hunks[0];
      selected = { ...keyFor(entry), hunk: hunk?.id };
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('changeReview.enabled')) exclusive(modeChanged).catch(report);
      if (e.affectsConfiguration('changeReview.view')) exclusive(async () => { reviewView.dispose(); await refresh(); }).catch(report);
      if (e.affectsConfiguration('changeReview.exclude')) exclusive(async () => {
        const removed = applyPolicy(); await persist(); await hooks?.update(); update();
        if (removed) report(new Error('Protected or excluded snapshots were removed from local review storage; current files were kept unchanged.'));
      }).catch(report);
    }),
    { dispose() { clearTimeout(timer); for (const w of watchers.values()) w.dispose(); } });

  async function receive(event) {
    await ready;
    return exclusive(async () => {
      if (!vscode.workspace.isTrusted) return;
      await loadArchive();
      event = filterEvent(event, root, policy(), aliases());
      const key = event.threadId && event.turnId ? event.threadId + '/' + event.turnId : undefined;
      if (key) latestRequest = requestHistory.use(key);
      if (latestRequest && event.method === 'turn/started') latestRequest.result = 'request-started';
      if (!enabled() || event.skipReview || ignoredTurns.has(key)) {
        if (latestRequest) latestRequest.result = 'skipped-off';
        if (event.method === 'item/completed' && latestRequest) requestHistory.skip(latestRequest, event.itemId);
        if (event.method === 'turn/completed' && latestRequest) latestRequest.reason = 'this request was skipped while review was OFF';
        if (key) ignoredTurns.add(key);
        if (event.method === 'turn/completed') {
          const turn = model.turns.get(key); if (turn) turn.running = false;
          ignoredTurns.delete(key); await persist(); update();
        }
        return;
      }
      const turn = model.receive(event); await persist(); update();
      if (latestRequest && event.method === 'item/completed') latestRequest.result = event.skipReason === 'excluded' ? 'excluded' : event.type === 'commandExecution' ? (event.readOnly ? 'read-only' : 'command-manual') : event.type === 'externalTool' ? 'external-manual' : 'patch-paused';
      if (latestRequest && event.method === 'item/completed' && (event.skipReason === 'excluded' || event.type === 'externalTool' || event.type === 'commandExecution' && !event.readOnly || event.type === 'fileChange' && !['completed', 'succeeded'].includes(event.status))) requestHistory.skip(latestRequest, event.itemId);
      if (event.method === 'item/completed' && event.type === 'fileChange' && ['completed', 'succeeded'].includes(event.status)) {
        const paths = new Set((event.changes || []).map(c => c.path));
        if (entries().some(e => e.turn.key === key && paths.has(e.file.path) && !e.file.error && e.hunks.length)) { lastPatch = Date.now(); if (latestRequest) latestRequest.result = 'patch-confirmed'; }
        if (latestRequest && turn && !turn.running) { latestRequest.reason = 'a late patch was captured for a completed request; open it from the review queue'; latestRequest.result = 'late-patch'; }
      }
      if (event.method === 'turn/completed' && turn) {
        await refresh(new Set(turn.files.keys()));
        if (turn.warnings.some(w => w === 'shell' || w === 'external')) vscode.window.showWarningMessage('This request used commands or external tools. The queue includes only confirmed text patches; review other changes separately.');
        const pending = pendingQueue(turn.key), blocked = entries().filter(e => e.turn.key === turn.key && e.file.error);
        const automatic = vscode.workspace.getConfiguration('changeReview').get('autoOpen', true);
        if (latestRequest) latestRequest.result = pending.length ? 'request-ready' : blocked.length ? 'request-paused' : turn.warnings.includes('excluded') ? 'excluded' : turn.warnings.length ? 'request-incomplete' : 'request-unchanged';
        if (latestRequest) latestRequest.reason = pending.length ? 'ready changes opened' : blocked.length ? 'review paused because changes could not be prepared' : turn.warnings.includes('excluded') ? 'protected or excluded paths require manual review' : turn.warnings.length ? 'no confirmed patches; unsupported writes require manual review' : 'no confirmed text changes';
        if (automatic && pending.length) await show(pending[0]);
        else if (automatic && blocked.length) await show(keyFor(blocked[0]));
        else if (!pending.length && !blocked.length) {
          const unsupported = turn.warnings.length > 0;
          outcome = { paused: unsupported, message: turn.warnings.includes('excluded') ? 'Protected or excluded paths were not captured. Review those changes manually.' : unsupported ? 'No confirmed text patches could be prepared for this request. Review command or unsupported changes manually.' : 'No confirmed text changes in this request.' };
          if (automatic && unsupported && reviewTab()) { selected = undefined; update(); reviewView.show(); }
          else if (reviewView.inspect().visible && automatic) { selected = undefined; update(); }
        }
      }
      modeStatus.update();
    });
  }
  const folders = vscode.workspace.workspaceFolders || [];
  const folder = folders.length === 1 ? folders[0] : undefined;
  let root;
  if (folder?.uri.scheme === 'file' && vscode.workspace.isTrusted) {
    try { root = require('node:fs').realpathSync(folder.uri.fsPath); } catch { report(new Error('The workspace folder is unavailable.')); }
  }
  hooks = root ? createConnection({ storage: storage.fsPath, extensionPath: context.extensionPath, executable: process.execPath, root, receive, enabled, report, exclude: () => vscode.workspace.getConfiguration('changeReview').get('exclude', []), changed: () => modeStatus.update() }) : undefined;
  hooks?.ready.then(() => exclusive(flushFeedback)).catch(() => report(new Error('Saved review feedback is pending; delivery will be retried.')));
  modeStatus.update();
  if (hooks) context.subscriptions.push(hooks);
  const restored = ready.then(() => exclusive(async () => {
    nativeLoaded = (await vscode.commands.getCommands()).includes('_changeReview.nativeInspect');
    update();
    if (!enabled() || !vscode.workspace.getConfiguration('changeReview').get('autoOpen', true) || !pendingQueue().length) return;
    if (reviewTab()) { await show(pendingQueue()[0]); return; }
    const document = vscode.window.activeTextEditor?.document;
    if (document) await resumeReview(document);
    else resumeOnOpen = true;
  }));
  restored.catch(report);
  return { ready: restored, receive, hooks, reviewView, diagnostics, cleanup: cleanupData, getStatus: statusState, getState: () => model.save(), entries, hover, controlItems, codeLenses, isEnabled: enabled, setEnabled: value => exclusive(() => setEnabled(value)), acceptAll: () => exclusive(acceptAll), discardSnapshot: key => exclusive(() => discardSnapshot(key)), show: arg => exclusive(() => show(arg)), refresh: () => exclusive(refresh), decide: (arg, action) => decideOnce(arg, action, false), bulk: (arg, action, all) => exclusive(() => bulk(arg, action, all)) };
}
module.exports = { activate };
