'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { changes, decide, revision } = require('./core');
const { scan, assertSafe, resolveInside, allowed, decode } = require('./files');

function activate(context) {
  let session, panel, watcher, timer, queue = Promise.resolve(), previousPending = false;
  let viewState = { active: false, files: [], skipped: [] };
  const storage = context.storageUri || context.globalStorageUri;
  const cache = path.join(storage.fsPath, 'review-state.json');

  function exclusive(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }
  function report(e) { vscode.window.showErrorMessage('Change Review: ' + e.message); }
  async function canonical(full) {
    let existing = path.resolve(full), suffix = [];
    for (;;) {
      try { return path.join(await fs.realpath(existing), ...suffix); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const parent = path.dirname(existing);
        if (parent === existing) throw e;
        suffix.unshift(path.basename(existing)); existing = parent;
      }
    }
  }
  async function documentFor(full) {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' && await canonical(doc.uri.fsPath) === full) return doc;
    }
  }
  async function documentText(doc, full) {
    let handle;
    try {
      handle = await fs.open(full, 'r');
      const head = Buffer.alloc(3);
      await handle.read(head, 0, 3, 0);
      return (head.equals(Buffer.from([239, 187, 191])) ? '\uFEFF' : '') + doc.getText();
    } catch (e) { if (e.code === 'ENOENT') return doc.getText(); throw e; }
    finally { await handle?.close(); }
  }
  async function documents(root) {
    const entries = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty) continue;
      const full = await canonical(doc.uri.fsPath);
      const relative = path.relative(root, full);
      try { resolveInside(root, relative); } catch { continue; }
      entries.push([full, await documentText(doc, full)]);
    }
    return new Map(entries);
  }
  async function persist() {
    if (!session) return;
    await fs.mkdir(storage.fsPath, { recursive: true, mode: 0o700 });
    const temporary = cache + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ version: 1, id: session.id, root: session.root, active: session.active, baseline: [...session.baseline] }), { mode: 0o600 });
    await fs.rename(temporary, cache);
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => exclusive(refresh).catch(report), 450);
  }
  function watch() {
    watcher?.dispose();
    if (!session?.active) return;
    watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(session.root), '**/*'));
    watcher.onDidChange(schedule); watcher.onDidCreate(schedule); watcher.onDidDelete(schedule);
  }
  function publish() {
    vscode.commands.executeCommand('setContext', 'changeReview.hasChanges', viewState.files.length > 0);
    panel?.webview.postMessage({ type: 'state', ...viewState });
  }
  async function refresh() {
    if (!session) { viewState = { active: false, files: [], skipped: [] }; publish(); return viewState; }
    const current = await scan(session.root, await documents(session.root));
    const excluded = new Set(current.skipped.map(e => e.path));
    const files = [];
    for (const relative of [...new Set([...session.baseline.keys(), ...current.files.keys()])].sort()) {
      if (excluded.has(relative)) continue;
      const before = session.baseline.get(relative) ?? null, after = current.files.get(relative) ?? null;
      if (before === after) continue;
      try {
        const diff = changes(before, after);
        files.push({ path: relative, revision: diff.revision, hunks: diff.hunks });
      } catch (e) { current.skipped.push({ path: relative, reason: e.message }); }
    }
    viewState = { id: session.id, root: session.root, active: session.active, baselineFiles: session.baseline.size, files, skipped: current.skipped };
    const pending = files.length > 0;
    if (pending && !previousPending && vscode.workspace.getConfiguration('changeReview').get('autoOpen', true)) show(true);
    previousPending = pending;
    publish();
    return viewState;
  }
  async function begin(uri) {
    if (!vscode.workspace.isTrusted) throw new Error('Open a trusted workspace folder.');
    const root = await fs.realpath(uri.fsPath);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Select a folder.');
    if (session?.root === root) { session.active = true; watch(); await persist(); return refresh(); }
    const snapshot = await scan(root, await documents(root));
    session = { id: crypto.randomUUID(), root, active: true, baseline: snapshot.files };
    previousPending = false;
    watch();
    await persist();
    return refresh();
  }
  async function start(uri) {
    if (!uri) {
      const configured = vscode.workspace.getConfiguration('changeReview').get('scope', '');
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Review This Folder', defaultUri: configured ? vscode.Uri.file(configured) : vscode.workspace.workspaceFolders?.[0]?.uri });
      if (!picked?.length) return;
      uri = picked[0];
    }
    if (session && viewState.files.length && session.root !== uri.fsPath) {
      const result = await vscode.window.showWarningMessage('There are pending changes. Switching folders keeps current files unchanged and replaces the previous snapshot.', { modal: true }, 'Switch Folder');
      if (!result) return;
    }
    await exclusive(() => begin(uri));
    show(false);
  }
  async function readCurrent(relative) {
    const full = await assertSafe(session.root, relative);
    const doc = await documentFor(full);
    if (doc?.isDirty) return documentText(doc, full);
    try {
      if ((await fs.stat(full)).size > 1024 * 1024) throw new Error('File exceeds 1 MiB.');
      return decode(await fs.readFile(full));
    }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function act(message) {
    if (!session || message.session !== session.id) throw new Error('A different folder is selected. Refresh the list.');
    const full = await assertSafe(session.root, message.path);
    const before = session.baseline.get(message.path) ?? null;
    const after = await readCurrent(message.path);
    const result = decide(before, after, message.revision, message.hunk, message.action);
    if (message.action === 'accept') {
      if (result.baseline === null) session.baseline.delete(message.path);
      else session.baseline.set(message.path, result.baseline);
      try { await persist(); }
      catch (e) { if (before === null) session.baseline.delete(message.path); else session.baseline.set(message.path, before); throw e; }
    } else {
      const uri = vscode.Uri.file(full);
      if (result.current === null) {
        const open = await documentFor(full);
        if (open?.isDirty) throw new Error('The new file has unsaved changes. Save it before rejecting it.');
        if (revision(before, await readCurrent(message.path)) !== message.revision) throw new Error('The file changed. Refresh the list.');
        await vscode.workspace.fs.delete(uri, { useTrash: true, recursive: false });
      } else if (after === null) {
        await fs.mkdir(path.dirname(full), { recursive: true });
        await assertSafe(session.root, message.path);
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uri, { contents: Buffer.from(result.current), overwrite: false, ignoreIfExists: false });
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not restore the file.');
      } else {
        const doc = await documentFor(full) || await vscode.workspace.openTextDocument(uri);
        if (revision(before, await documentText(doc, full)) !== message.revision) throw new Error('The file changed. Refresh the list.');
        const wasDirty = doc.isDirty;
        const edit = new vscode.WorkspaceEdit();
        const bom = after.startsWith('\uFEFF') ? 1 : 0;
        const replacement = result.hunk.newStart === 0 && bom && result.hunk.before.startsWith('\uFEFF') ? result.hunk.before.slice(1) : result.hunk.before;
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(Math.max(0, result.hunk.newStart - bom)), doc.positionAt(Math.max(0, result.hunk.newEnd - bom))), replacement);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not reject the change.');
        if (!wasDirty && !await doc.save()) throw new Error('The change was rejected in the editor, but the file could not be saved.');
      }
    }
    return refresh();
  }
  async function openFile(message) {
    if (!session || session.id !== message.session) return;
    const full = await assertSafe(session.root, message.path);
    if (await readCurrent(message.path) === null) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
    const line = Math.min(Math.max(0, Number(message.line || 1) - 1), doc.lineCount - 1);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true });
  }
  function show(preserveFocus = false) {
    if (panel) { if (!preserveFocus) panel.reveal(vscode.ViewColumn.Active, false); publish(); return; }
    panel = vscode.window.createWebviewPanel('changeReview.review', 'Change Review', { viewColumn: vscode.ViewColumn.Active, preserveFocus }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    panel.iconPath = new vscode.ThemeIcon('diff');
    const web = panel.webview;
    const nonce = crypto.randomBytes(20).toString('hex');
    const js = web.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'review.js'));
    const css = web.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'review.css'));
    web.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Change Review</title></head><body><header><div><h1>Change Review</h1><p id="scope"></p></div><nav><button data-action="refresh">Refresh</button><button data-action="start">Select Folder</button><button data-action="stop">Stop</button></nav></header><p class="hint">Changes are already in the files. Accept keeps a change; Reject restores its previous text. Manual edits in the selected folder are also included.</p><p id="summary" role="status"></p><p id="error" role="alert"></p><main id="files"></main><details id="skipped"><summary>Skipped Files</summary><pre></pre></details><script nonce="${nonce}" src="${js}"></script></body></html>`;
    panel.onDidDispose(() => { panel = undefined; });
    web.onDidReceiveMessage(message => {
      if (!message || typeof message.action !== 'string') return;
      const operations = {
        ready: () => { publish(); }, refresh: () => exclusive(refresh),
        start: () => start(), stop: () => stop(),
        accept: () => exclusive(() => act(message)), reject: () => exclusive(() => act(message)),
        open: () => exclusive(() => openFile(message))
      };
      const operation = Object.hasOwn(operations, message.action) ? operations[message.action] : undefined;
      if (!operation) return;
      Promise.resolve().then(operation).then(() => publish()).catch(async e => {
        web.postMessage({ type: 'error', message: e.message });
        await exclusive(refresh).catch(report);
      });
    });
  }
  async function stop() {
    return exclusive(async () => {
      if (session) { session.active = false; watcher?.dispose(); watcher = undefined; await persist(); }
      await refresh();
    });
  }
  const ready = exclusive(async () => {
    const config = vscode.workspace.getConfiguration('changeReview');
    if (!config.get('autoStart', false) || !vscode.workspace.isTrusted) return;
    try {
      const saved = JSON.parse(await fs.readFile(cache, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.baseline) || saved.baseline.length > 2000) throw new Error('Invalid snapshot.');
      const root = await fs.realpath(saved.root);
      const baseline = new Map();
      let total = 0;
      for (const [relative, text] of saved.baseline) {
        resolveInside(root, relative);
        if (!allowed(relative) || typeof text !== 'string') throw new Error('Invalid snapshot.');
        const bytes = Buffer.from(text);
        total += bytes.length;
        if (total > 20 * 1024 * 1024) throw new Error('Snapshot exceeds 20 MiB.');
        decode(bytes); baseline.set(relative, text);
      }
      session = { id: saved.id, root, active: saved.active, baseline };
      watch(); await refresh();
    } catch (e) {
      if (e.code !== 'ENOENT') { report(new Error('Could not resume the snapshot: ' + e.message)); return; }
      const scope = config.get('scope', '');
      if (scope) await begin(vscode.Uri.file(scope));
    }
  }).catch(report);
  context.subscriptions.push(
    vscode.commands.registerCommand('changeReview.start', async uri => { await ready; return start(uri); }),
    vscode.commands.registerCommand('changeReview.show', async () => { await ready; if (!session) return start(); await exclusive(refresh); show(false); }),
    vscode.commands.registerCommand('changeReview.stop', async () => { await ready; return stop(); }),
    vscode.workspace.onDidChangeTextDocument(e => { if (session?.active && e.document.uri.scheme === 'file') schedule(); }),
    vscode.workspace.onDidSaveTextDocument(() => { if (session?.active) schedule(); }),
    { dispose() { clearTimeout(timer); watcher?.dispose(); panel?.dispose(); } }
  );
  return { ready, getState: () => viewState, start: uri => exclusive(() => begin(uri)), refresh: () => exclusive(refresh), decide: m => exclusive(() => act(m)), stop };
}

module.exports = { activate };
