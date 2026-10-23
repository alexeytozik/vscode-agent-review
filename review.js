'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReviewModel } = require('./review-model');
const { changes, revision } = require('./core');
const { decode } = require('./files');
const { createModeStatus } = require('./mode-status');
const { actions, decisionGate } = require('./public-controls');
const { createConnection } = require('./hook-connection');

function activate(context) {
  let model = new ReviewModel(), serial = Promise.resolve(), selected, timer, owned = false, resumeOnOpen = false;
  const ignoredTurns = new Set();
  const enabled = () => vscode.workspace.getConfiguration('changeReview').get('enabled', true);
  const modeStatus = createModeStatus(vscode, enabled);
  context.subscriptions.push(modeStatus);
  const inserted = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground') });
  const removed = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground') });
  const lensesChanged = new vscode.EventEmitter();
  context.subscriptions.push(inserted, removed, lensesChanged);
  const watchers = new Map();
  const storage = context.storageUri || context.globalStorageUri;
  const cache = path.join(storage.fsPath, 'request-review.json');
  const report = e => vscode.window.showWarningMessage('Agent Review: ' + e.message);
  const exclusive = fn => { const job = serial.then(fn); serial = job.catch(() => {}); return job; };
  const keyFor = e => ({ turn: e.turn.key, path: e.file.path, revision: e.revision });
  const virtual = (scheme, arg) => vscode.Uri.from({ scheme, path: arg.path, query: JSON.stringify({ turn: arg.turn }) });
  function argument(uri) { try { return { path: uri.fsPath || uri.path, turn: JSON.parse(uri.query).turn }; } catch { return; } }
  function entries() { return model.entries().sort((a, b) => a.turn.created - b.turn.created || a.file.path.localeCompare(b.file.path)); }
  async function persist() {
    await fs.mkdir(storage.fsPath, { recursive: true, mode: 0o700 });
    const data = JSON.stringify(model.save());
    if (Buffer.byteLength(data) > 40 * 1024 * 1024) throw new Error('Saved snapshots exceed 40 MiB. Finish reviewing older requests.');
    await fs.writeFile(cache + '.tmp', data, { mode: 0o600 }); await fs.rename(cache + '.tmp', cache);
  }
  async function actual(full) {
    let bytes;
    try {
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Symbolic links and special files cannot be changed.');
      if (stat.size > 1024 * 1024) throw new Error('File exceeds 1 MiB.');
      bytes = await fs.readFile(full); decode(bytes);
    } catch (e) { if (e.code === 'ENOENT') bytes = null; else throw e; }
    let existing = full, suffix = [], canonical;
    for (;;) {
      try { canonical = path.join(await fs.realpath(existing), ...suffix); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; const parent = path.dirname(existing); if (parent === existing) throw e; suffix.unshift(path.basename(existing)); existing = parent; }
    }
    let doc;
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme !== 'file') continue;
      const resolved = await fs.realpath(d.uri.fsPath).catch(() => path.resolve(d.uri.fsPath));
      if (resolved === canonical) { doc = d; break; }
    }
    const bom = bytes?.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
    return { text: doc?.isDirty ? (bom ? '\uFEFF' : '') + doc.getText() : bytes === null ? null : bytes.toString('utf8'), disk: bytes, doc, canonical, bom: Boolean(bom) };
  }
  function update() {
    modeStatus.update();
    const pending = entries();
    vscode.commands.executeCommand('setContext', 'changeReview.enabled', enabled());
    vscode.commands.executeCommand('setContext', 'changeReview.hasPending', enabled() && pending.length > 0);
    vscode.commands.executeCommand('setContext', 'changeReview.inEditor', enabled() && Boolean(selected && pending.some(e => e.turn.key === selected.turn && e.file.path === selected.path)));
    for (const t of model.turns.values()) for (const f of t.files.values()) {
      const arg = { turn: t.key, path: f.path }; contentChanged.fire(virtual('review-base', arg)); contentChanged.fire(virtual('review-current', arg));
    }
    for (const e of enabled() ? pending : []) {
      if (!watchers.has(e.file.path)) {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(e.file.path), path.basename(e.file.path)));
        w.onDidChange(schedule); w.onDidCreate(schedule); w.onDidDelete(schedule); watchers.set(e.file.path, w);
      }
    }
    const tracked = new Set(enabled() ? pending.map(e => e.file.path) : []);
    for (const [full, w] of watchers) if (!tracked.has(full)) { w.dispose(); watchers.delete(full); }
    decorate(); lensesChanged.fire();
  }
  async function hideHover() {
    if ((await vscode.commands.getCommands(true)).includes('editor.action.hideHover')) await vscode.commands.executeCommand('editor.action.hideHover');
  }
  async function refresh() {
    for (const entry of entries()) {
      try {
        const state = await actual(entry.file.path);
        if (entry.file.canonical && entry.file.canonical !== state.canonical) throw new Error('The file path changed through a symbolic link. Automatic rejection was stopped.');
        model.refresh(entry.turn.key, entry.file.path, state.text);
      }
      catch (e) { entry.file.error = e.message; }
    }
    await persist(); update();
  }
  function schedule() { if (owned || !enabled()) return; clearTimeout(timer); timer = setTimeout(() => exclusive(refresh).catch(report), 250); }
  const ready = exclusive(async () => {
    try {
      let source = cache;
      if (!await fs.stat(cache).catch(() => false)) {
        const legacy = path.join(path.dirname(storage.fsPath), 'local-tools.change-review', 'request-review.json');
        if (await fs.stat(legacy).catch(() => false)) source = legacy;
      }
      const stat = await fs.stat(source); if (stat.size > 40 * 1024 * 1024) throw new Error('Saved snapshot exceeds the size limit.');
      model = new ReviewModel(JSON.parse(await fs.readFile(source, 'utf8')));
      if (source !== cache) await persist();
      if (enabled()) await refresh(); else update();
    } catch (e) { if (e.code !== 'ENOENT') { report(e); throw e; } }
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
      const entry = enabled() ? documentEntry(editor.document) : undefined, additions = [], deletions = [];
      if (entry && !entry.file.error && !entry.turn.running) for (const h of entry.hunks) {
        const item = { range: hunkRange(editor.document, h) };
        (h.after && h.kind !== 'delete' ? additions : deletions).push(item);
      }
      editor.setDecorations(inserted, additions); editor.setDecorations(removed, deletions);

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
    return actions(controlItems(document)).map(item => new vscode.CodeLens(new vscode.Range(item.line, 0, item.line, 0), { title: item.title, command: item.command, arguments: item.arguments }));
  }
  context.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'review-current' }], { onDidChangeCodeLenses: lensesChanged.event, provideCodeLenses: codeLenses }));
  function requireEnabled() { if (!enabled()) throw new Error('Review is disabled. Run Agent Review: Toggle Review or press ⌘⌥⇧R.'); }
  async function show(arg) {
    await ready;
    requireEnabled();
    const entry = entryFor(arg) || entryFor(pendingQueue()[0]);
    if (!entry) {
      vscode.window.showInformationMessage(entries().length ? 'No changes are ready for review. Saved conflicts are available in Agent Review: Review Queue.' : 'No pending changes.');
      return;
    }
    if (entry.file.error) { report(new Error(path.basename(entry.file.path) + ': ' + entry.file.error)); return; }
    const hunk = entry.hunks.find(h => h.id === arg?.hunk) || entry.hunks[0];
    await hideHover();
    selected = { ...keyFor(entry), hunk: hunk?.id }; update();
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
    if (!enabled()) return;
    const entry = documentEntry(document);
    if (!entry || entry.turn.running) return;
    if (entry.file.error) {
      const content = new vscode.MarkdownString(); content.appendText('Review paused: ' + entry.file.error);
      return new vscode.Hover(content);
    }
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
    selected = undefined;
    update();
    await hideHover();
    const blocked = entries().some(e => e.turn.key === turn);
    vscode.window.showInformationMessage(blocked ? 'All available changes reviewed. This request still has saved conflicts.' : 'All recorded changes in this request reviewed.');
  }

  async function apply(arg, action, advance = true) {
    await ready;
    requireEnabled();
    const entry = entryFor(arg); if (!entry) throw new Error('This change has already been reviewed.');
    const state = await actual(entry.file.path);
    if (entry.file.canonical && entry.file.canonical !== state.canonical) throw new Error('The file path changed through a symbolic link.');
    model.refresh(arg.turn, arg.path, state.text);
    if (entry.file.error) { await persist(); update(); throw new Error(entry.file.error); }
    const nextIndex = pendingQueue(arg.turn).findIndex(a => a.path === arg.path && a.hunk === arg.hunk);
    const result = model.decide(arg.turn, arg.path, arg.revision, arg.hunk, action);
    const previous = { baseline: entry.file.baseline, expected: entry.file.expected };
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
          await vscode.workspace.fs.delete(uri, { useTrash: true, recursive: false });
        } else if (state.text === null) {
          await fs.mkdir(path.dirname(arg.path), { recursive: true });
          if ((await actual(arg.path)).canonical !== state.canonical) throw new Error('The restore path changed.');
          const edit = new vscode.WorkspaceEdit(); edit.createFile(uri, { contents: Buffer.from(result.current), overwrite: false, ignoreIfExists: false });
          if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not restore the file.');
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
          const originalText = doc.getText(), originalEol = doc.eol;
          const desiredEol = desired.includes('\r\n') ? vscode.EndOfLine.CRLF : desired.includes('\n') ? vscode.EndOfLine.LF : originalEol;
          if (!await editor.edit(edit => { edit.replace(range, replacement); edit.setEndOfLine(desiredEol); })) throw new Error('Could not reject the change.');
          if (doc.getText() !== desired) {
            await editor.edit(edit => { edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), originalText); edit.setEndOfLine(originalEol); });
            throw new Error('The editor did not preserve the restored text. The change was not saved.');
          }
          if (!dirty && !await doc.save()) throw new Error('The change has not been saved.');
        }
        entry.file.expected = result.current;
      }
      await persist();
      await hooks?.decision(arg, action).catch(report);
    } catch (e) {
      if (action === 'accept') Object.assign(entry.file, previous);
      throw e;
    } finally { owned = false; update(); }
    await refresh();
    if (advance) await continueReview(arg.turn, nextIndex);
    return result;
  }
  async function move(arg, direction) {
    requireEnabled();
    const queue = pendingQueue(arg?.turn);
    if (!queue.length) return;
    let index = queue.findIndex(a => a.turn === arg?.turn && a.path === arg?.path && a.hunk === arg?.hunk);
    index = (index + direction + queue.length) % queue.length;
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
    requireEnabled();
    for (const t of model.turns.values()) if (!t.running) for (const f of t.files.values()) { f.baseline = f.expected; delete f.error; }
    selected = undefined;
    await hideHover();
    await persist(); update();
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
  register('forget', async () => {
    const pick = await vscode.window.showQuickPick([...model.turns.values()].map(t => ({ label: t.id.slice(0, 12), detail: 'Discard the snapshot and keep current files unchanged', turn: t.key })));
    if (pick) { model.turns.delete(pick.turn); await persist(); update(); }
  });
  register('status', async () => vscode.window.showInformationMessage(`Connection: ${hooks?.status().lastEvent ? 'receiving events' : hooks?.status().connected ? 'configured; waiting for trusted hooks' : 'not configured'}. Pending files: ${entries().length}.`));
  register('connect', async () => {
    if (!hooks) throw new Error('Open one local, trusted workspace folder first.');
    await hooks.connect();
    vscode.window.showInformationMessage('Review hooks configured. Restart your session, open /hooks and trust the pending hooks to start recording edits.');
  });
  register('disconnect', async () => { await hooks?.disconnect(); vscode.window.showInformationMessage('Review hooks disconnected. Saved decisions are preserved.'); });
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (!editor) return;
    const a = argument(editor.document.uri);
    if (a && entryFor(a)) selected = a;
    const match = documentEntry(editor.document);
    if (match && !a) selected = { ...keyFor(match), hunk: match.hunks[0]?.id };
    vscode.commands.executeCommand('setContext', 'changeReview.inEditor', enabled() && Boolean(match)); decorate();
    if (resumeOnOpen) {
      resumeOnOpen = false;
      exclusive(() => resumeReview(editor.document)).catch(report);
    }
  }), vscode.workspace.onDidChangeTextDocument(e => { if (entries().some(a => a.file.path === e.document.uri.fsPath)) schedule(); }),
    vscode.workspace.onDidSaveTextDocument(d => { if (entries().some(a => a.file.path === d.uri.fsPath)) schedule(); }),
    vscode.window.onDidChangeVisibleTextEditors(decorate),
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (!e.kind || !enabled()) return;
      const entry = documentEntry(e.textEditor.document); if (!entry) return;
      const line = e.selections[0]?.active.line ?? 0;
      const hunk = entry.hunks.filter(h => h.newLine - 1 <= line).at(-1) || entry.hunks[0];
      selected = { ...keyFor(entry), hunk: hunk?.id };
    }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('changeReview.enabled')) exclusive(modeChanged).catch(report); }),
    { dispose() { clearTimeout(timer); for (const w of watchers.values()) w.dispose(); } });

  async function receive(event) {
    await ready;
    return exclusive(async () => {
      if (!vscode.workspace.isTrusted) return;
      const key = event.threadId && event.turnId ? event.threadId + '/' + event.turnId : undefined;
      if (!enabled() || event.skipReview || ignoredTurns.has(key)) {
        if (key) ignoredTurns.add(key);
        if (event.method === 'turn/completed') {
          const turn = model.turns.get(key); if (turn) turn.running = false;
          ignoredTurns.delete(key); await persist(); update();
        }
        return;
      }
      const turn = model.receive(event); await persist(); update();
      if (event.method === 'turn/completed' && turn) {
        await refresh();
        if (turn.warnings.some(w => w === 'shell' || w === 'external')) vscode.window.showWarningMessage('This request used commands or external tools. The queue includes only confirmed text patches; review other changes separately.');
        const pending = pendingQueue().filter(e => e.turn === turn.key);
        if (pending.length && vscode.workspace.getConfiguration('changeReview').get('autoOpen', true)) {
          await show(pending[0]);
        }
      }
    });
  }
  const folders = vscode.workspace.workspaceFolders || [];
  const folder = folders.length === 1 ? folders[0] : undefined;
  let root;
  if (folder?.uri.scheme === 'file' && vscode.workspace.isTrusted) {
    try { root = require('node:fs').realpathSync(folder.uri.fsPath); } catch { report(new Error('The workspace folder is unavailable.')); }
  }
  const hooks = root ? createConnection({ storage: storage.fsPath, extensionPath: context.extensionPath, executable: process.execPath, root, receive, enabled, report }) : undefined;
  if (hooks) context.subscriptions.push(hooks);
  const restored = ready.then(() => exclusive(async () => {
    decorate();
    if (!enabled() || !vscode.workspace.getConfiguration('changeReview').get('autoOpen', true) || !pendingQueue().length) return;
    const document = vscode.window.activeTextEditor?.document;
    if (document) await resumeReview(document);
    else resumeOnOpen = true;
  }));
  restored.catch(report);
  return { ready: restored, receive, hooks, getState: () => model.save(), entries, hover, controlItems, codeLenses, isEnabled: enabled, setEnabled: value => exclusive(() => setEnabled(value)), acceptAll: () => exclusive(acceptAll), show: arg => exclusive(() => show(arg)), refresh: () => exclusive(refresh), decide: (arg, action) => decideOnce(arg, action, false), bulk: (arg, action, all) => exclusive(() => bulk(arg, action, all)) };
}
module.exports = { activate };
