'use strict';
// Deterministic transport/diff workload; timings are host-only, not browser latency.
const { performance } = require('node:perf_hooks');
const core = require('../core');
let diffCalls = 0;
const calculate = core.changes;
core.changes = (...args) => { diffCalls++; return calculate(...args); };
const { ReviewModel } = require('../review-model');
const { viewState, createReviewView } = require('../review-view');
const before = 'before\n' + 'unchanged line abcdefghijklmnopqrstuvwxyz\n'.repeat(20000) + 'end\n';
const after = before.replace('before\n', 'after\n').replace('end\n', 'END\n');
async function transport() {
  const entry = { turn: { key: 'request', running: false }, file: { path: '/workspace/file.txt', baseline: before, expected: after }, ...calculate(before, after) };
  let selected = { turn: 'request', path: entry.file.path, hunk: entry.hunks[0].id }, count = 0, bytes = 0, full = 0, projections = 0;
  const web = { cspSource: 'local:', asWebviewUri: u => u, onDidReceiveMessage() {}, postMessage(value) { count++; bytes += Buffer.byteLength(JSON.stringify(value)); if (value.blocks) full++; return Promise.resolve(true); } };
  const panel = { webview: web, visible: true, reveal() {}, onDidDispose() {}, dispose() {} };
  const vscode = { window: { createWebviewPanel() { return panel; } }, Uri: { joinPath: (...v) => v.join('/') }, ViewColumn: { Active: 1 }, ThemeIcon: class {} };
  const view = createReviewView(vscode, { extensionUri: 'root' }, includeBlocks => {
    if (includeBlocks !== false) projections++;
    return viewState([entry], selected, '/workspace', includeBlocks);
  }, async () => {
    selected = { ...selected, hunk: selected.hunk === entry.hunks[0].id ? entry.hunks[1].id : entry.hunks[0].id }; view.update();
  });
  view.show(); await view.receive({ action: 'ready' }); count = bytes = full = projections = 0;
  const start = performance.now();
  for (let i = 0; i < 100; i++) await view.receive({ action: 'next', id: view.inspect().state.id });
  console.log(JSON.stringify({ probe: 'transport', file_bytes: Buffer.byteLength(after), hunks: entry.hunks.length, navigation_clicks: 100, state_messages: count, full_messages: full, projections, serialized_bytes: bytes, elapsed_ms: +(performance.now() - start).toFixed(2) }));
}
function entries() {
  for (const count of [1, 5, 20]) {
    const files = Array.from({ length: count }, (_, i) => ({ path: '/workspace/' + i + '.txt', mode: 0o644, baseline: before, expected: after }));
    const model = new ReviewModel({ version: 2, turns: [{ key: 't/r', id: 'r', threadId: 't', created: 1, warnings: [], seen: [], files }] });
    model.entries(); diffCalls = 0; const start = performance.now();
    for (let i = 0; i < 10; i++) model.entries();
    const elapsed = performance.now() - start;
    console.log(JSON.stringify({ probe: 'entries', files: count, snapshot_bytes: Buffer.byteLength(JSON.stringify(model.save())), entries_calls: 10, diff_calls: diffCalls, elapsed_ms: +elapsed.toFixed(2) }));
  }
}
(async () => { await transport(); entries(); })().catch(error => { console.error(error); process.exitCode = 1; });
