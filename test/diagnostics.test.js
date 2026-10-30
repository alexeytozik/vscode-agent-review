'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { buildDiagnostics } = require('../review-diagnostics');
test('R23 report contains only reviewed scalar facts, never source, prompt, environment or paths', () => {
  const marker = 'private-fixture-value-6439', path = '/private/workspace/' + marker;
  const report = buildDiagnostics({ extensionVersion: '0.7.3', editorVersion: '1.144.0', nodeVersion: '24.22.1', platform: 'darwin', settings: { enabled: true, view: 'review', autoOpen: false, exclude: [path] }, status: { available: true, lastEvent: 1, lastPatch: 2, ready: 3, blocked: 1, skipped: 2, lastResult: 'excluded', autoOpenReason: 'disabled in settings', error: marker, path },
    connection: { active: true, configured: true, ownedCommandCount: 5, metadataPresent: true, configFile: path, command: marker }, data: { categories: { pending: { files: 2, bytes: 4096, path } }, truncated: true }, recovery: { loaded: true, retryRead: false, backup: path }, source: marker, prompt: marker, env: { TOKEN: marker } });
  const text = JSON.stringify(report); assert.ok(!text.includes(marker)); assert.ok(!text.includes('/private'));
  assert.equal(report.versions.extension, '0.7.3'); assert.equal(report.settings.exclusionPatterns, 1); assert.equal(report.capture.lastResult, 'excluded'); assert.equal(report.queue.readyBlocks, 3); assert.equal(report.storage.categories.pending.files, 2); assert.equal(report.hooks.ownedCommandCount, 5);
  assert.equal(report.capture.lastConfirmedPatch, '1970-01-01T00:00:00.002Z'); assert.match(report.coverage, /apply_patch/); assert.match(report.coverage, /acknowledgement/);
});
test('R23 malformed or unknown diagnostic inputs cannot reflect private strings or throw', () => {
  const marker = 'private-fixture-value-4298', report = buildDiagnostics({ settings: { view: marker, exclude: marker }, status: { lastResult: marker, autoOpenReason: marker, lastPatch: Number.MAX_SAFE_INTEGER, ready: marker }, connection: { error: marker }, recovery: { issue: marker } });
  assert.ok(!JSON.stringify(report).includes(marker)); assert.equal(report.capture.lastResult, 'unknown'); assert.equal(report.capture.lastConfirmedPatch, null); assert.equal(report.queue.readyBlocks, 0);
});
