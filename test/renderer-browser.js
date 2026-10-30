'use strict';
// Attach to the isolated test editor without navigating its workbench.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { chromium } = require(process.env.REVIEW_PLAYWRIGHT_MODULE || 'playwright-core');
async function main() {
  const ready = JSON.parse(await fs.readFile(process.argv[2] || '/tmp/review-renderer-ready.json', 'utf8'));
  const base = 'http://127.0.0.1:' + ready.port, output = path.resolve('output/playwright/review'); await fs.mkdir(output, { recursive: true });
  const request = async (route, body) => { const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert.ok(response.ok, result.error); return result; };
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + ready.debugPort), page = browser.contexts()[0].pages().find(p => p.url().includes('workbench.html'));
  assert.ok(page, 'Attach only to the isolated editor workbench'); page.setDefaultTimeout(8000);
  const { outer, holder, element: handle, session: webSession } = await require('./browser-surface')(browser, page);
  const state = () => request('/state');
  async function waitFor(predicate, label) {
    const end = Date.now() + 8000;
    while (Date.now() < end) { const current = await state(); if (current.view.rendered === current.view.state.id && !current.view.state.busy && predicate(current)) return current; await new Promise(resolve => setTimeout(resolve, 15)); }
    assert.fail(label);
  }
  async function click(action) { const old = (await state()).view.state.id, start = performance.now(); await (await handle('button[data-action="' + action + '"]')).click(); const result = await waitFor(s => s.view.state.id > old, 'Native ' + action + ' did not reach the extension'); return { result, elapsed_ms: performance.now() - start }; }
  async function styleSmoke() {
    const value = await holder.evaluate(frame => {
      const d = frame.contentDocument, w = frame.contentWindow, row = d.querySelector('.code-block'), added = d.querySelector('.added .marker'), removed = d.querySelector('.removed .marker');
      return { display: w.getComputedStyle(row).display, background: w.getComputedStyle(d.body).backgroundColor, added: w.getComputedStyle(added).color, removed: w.getComputedStyle(removed).color, scroll: w.getComputedStyle(d.getElementById('code')).overflowY };
    });
    assert.equal(value.display, 'grid', 'The real stylesheet must load'); assert.equal(value.scroll, 'auto');
    const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number), green = rgb(value.added), red = rgb(value.removed);
    assert.ok(green[1] > green[0] && green[1] > green[2], 'Added text marker must be green'); assert.ok(red[0] > red[1] && red[0] > red[2], 'Removed text marker must be red'); return value;
  }
  const initial = await waitFor(s => s.view.ready, 'Webview did not initialize'), initialStyles = await styleSmoke();
  const stylesheet = await holder.evaluate(frame => frame.contentDocument.querySelector('link[rel="stylesheet"]').href);
  await holder.evaluate(frame => { const link = frame.contentDocument.querySelector('link[rel="stylesheet"]'); link.href += '.missing'; });
  for (let i = 0; i < 200 && await holder.evaluate(frame => frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector('.code-block')).display === 'grid'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(styleSmoke(), /stylesheet|grid/, 'A broken CSS URL must make the smoke red');
  await holder.evaluate((frame, href) => { frame.contentDocument.querySelector('link[rel="stylesheet"]').href = href; }, stylesheet);
  for (let i = 0; i < 200 && !await holder.evaluate(frame => frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector('.code-block')).display === 'grid'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  await styleSmoke();
  // The browser input goes through the real webview, postMessage and extension.
  await click('next'); let current = await state(); assert.equal(current.view.state.fileChangeIndex, initial.view.state.fileChangeIndex === 1 ? 2 : 1);
  const acceptedIndex = current.view.state.fileChangeIndex;
  await click('accept'); current = await state(); assert.equal(current.view.state.fileChangeCount, 1); assert.equal(current.disk, current.after, 'Keep does not write the source');
  assert.equal(await holder.evaluate(frame => frame.contentDocument.activeElement?.dataset.action), 'accept', 'Keyboard focus survives Keep');
  await click('reject'); current = await state(); assert.equal(current.view.state.complete, true);
  assert.equal(current.disk, current.before.replace(acceptedIndex === 1 ? 'old first' : 'old last', acceptedIndex === 1 ? 'new first' : 'new last'), 'Undo affects exactly the selected remaining block');
  await request('/seed', {}); await waitFor(s => s.view.state.fileChangeCount === 2, 'Reseed failed');
  // Trusted keyboard input, including physical keys with RU/Option characters.
  const input = await page.context().newCDPSession(page);
  const macKeyboard = await holder.evaluate(frame => /Mac/.test(frame.contentWindow.navigator.platform));
  await (await handle('button[data-action="previous"]')).focus();
  for (const expected of ['next', 'reject', 'accept', 'code']) {
    await page.keyboard.press('Tab');
    assert.equal(await holder.evaluate(frame => { const active = frame.contentDocument.activeElement; return active.dataset.action || active.id; }), expected, 'Tab order must reach all review controls and source');
  }
  const keyboard = [];
  for (const key of ['y', '¥', 'н']) {
    await (await handle('#code')).focus();
    const old = (await state()).view.state.id;
    const keyEvent = { modifiers: macKeyboard ? 5 : 3, key, code: 'KeyY', windowsVirtualKeyCode: 89, ...(macKeyboard ? { nativeVirtualKeyCode: 16 } : {}) };
    await input.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyEvent });
    await input.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent });
    current = await waitFor(s => s.view.state.id > old && s.view.state.fileChangeCount === 1, 'Physical keyboard input failed: ' + key);
    assert.equal(current.disk, current.after); keyboard.push({ key, code: 'KeyY', kept: 1 });
    await request('/seed', {}); await waitFor(s => s.view.state.fileChangeCount === 2, 'Reseed failed');
  }
  await (await handle('button[data-action="accept"]')).focus();
  let old = (await state()).view.state.id;
  await page.keyboard.down('Enter'); await page.keyboard.down('Enter');
  current = await waitFor(s => s.view.state.id > old && s.view.state.fileChangeCount === 1, 'Enter did not resolve exactly one block');
  await page.keyboard.down('Enter'); await page.keyboard.up('Enter');
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal((await state()).view.state.fileChangeCount, 1, 'Held Enter must not resolve the next block');
  await page.keyboard.press('Space'); await waitFor(s => s.view.state.complete, 'Space did not activate the focused Keep button');
  await request('/seed', {}); await waitFor(s => s.view.state.fileChangeCount === 2, 'Reseed failed');
  const matrix = [];
  await page.setViewportSize({ width: 1800, height: 1100 });
  for (const theme of ['Default Dark Modern', 'Default Light Modern', 'Default High Contrast', 'Default High Contrast Light']) {
    await request('/theme?name=' + encodeURIComponent(theme), {});
    const expected = theme === 'Default Dark Modern' ? 'vscode-dark' : theme === 'Default Light Modern' ? 'vscode-light' : theme.endsWith('Light') ? 'vscode-high-contrast-light' : 'vscode-high-contrast';
    for (let i = 0; i < 100 && !await holder.evaluate((frame, expected) => frame.contentDocument.body.classList.contains(expected), expected); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await holder.evaluate((frame, expected) => frame.contentDocument.body.classList.contains(expected), expected), true);
    const colors = await styleSmoke();
    for (const width of [320, 420, 900]) for (const zoom of [1, 2]) {
      await outer.evaluate((frame, width) => { frame.style.setProperty('width', width + 'px', 'important'); frame.style.setProperty('height', '700px', 'important'); }, width);
      for (let i = 0; i < 100 && await holder.evaluate(frame => frame.contentWindow.innerWidth) !== width; i++) await new Promise(resolve => setTimeout(resolve, 20));
      await holder.evaluate((frame, zoom) => { frame.contentDocument.body.style.zoom = String(zoom); }, zoom);
      const geometry = await holder.evaluate(frame => {
        const d = frame.contentDocument, width = frame.contentWindow.innerWidth, header = d.querySelector('header'), code = d.getElementById('code');
        code.scrollTop = code.scrollHeight;
        return { width, headerTop: header.getBoundingClientRect().top, headerBottom: header.getBoundingClientRect().bottom, buttons: [...d.querySelectorAll('button')].map(button => { const r = button.getBoundingClientRect(); return { action: button.dataset.action, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }), scrolled: code.scrollTop > 0, bodyWidth: d.body.getBoundingClientRect().width };
      });
      assert.equal(geometry.width, width); assert.equal(geometry.headerTop, 0); assert.ok(geometry.scrolled);
      for (const b of geometry.buttons) { assert.ok(b.left >= 0 && b.right <= width + 1, JSON.stringify({ theme, width, zoom, button: b })); assert.ok(b.height >= 20 && b.bottom <= geometry.headerBottom + 1); }
      matrix.push({ theme, width, zoom, colors, geometry });
    }
  }
  await outer.evaluate(frame => { frame.style.setProperty('width', '900px', 'important'); }); await holder.evaluate(frame => { frame.contentDocument.body.style.zoom = '1'; });
  for (let i = 0; i < 100 && await holder.evaluate(frame => frame.contentWindow.innerWidth) !== 900; i++) await new Promise(resolve => setTimeout(resolve, 20));
  const lastCharacter = await holder.evaluate(frame => {
    const d = frame.contentDocument, code = d.getElementById('code'), source = [...d.querySelectorAll('.source')].at(-1), text = source.firstChild;
    code.scrollTop = code.scrollHeight; code.scrollLeft = code.scrollWidth;
    const range = d.createRange(); range.setStart(text, text.length - 1); range.setEnd(text, text.length);
    const r = range.getBoundingClientRect(), bounds = code.getBoundingClientRect();
    return { text: range.toString(), left: r.left, right: r.right, top: r.top, bottom: r.bottom, bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }, horizontal: code.scrollLeft > 0 };
  });
  assert.equal(lastCharacter.text, 'Ω'); assert.ok(lastCharacter.horizontal);
  assert.ok(lastCharacter.left >= lastCharacter.bounds.left && lastCharacter.right <= lastCharacter.bounds.right && lastCharacter.top >= lastCharacter.bounds.top && lastCharacter.bottom <= lastCharacter.bounds.bottom, JSON.stringify(lastCharacter));
  const tree = await webSession.send('Page.getFrameTree');
  const ax = await webSession.send('Accessibility.getFullAXTree', { frameId: tree.frameTree.childFrames[0].frame.id });
  const names = ax.nodes.filter(n => !n.ignored && n.name?.value).map(n => n.name.value);
  assert.ok(names.some(name => name === 'Change 1 of 2')); assert.ok(names.some(name => name.startsWith('Added text'))); assert.ok(names.some(name => name.startsWith('Removed text')));
  assert.ok(!names.some(name => /^\d+(?:\n\d+){5}/.test(name)), 'Decorative line numbers must be absent from AX');
  await page.screenshot({ path: path.join(output, 'review.png') });
  const result = { passed: true, broken_css_negative: true, real_keep_undo: true, focus: true, keyboard, enter_space_repeat: true, lastCharacter, themes_and_geometry: matrix, ax_nodes: ax.nodes.length, initialStyles };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2)); await request('/finish', result);
  console.log(JSON.stringify({ passed: true, matrix_cases: matrix.length, ax_nodes: ax.nodes.length, report: path.join(output, 'results.json') }));
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
