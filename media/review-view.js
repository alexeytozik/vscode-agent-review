'use strict';
(() => {
  const api = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  let state, waiting = false, contentKey, focusKey, content, newest = 0, requestedContent, decisionFocus;
  const hunks = new Map();
  function* chunks(block) {
    if (!block.text) { yield { ...block, count: 0, chunked: false }; return; }
    let start = 0, offset = 0, line = block.line, count = 0;
    while (offset < block.text.length) {
      const end = block.text.indexOf('\n', offset);
      offset = end < 0 ? block.text.length : end + 1; count++;
      if (count === 1024 || offset === block.text.length) {
        yield { ...block, text: block.text.slice(start, offset), line, count, chunked: start > 0 || offset < block.text.length };
        line += count; start = offset; count = 0;
      }
    }
  }
  function send(action, hunk) {
    if (!state || waiting || state.busy) return;
    if (['accept', 'reject'].includes(action)) decisionFocus = document.activeElement || byId('code');
    waiting = true;
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    api.postMessage({ action, id: state.id, ...(hunk ? { hunk } : {}) });
  }
  function renderFile(next) {
    const code = byId('code'), key = JSON.stringify([next.arg?.turn, next.arg?.path, next.arg?.revision, next.complete]);
    if (key !== contentKey) {
      const scroll = { top: code.scrollTop, left: code.scrollLeft };
      code.replaceChildren(); hunks.clear();
      const hunkIds = [...new Set((next.blocks || []).filter(block => block.hunk).map(block => block.hunk))];
      let hasText = false;
      for (const block of (next.blocks || []).flatMap(block => [...chunks(block)])) {
        let parent = code;
        if (block.hunk) {
          if (!hunks.has(block.hunk)) {
            const node = document.createElement('section'); node.className = 'hunk'; node.dataset.hunk = block.hunk;
            node.setAttribute('role', 'group'); node.setAttribute('aria-label', `Change ${hunkIds.indexOf(block.hunk) + 1} of ${hunkIds.length}`);
            const anchor = document.createElement('div'); anchor.className = 'change-anchor';
            node.append(anchor); code.append(node); hunks.set(block.hunk, { node, anchor });
          }
          parent = hunks.get(block.hunk).node;
        }
        if (!block.text) continue;
        hasText = true;
        const count = block.count;
        const end = block.text.endsWith('\n') ? '\n' : '';
        const row = document.createElement('div'); row.className = 'code-block ' + block.kind + (block.chunked ? ' render-chunk' : '');
        if (block.chunked) row.style.setProperty('--review-lines', String(count));
        row.setAttribute('role', 'group'); row.setAttribute('aria-label', `${{ added: 'Added text', removed: 'Removed text', context: 'Unchanged text' }[block.kind]}, line ${block.line}`);
        const number = document.createElement('pre'); number.className = 'number';
        number.setAttribute('aria-hidden', 'true');
        number.textContent = Array.from({ length: count }, (_, i) => String(block.line + i)).join('\n') + end;
        const marker = document.createElement('pre'); marker.className = 'marker';
        marker.setAttribute('aria-hidden', 'true');
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
    for (const [id, hunk] of hunks) { hunk.node.classList.toggle('selected', id === next.arg?.hunk); hunk.node.setAttribute('aria-current', id === next.arg?.hunk ? 'true' : 'false'); }
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
    byId('path').textContent = next.path || (next.outcome?.paused ? 'Review unavailable' : 'Review complete');
    byId('path').title = next.path || '';
    const kind = { create: 'New file', delete: 'Deleted file' }[next.kind] || '';
    byId('kind').textContent = kind; byId('kind').hidden = !kind;
    byId('counter').textContent = next.error ? 'Review paused' : `${next.fileChangeIndex} / ${next.fileChangeCount}`;
    const counter = `Change ${next.fileChangeIndex} of ${next.fileChangeCount} in ${next.path || 'this file'} · File ${next.fileIndex} of ${next.fileCount}${next.blocked ? ` · ${next.blocked} paused files in this request` : ''}`;
    byId('counter').title = counter; byId('counter').setAttribute('aria-label', next.error ? `Review paused in ${next.path}. ${counter}` : counter);
    byId('navigation').hidden = Boolean(next.complete);
    byId('actions').hidden = Boolean(next.complete);
    byId('error').textContent = next.error ? `${next.error} Showing the saved snapshot; decisions are paused until the conflict is resolved.` : '';
    byId('error').hidden = !next.error;
    byId('empty').hidden = !next.complete;
    byId('empty').textContent = next.outcome?.message || (next.pending ? 'No more changes in this request.' : 'All changes reviewed.');
    byId('change').hidden = Boolean(next.complete);
    renderFile(next);
    document.querySelectorAll('button').forEach(button => {
      const action = button.dataset.action;
      const navigation = ['next', 'previous'].includes(action);
      button.disabled = Boolean(next.busy || next.complete || (navigation ? !(next.canNavigate ?? (!next.error && next.total > 1)) : next.error));
    });
    if (!next.busy && decisionFocus) {
      const target = next.complete ? byId('empty') : decisionFocus.isConnected && !decisionFocus.disabled ? decisionFocus : byId('code');
      if (!document.activeElement || document.activeElement === document.body || document.activeElement === decisionFocus) target.focus({ preventScroll: true });
      decisionFocus = undefined;
    }
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
    if (event.repeat && ['Enter', ' '].includes(event.key) && event.target.matches('button[data-action]')) { event.preventDefault(); return; }
    if (event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph') || event.target.isContentEditable || event.target.matches('input, textarea, select') || event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || state?.complete) return;
    const mac = /Mac/.test(navigator.platform), modifier = mac ? event.metaKey : event.ctrlKey;
    if (!event.altKey || event.shiftKey || (mac ? event.ctrlKey : event.metaKey)) return;
    const physical = modifier ? { KeyY: 'accept', KeyN: 'reject' } : { BracketRight: 'next', BracketLeft: 'previous' };
    const fallback = !event.code || event.code === 'Unidentified';
    const action = physical[event.code] || (fallback ? (modifier ? { y: 'accept', n: 'reject' } : { ']': 'next', '[': 'previous' })[event.key.toLowerCase()] : undefined);
    if (action && !(state?.error && ['accept', 'reject'].includes(action))) { event.preventDefault(); if (!event.repeat) send(action); }
  });
  window.addEventListener('message', event => {
    const next = event.data;
    if (next?.type !== 'state' || next.id < newest) return;
    newest = next.id;
    if (Array.isArray(next.blocks)) {
      content = { id: next.contentId, blocks: next.blocks }; requestedContent = undefined;
    } else if (!content || content.id !== next.contentId) {
      waiting = true;
      document.querySelectorAll('button').forEach(button => { button.disabled = true; });
      if (requestedContent !== next.contentId) { requestedContent = next.contentId; api.postMessage({ action: 'resync' }); }
      return;
    }
    render({ ...next, blocks: content.blocks });
  });
  api.postMessage({ action: 'ready' });
})();
