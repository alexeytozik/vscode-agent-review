'use strict';
const api = acquireVsCodeApi();
const files = document.getElementById('files');
const error = document.getElementById('error');
let current;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, file, hunk) {
  const node = element('button', text, action === 'reject' ? 'reject' : '');
  node.dataset.action = action;
  if (file) node.dataset.path = file.path;
  if (hunk) node.dataset.hunk = hunk.id;
  return node;
}
function code(text, className) {
  if (!text) return null;
  const node = element('pre', text.length > 80000 ? text.slice(0, 80000) + '\n… Open the file to see its full content.' : text, className);
  return node;
}
function render(state) {
  current = state;
  const scroll = window.scrollY;
  const scope = document.getElementById('scope');
  scope.textContent = state.root || 'No folder selected';
  scope.title = scope.textContent;
  const count = state.files.reduce((sum, f) => sum + f.hunks.length, 0);
  document.getElementById('summary').textContent = state.root ? `${state.active ? 'Watching' : 'Watching stopped'} · Changed files: ${state.files.length} · Changes: ${count}` : 'Select a folder before editing files.';
  files.replaceChildren();
  if (state.root && !state.files.length) files.append(element('p', 'No pending changes. New edits in this folder will appear here.', 'empty'));
  for (const file of state.files) {
    const section = element('section');
    const heading = element('div', undefined, 'file-heading');
    heading.append(element('h2', file.path), button('Open File', 'open', file));
    section.append(heading);
    for (const hunk of file.hunks) {
      const block = element('article', undefined, 'hunk');
      const controls = element('div', undefined, 'hunk-heading');
      const label = hunk.kind === 'create' ? 'New file' : hunk.kind === 'delete' ? 'Deleted file' : `Line ${hunk.newLine}`;
      controls.append(element('span', label), button('Accept', 'accept', file, hunk), button('Reject', 'reject', file, hunk));
      block.append(controls);
      for (const node of [code(hunk.contextBefore, 'context'), code(hunk.before, 'removed'), code(hunk.after, 'added'), code(hunk.contextAfter, 'context')]) if (node) block.append(node);
      if (!hunk.before && !hunk.after) block.append(element('p', 'Empty file', 'empty'));
      section.append(block);
    }
    files.append(section);
  }
  const skipped = document.getElementById('skipped');
  skipped.hidden = !state.skipped?.length;
  skipped.querySelector('pre').textContent = (state.skipped || []).map(e => `${e.path}: ${e.reason}`).join('\n');
  document.querySelectorAll('button').forEach(b => { b.disabled = false; });
  window.scrollTo(0, scroll);
}
document.addEventListener('click', event => {
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  const file = current?.files.find(f => f.path === target.dataset.path);
  const hunk = file?.hunks.find(h => h.id === target.dataset.hunk);
  error.textContent = '';
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  api.postMessage({ action: target.dataset.action, session: current?.id, path: file?.path, revision: file?.revision, hunk: hunk?.id, line: hunk?.newLine || 1 });
});
window.addEventListener('message', event => {
  if (event.data.type === 'state') render(event.data);
  if (event.data.type === 'error') {
    error.textContent = event.data.message;
    document.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
});
api.postMessage({ action: 'ready' });
