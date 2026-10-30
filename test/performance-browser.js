'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { chromium } = require(process.env.REVIEW_PLAYWRIGHT_MODULE || 'playwright-core');
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
async function main() {
  const ready = JSON.parse(await fs.readFile(process.argv[2], 'utf8')), base = 'http://127.0.0.1:' + ready.port, destination = path.resolve(process.env.REVIEW_PERFORMANCE_REPORT || 'output/validation/r22-renderer-before.json');
  const request = async (route, body) => { const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const value = await response.json(); assert.ok(response.ok, value.error); return value; };
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + ready.debugPort), page = browser.contexts()[0].pages().find(page => page.url().includes('workbench.html')); assert.ok(page); page.setDefaultTimeout(30000);
  const { holder, element, session: webSession } = await require('./browser-surface')(browser, page);
  async function waitFor(predicate, label) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { const state = await request('/state'); if (state.view.ready && state.view.rendered === state.view.state?.id && !state.view.state.busy && predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(label);
  }
  async function paint() { return holder.evaluate(frame => new Promise(resolve => frame.contentWindow.requestAnimationFrame(() => frame.contentWindow.requestAnimationFrame(() => resolve(Date.now()))))); }
  await waitFor(state => state.view.state?.fileChangeCount === 100, 'Initial performance fixture did not render');
  await webSession.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await webSession.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
  await holder.evaluate(frame => {
    const w = frame.contentWindow; w.reviewLongTasks = [];
    new w.PerformanceObserver(list => { for (const entry of list.getEntries()) w.reviewLongTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ entryTypes: ['longtask'] });
  });
  async function action(name) {
    const previous = await request('/state'), start = performance.now(); await (await element('button[data-action="' + name + '"]')).click();
    const state = await waitFor(state => state.view.state.id > previous.view.state.id && (['accept', 'reject'].includes(name) ? state.view.state.complete || state.view.state.contentId !== previous.view.state.contentId : state.view.state.path !== previous.view.state.path || state.view.state.fileChangeIndex !== previous.view.state.fileChangeIndex), 'Action failed: ' + name); await paint(); return { elapsed: performance.now() - start, state };
  }
  const cases = [];
  for (const name of ['hunks-100', 'hunks-1000', 'long-line', 'newlines', 'repeated', 'queue-20']) {
    await holder.evaluate(frame => { frame.contentWindow.reviewLongTasks.length = 0; });
    const startMetrics = await metrics(), start = performance.now(), seeded = await request('/seed?case=' + name, {});
    const state = await waitFor(state => state.fixture === name, 'Fixture did not render: ' + name); const paintedAt = await paint();
    assert.ok(!state.view.state.error, state.view.state.error); assert.ok(!state.view.state.complete);
    if (name.startsWith('hunks-')) assert.equal(state.view.state.fileChangeCount, Number(name.slice(6)));
    if (name === 'long-line') assert.equal(seeded.fileBytes[0], 1024 * 1024);
    if (name === 'queue-20') { assert.equal(seeded.fileBytes.length, 20); assert.ok(seeded.queueBytes > 34 * 1024 * 1024); }
    const reachability = await holder.evaluate(frame => {
      const d = frame.contentDocument, code = d.getElementById('code'), sources = [...d.querySelectorAll('.source')], total = sources.reduce((sum, source) => sum + source.textContent.length, 0), probes = [];
      for (const source of [sources[0], sources[Math.floor(sources.length / 2)], sources.at(-1)]) {
        const text = source.firstChild; if (!text?.length) continue;
        for (const offset of [0, Math.floor((text.length - 1) / 2), text.length - 1]) {
          const range = d.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
          let bounds = code.getBoundingClientRect(), rect = range.getBoundingClientRect(); code.scrollTop += rect.top - bounds.top - bounds.height / 2; code.scrollLeft += rect.left - bounds.left - bounds.width / 2;
          bounds = code.getBoundingClientRect(); rect = range.getBoundingClientRect(); probes.push({ offset, character: range.toString(), visible: rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1, height: rect.height });
        }
      }
      return { total, probes, scrollHeight: code.scrollHeight, scrollWidth: code.scrollWidth, sourceNodes: sources.length };
    });
    assert.equal(reachability.total, state.view.state.projectionCharacters); assert.ok(reachability.probes.every(probe => probe.visible), JSON.stringify({ name, reachability }));
    const endMetrics = await metrics(), longTasks = await holder.evaluate(frame => [...frame.contentWindow.reviewLongTasks]);
    const result = { name, seeded, capture_to_paint_ms: paintedAt - seeded.captureAt, request_to_paint_ms: performance.now() - start, render: { layout_ms: (endMetrics.LayoutDuration - startMetrics.LayoutDuration) * 1000, layout_count: endMetrics.LayoutCount - startMetrics.LayoutCount, heap_bytes: endMetrics.JSHeapUsedSize, host_memory: state.hostMemory, dom: await webSession.send('Memory.getDOMCounters'), long_tasks: longTasks }, reachability, latency: {} };
    const counts = { next: name.startsWith('hunks-') ? 100 : name === 'long-line' || name === 'newlines' ? 0 : name === 'queue-20' ? 40 : 10, accept: name.startsWith('hunks-') ? 5 : 0, reject: name.startsWith('hunks-') ? 5 : name === 'long-line' || name === 'newlines' ? 1 : 0 }, visited = new Set([state.view.state.path]);
    // Reused editor documents emit a deferred filesystem refresh after reseed.
    // Capture/paint above includes setup; decision samples start after it settles.
    await new Promise(resolve => setTimeout(resolve, 350));
    for (const [name, count] of Object.entries(counts)) {
      const values = []; for (let i = 0; i < count; i++) { const sample = await action(name); values.push(sample.elapsed); if (sample.state.view.state.path) visited.add(sample.state.view.state.path); }
      if (values.length) result.latency[name] = { samples: values.length, p50_ms: percentile(values, .5), p95_ms: percentile(values, .95), max_ms: Math.max(...values) };
    }
    if (name === 'queue-20') assert.equal(visited.size, 20, 'Every queued file must be reachable');
    result.files_visited = visited.size;
    const verify = await request('/verify');
    if (name === 'long-line' || name === 'newlines') assert.equal(verify.disk, verify.before, 'Undo must restore exact original bytes');
    else if (counts.reject === 0) assert.equal(verify.disk, verify.after);
    result.verified_disk = verify; cases.push(result); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, JSON.stringify({ passed: false, complete: false, cases }, null, 2));
    console.log(JSON.stringify({ case: name, capture_to_paint_ms: result.capture_to_paint_ms, layout_ms: result.render.layout_ms, heap_bytes: result.render.heap_bytes, long_tasks: longTasks.length, latency: result.latency }));
  }
  const result = { passed: true, complete: true, scope: 'Real isolated VS Code webview; native input through host guards; CDP layout/heap refer to webview renderer target. Latencies include CDP click, host acknowledgement polling and two animation frames.', cases };
  await fs.writeFile(destination, JSON.stringify(result, null, 2)); await request('/finish', result); console.log('Report: ' + destination);
}
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
