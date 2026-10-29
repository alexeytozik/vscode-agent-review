'use strict';
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { lines } = require('./core');

function fileBlocks(entry) {
  const text = entry.file.expected ?? '', blocks = [];
  let offset = 0, line = 1;
  for (const hunk of entry.hunks) {
    const context = text.slice(offset, hunk.newStart);
    if (context) blocks.push({ kind: 'context', line, text: context });
    blocks.push({ kind: 'removed', line: hunk.oldLine, text: hunk.before, hunk: hunk.id });
    blocks.push({ kind: 'added', line: hunk.newLine, text: hunk.after, hunk: hunk.id });
    offset = hunk.newEnd; line = hunk.newLine + lines(hunk.after).length;
  }
  if (offset < text.length) blocks.push({ kind: 'context', line, text: text.slice(offset) });
  return blocks;
}

function viewState(entries, selected, root) {
  const entry = entries.find(e => e.turn.key === selected?.turn && e.file.path === selected?.path);
  if (!entry) return { complete: true, pending: entries.length, blocks: [] };
  const hunk = entry.hunks.find(h => h.id === selected.hunk) || entry.hunks[0];
  const request = entries.filter(e => e.turn.key === entry.turn.key && !e.turn.running);
  const queue = request.filter(e => !e.file.error).flatMap(e => e.hunks.map(h => ({ path: e.file.path, id: h.id })));
  const arg = { turn: entry.turn.key, path: entry.file.path, revision: entry.revision, hunk: hunk?.id };
  const relative = root && path.relative(root, entry.file.canonical || entry.file.path);
  const displayPath = relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? relative : path.basename(entry.file.path);
  return {
    complete: false, pending: entries.length,
    path: displayPath,
    fileIndex: request.indexOf(entry) + 1, fileCount: request.length,
    fileChangeIndex: entry.hunks.indexOf(hunk) + 1, fileChangeCount: entry.hunks.length,
    index: queue.findIndex(h => h.path === entry.file.path && h.id === hunk?.id) + 1, total: queue.length,
    kind: hunk?.kind, error: entry.file.error || (entry.turn.running ? 'This request is still running.' : undefined),
    arg, blocks: fileBlocks(entry)
  };
}

function createReviewView(vscode, context, state, run) {
  let panel, current, generation = 0, busy = false, ready = false, rendered;
  function publish(error) {
    if (!panel) return;
    current = { ...state(), id: ++generation, busy, ...(error ? { error } : {}) };
    Promise.resolve(panel.webview.postMessage({ type: 'state', ...current })).catch(() => {});
  }
  async function receive(message) {
    if (!panel || !message || typeof message !== 'object') return false;
    if (message.action === 'ready') { ready = true; publish(); return true; }
    if (message.action === 'rendered') {
      if (message.id === current?.id) rendered = message.id;
      return true;
    }
    const actions = ['accept', 'reject', 'next', 'previous', 'select'];
    if (!actions.includes(message.action)) throw new Error('Unknown review action.');
    if (busy) return false;
    if (message.id !== current?.id) { publish(); return false; }
    if (!current.arg || current.error) throw new Error(current.error || 'No change selected.');
    let arg = current.arg;
    if (message.action === 'select') {
      if (typeof message.hunk !== 'string' || !current.blocks.some(block => block.hunk === message.hunk)) throw new Error('This change is no longer available.');
      arg = { ...arg, hunk: message.hunk };
    }
    busy = true; publish();
    let failure;
    try { await run(message.action, arg); }
    catch (error) { failure = error.message; throw error; }
    finally { busy = false; publish(failure); }
    return true;
  }
  function show() {
    if (panel) { panel.reveal(undefined, false); publish(); return; }
    panel = vscode.window.createWebviewPanel('changeReview.review', 'Agent Review', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    panel.iconPath = new vscode.ThemeIcon('diff');
    const web = panel.webview, nonce = randomBytes(20).toString('hex');
    const js = web.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'review-view.js'));
    const css = web.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'review-view.css'));
    web.onDidReceiveMessage(message => receive(message).catch(error => publish(error.message)));
    panel.onDidDispose(() => { panel = undefined; ready = false; rendered = undefined; current = undefined; });
    web.html = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"><title>Agent Review</title></head><body>
<header><div class="location"><span id="path"></span></div>
<nav id="navigation" aria-label="Review navigation">
<button data-action="previous" title="Previous change (Alt+[)" aria-label="Previous change">‹</button>
<span id="counter" role="status"></span>
<button data-action="next" title="Next change (Alt+])" aria-label="Next change">›</button>
</nav>
<div id="actions" class="actions"><button data-action="reject" class="undo" title="Undo change (Cmd/Ctrl+Alt+N)"><span aria-hidden="true">×</span> Undo</button>
<button data-action="accept" class="keep" title="Keep change (Cmd/Ctrl+Alt+Y)"><span aria-hidden="true">✓</span> Keep</button></div></header>
<p id="error" role="alert" hidden></p><main><div id="empty" role="status" hidden></div>
<section id="change" aria-label="File changes"><div id="code" tabindex="0" aria-label="File contents"></div>
</section></main>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    publish();
  }
  return {
    show, update: publish,
    dispose() { panel?.dispose(); },
    inspect: () => ({ visible: Boolean(panel?.visible), ready, rendered, state: current }),
    receive
  };
}
module.exports = { viewState, createReviewView };
