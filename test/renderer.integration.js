'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const vscode = require('vscode');
const { createPatch } = require('diff');
module.exports = { run: async () => {
  let server, timer;
  try {
    const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
    const api = await vscode.extensions.getExtension('alexeytozik.agent-review').activate(); await api.ready;
    const full = path.join(root, 'browser.txt'), before = 'old first\n' + 'unchanged line\n'.repeat(5000) + 'old last\n' + 'x'.repeat(20000) + 'Ω';
    const after = before.replace('old first', 'new first').replace('old last', 'new last');
    let sequence = 0, captureTime;
    async function seed() {
      for (const turn of api.getState().turns) await api.discardSnapshot(turn.key);
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === full);
      if (doc) { const editor = await vscode.window.showTextDocument(doc); await editor.edit(edit => edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), after)); await doc.save(); }
      else await fs.writeFile(full, after);
      const turnId = 'request-' + ++sequence; captureTime = Date.now();
      await api.receive({ method: 'item/completed', type: 'fileChange', status: 'completed', threadId: 'browser', turnId, itemId: 'edit', changes: [{ path: full, kind: { type: 'update' }, diff: createPatch(full, before, after), snapshot: { disk: after, text: after, mode: 0o644, canonical: full } }] });
      await api.receive({ method: 'turn/completed', threadId: 'browser', turnId });
    }
    await seed();
    let finish, abort;
    const completed = new Promise((resolve, reject) => { finish = resolve; abort = reject; timer = setTimeout(() => reject(new Error('Renderer browser check timed out')), 10 * 60 * 1000); });
    server = http.createServer(async (req, res) => {
      try {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/state') res.end(JSON.stringify({ view: api.reviewView.inspect(), status: api.getStatus(), disk: await fs.readFile(full, 'utf8'), before, after, captureTime }));
        else if (req.url === '/seed' && req.method === 'POST') { await seed(); res.end('{}'); }
        else if (req.url.startsWith('/theme?') && req.method === 'POST') {
          const value = new URL(req.url, 'http://localhost').searchParams.get('name');
          if (!['Default Dark Modern', 'Default Light Modern', 'Default High Contrast', 'Default High Contrast Light'].includes(value)) throw new Error('Unknown test theme');
          await vscode.workspace.getConfiguration('workbench').update('colorTheme', value, vscode.ConfigurationTarget.Global); res.end('{}');
        } else if (req.url === '/abort' && req.method === 'POST') { res.end('{}'); abort(new Error('Browser validation failed.')); }
        else if (req.url === '/finish' && req.method === 'POST') {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert.equal(result.passed, true);
          res.end('{}'); finish(result);
        } else { res.statusCode = 404; res.end('{}'); }
      } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const ready = { port: server.address().port, debugPort: Number(process.env.REVIEW_DEBUG_PORT), root };
    await fs.writeFile(process.env.REVIEW_RENDERER_READY_FILE + '.tmp', JSON.stringify(ready)); await fs.rename(process.env.REVIEW_RENDERER_READY_FILE + '.tmp', process.env.REVIEW_RENDERER_READY_FILE); console.log('Renderer ready: ' + JSON.stringify(ready));
    const result = await completed;
    await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify(result));
  } catch (error) { await fs.writeFile(process.env.REVIEW_RESULT_FILE, JSON.stringify({ passed: false, error: error.stack })); throw error; }
  finally { clearTimeout(timer); await new Promise(resolve => server ? server.close(resolve) : resolve()); }
} };
