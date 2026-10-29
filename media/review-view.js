'use strict';
(() => {
  const api = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  let state, waiting = false, contentKey, focusKey;
  const hunks = new Map();
  function send(action, hunk) {
    if (!state || waiting || state.busy) return;
    waiting = true;
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    api.postMessage({ action, id: state.id, ...(hunk ? { hunk } : {}) });
  }
  function renderFile(next) {
    const code = byId('code'), key = JSON.stringify([next.arg?.turn, next.arg?.path, next.arg?.revision, next.complete]);
    if (key !== contentKey) {
      const scroll = { top: code.scrollTop, left: code.scrollLeft };
      code.replaceChildren(); hunks.clear();
      let hasText = false;
      for (const block of next.blocks || []) {
        let parent = code;
        if (block.hunk) {
          if (!hunks.has(block.hunk)) {
            const node = document.createElement('section'); node.className = 'hunk'; node.dataset.hunk = block.hunk;
            const anchor = document.createElement('div'); anchor.className = 'change-anchor';
            node.append(anchor); code.append(node); hunks.set(block.hunk, { node, anchor });
          }
          parent = hunks.get(block.hunk).node;
        }
        if (!block.text) continue;
        hasText = true;
        const count = (block.text.match(/\n/g) || []).length + (block.text.endsWith('\n') ? 0 : 1);
        const end = block.text.endsWith('\n') ? '\n' : '';
        const row = document.createElement('div'); row.className = 'code-block ' + block.kind;
        const number = document.createElement('pre'); number.className = 'number';
        number.textContent = Array.from({ length: count }, (_, i) => String(block.line + i)).join('\n') + end;
        const marker = document.createElement('pre'); marker.className = 'marker';
        marker.textContent = block.kind === 'context' ? '' : Array(count).fill(block.kind === 'added' ? '+' : '−').join('\n') + end;
        const text = document.createElement('pre'); text.className = 'source'; text.textContent = block.text;
        row.append(number, marker, text); parent.append(row);
      }
      if (!hasText && !next.complete) {
        const empty = document.createElement('p'); empty.className = 'empty-file'; empty.textContent = 'Empty file'; code.append(empty);
      }
      code.scrollTop = scroll.top; code.scrollLeft = scroll.left;
      contentKey = key;
    }
    for (const [id, hunk] of hunks) hunk.node.classList.toggle('selected', id === next.arg?.hunk);
    const selectedKey = JSON.stringify([next.arg?.turn, next.arg?.path, next.arg?.hunk]);
    if (selectedKey !== focusKey) {
      const current = hunks.get(next.arg?.hunk);
      if (current) current.anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
      else { code.scrollTop = 0; code.scrollLeft = 0; }
      focusKey = selectedKey;
    }
  }
  function render(next) {
    state = next; waiting = false;
    byId('path').textContent = next.path || 'Review complete';
    byId('path').title = next.path || '';
    byId('counter').textContent = next.error ? 'Review paused' : `${next.fileChangeIndex} / ${next.fileChangeCount}`;
    byId('counter').title = `Change ${next.fileChangeIndex} of ${next.fileChangeCount} in this file · File ${next.fileIndex} of ${next.fileCount}`;
    byId('navigation').hidden = Boolean(next.complete);
    byId('actions').hidden = Boolean(next.complete);
    byId('error').textContent = next.error ? `${next.error} Showing the saved snapshot; decisions are paused until the conflict is resolved.` : '';
    byId('error').hidden = !next.error;
    byId('empty').hidden = !next.complete;
    byId('empty').textContent = next.pending ? 'No more changes in this request.' : 'All changes reviewed.';
    byId('change').hidden = Boolean(next.complete);
    renderFile(next);
    document.querySelectorAll('button').forEach(button => {
      const action = button.dataset.action;
      button.disabled = Boolean(next.busy || next.complete || next.error || (['next', 'previous'].includes(action) && next.total < 2));
    });
    api.postMessage({ action: 'rendered', id: next.id });
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (button) { if (!button.disabled) send(button.dataset.action); return; }
    const hunk = event.target.closest('[data-hunk]');
    if (hunk && hunk.dataset.hunk !== state?.arg?.hunk && !state?.error) {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) send('select', hunk.dataset.hunk);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.target.matches('input, textarea, select') || state?.error || state?.complete) return;
    const modifier = /Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    const action = event.altKey && modifier && !event.shiftKey ? { y: 'accept', n: 'reject' }[key] : event.altKey && !modifier ? { ']': 'next', '[': 'previous' }[key] : undefined;
    if (action) { event.preventDefault(); if (!event.repeat) send(action); }
  });
  window.addEventListener('message', event => { if (event.data?.type === 'state') render(event.data); });
  api.postMessage({ action: 'ready' });
})();
