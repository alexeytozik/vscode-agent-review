'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const vscode = require('vscode');
const { createPatch } = require('diff');
const hash = text => createHash('sha256').update(text).digest('hex');
function data(name) {
  if (name === 'long-line') { const prefix = 'a'.repeat(1024 * 1024 - 2); return [{ before: prefix + 'x\n', after: prefix + 'y\n' }]; }
  if (name === 'newlines') { const prefix = '\n'.repeat(512 * 1024 - 8); return [{ before: prefix + 'old\n', after: prefix + 'new\n' }]; }
  if (name === 'repeated') { const middle = 'repeated line\n'.repeat(6000); return [{ before: 'old first\n' + middle + 'old last\n', after: 'new first\n' + middle + 'new last\n' }]; }
  if (name === 'queue-20') return Array.from({ length: 20 }, (_, index) => {
    const size = Math.floor(34 * 1024 * 1024 / 40), line = 'context-' + index + '-' + 'u'.repeat(117) + '\n', context = line.repeat(Math.floor((size - 20) / line.length));
    return { before: 'old first\n' + context + 'old last\n', after: 'new first\n' + context + 'new last\n' };
  });
  const count = { 'hunks-100': 100, 'hunks-1000': 1000 }[name]; if (!count) throw new Error('Unknown performance fixture.');
  return [{ before: Array.from({ length: count }, (_, i) => 'keep-' + i + '\nold-' + i + '\nkeep-tail-' + i + '\n').join(''), after: Array.from({ length: count }, (_, i) => 'keep-' + i + '\nnew-' + i + '\nkeep-tail-' + i + '\n').join('') }];
}
module.exports = { run: async () => {
  let server, timer;
  try {
    const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath), api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready;
    let sequence = 0, captureAt, seedElapsed, queueBytes, files = [], fixture;
    async function seed(name) {
      for (const turn of api.getState().turns) await api.discardSnapshot(turn.key);
      fixture = name; files = data(name).map((file, index) => ({ ...file, path: path.join(root, 'performance-' + index + '.txt') }));
      for (const file of files) {
        const doc = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === file.path);
        if (doc) { const editor = await vscode.window.showTextDocument(doc); await editor.edit(edit => edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), file.after)); await doc.save(); }
        else await fs.writeFile(file.path, file.after);
      }
      const turnId = 'request-' + ++sequence; captureAt = Date.now(); const start = performance.now();
      await api.receive({ method: 'turn/started', threadId: 'performance', turnId });
      for (const [index, file] of files.entries()) await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'performance', turnId, itemId: 'edit-' + index, changes: [{ path: file.path, kind: { type: 'update' }, diff: createPatch(file.path, file.before, file.after), snapshot: { disk: file.after, text: file.after, mode: 0o644, canonical: file.path } }] });
      await api.receive({ method: 'turn/completed', threadId: 'performance', turnId });
      seedElapsed = performance.now() - start; queueBytes = Buffer.byteLength(JSON.stringify(api.getState()));
      return { fixture, captureAt, seedElapsed, queueBytes, fileBytes: files.map(file => Buffer.byteLength(file.after)) };
    }
    let finish, abort; const completed = new Promise((resolve, reject) => { finish = resolve; abort = reject; timer = setTimeout(() => reject(new Error('Performance browser check timed out')), 15 * 60 * 1000); });
    server = http.createServer(async (req, res) => {
      try {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/state') {
          const view = api.reviewView.inspect(), state = view.state;
          res.end(JSON.stringify({ fixture, view: { ready: view.ready, rendered: view.rendered, state: state && { id: state.id, busy: state.busy, error: state.error, complete: state.complete, fileChangeCount: state.fileChangeCount, fileChangeIndex: state.fileChangeIndex, path: state.path, contentId: state.contentId, blocks: state.blocks.length, projectionCharacters: state.blocks.reduce((sum, block) => sum + block.text.length, 0) } }, captureAt, seedElapsed, queueBytes, hostMemory: process.memoryUsage() }));
        } else if (req.url.startsWith('/seed?') && req.method === 'POST') res.end(JSON.stringify(await seed(new URL(req.url, 'http://localhost').searchParams.get('case'))));
        else if (req.url === '/verify') {
          const current = api.reviewView.inspect().state, file = files.find(file => path.basename(file.path) === current?.path) || files[0];
          res.end(JSON.stringify({ disk: hash(await fs.readFile(file.path, 'utf8')), before: hash(file.before), after: hash(file.after), sourceCharacters: file.after.length }));
        } else if (req.url === '/abort' && req.method === 'POST') { res.end('{}'); abort(new Error('Browser validation failed.')); }
        else if (req.url === '/finish' && req.method === 'POST') { const chunks = []; for await (const chunk of req) chunks.push(chunk); const result = JSON.parse(Buffer.concat(chunks)); assert.equal(result.passed, true); res.end('{}'); finish(result); }
        else { res.statusCode = 404; res.end('{}'); }
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    });
    await seed('hunks-100');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const ready = { port: server.address().port, debugPort: Number(process.env.REVIEW_DEBUG_PORT), root };
    await fs.writeFile(process.env.REVIEW_RENDERER_READY_FILE + '.tmp', JSON.stringify(ready)); await fs.rename(process.env.REVIEW_RENDERER_READY_FILE + '.tmp', process.env.REVIEW_RENDERER_READY_FILE); console.log('Performance ready: ' + JSON.stringify(ready));
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify(await completed));
  } catch (error) { await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error; }
  finally { clearTimeout(timer); await new Promise(resolve => server ? server.close(resolve) : resolve()); }
} };
