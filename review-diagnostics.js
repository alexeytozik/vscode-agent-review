'use strict';
const { MAX_FILE_BYTES } = require('./files');
const { MAX_STATE_BYTES } = require('./review-state');
const results = new Set(['not-observed', 'request-started', 'patch-confirmed', 'patch-paused', 'read-only', 'command-manual', 'external-manual', 'excluded', 'request-ready', 'request-paused', 'request-incomplete', 'request-unchanged', 'skipped-off', 'late-patch']);
function buildDiagnostics(input = {}) {
  const settings = input.settings || {}, status = input.status || {}, connection = input.connection || {}, data = input.data || {}, recovery = input.recovery || {};
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const version = value => typeof value === 'string' && value.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value) ? value : 'unknown';
  const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? new Date(value).toISOString() : null;
  const reasons = { 'review is OFF': 'review-off', 'disabled in settings': 'disabled-by-setting', 'waiting for a completed request': 'waiting', 'request is still running': 'request-running', 'ready changes opened': 'opened-ready-changes', 'review paused because changes could not be prepared': 'paused', 'all recorded changes reviewed': 'reviewed', 'no confirmed patches; unsupported writes require manual review': 'unsupported-writes', 'protected or excluded paths require manual review': 'excluded', 'no confirmed text changes': 'no-confirmed-changes', 'this request was skipped while review was OFF': 'skipped-off', 'a late patch was captured for a completed request; open it from the review queue': 'late-patch-awaits-open' };
  const categories = Object.fromEntries(['pending', 'events', 'feedback', 'quarantine', 'backups', 'temporary'].map(key => [key, { files: number(data.categories?.[key]?.files), bytes: number(data.categories?.[key]?.bytes) }]));
  return {
    versions: { extension: version(input.extensionVersion), vscode: version(input.editorVersion), node: version(input.nodeVersion) },
    environment: { platform: ['darwin', 'linux', 'win32'].includes(input.platform) ? input.platform : 'unknown', remote: input.remote === true, trustedWorkspace: input.trusted === true, supportedWorkspace: status.available === true },
    settings: { enabled: settings.enabled === true, view: ['review', 'editor'].includes(settings.view) ? settings.view : 'unknown', autoOpen: settings.autoOpen === true, exclusionPatterns: Array.isArray(settings.exclude) ? settings.exclude.length : null },
    queue: { unresolvedFiles: number(status.pendingFiles), readyBlocks: number(status.ready), pausedFiles: number(status.blocked), runningFiles: number(status.running), latestSkippedOperations: number(status.skipped), skippedCountIsLowerBound: status.skippedAtLeast === true },
    capture: { lastLifecycleEvent: time(status.lastEvent), lastConfirmedPatch: time(status.lastPatch), lastResult: results.has(status.lastResult) ? status.lastResult : 'unknown', autoOpenReason: reasons[status.autoOpenReason] || 'unknown' },
    hooks: { active: connection.active === true, configured: connection.configured === true, ownedCommandCount: number(connection.ownedCommandCount), metadataPresent: connection.metadataPresent === true, recordingBlocked: connection.captureBlocked === true, incompleteCoverage: connection.incomplete === true, configRead: ['ok', 'missing', 'invalid', 'unreadable'].includes(connection.configRead) ? connection.configRead : 'unavailable' },
    storage: { categories, countsArePartial: data.truncated === true, savedQueueBytes: number(input.stateBytes) },
    recovery: { loaded: recovery.loaded === true, retryRead: recovery.retryRead === true, backupPresent: recovery.backupPresent === true, warningOccurred: recovery.warningOccurred === true },
    limits: { fileBytes: MAX_FILE_BYTES, savedQueueBytes: MAX_STATE_BYTES, feedbackBatch: 2000, quarantinedRecordsPerKind: 32, quarantineBytesPerKind: 25 * 1024 * 1024, cleanupScan: 256, cleanupRemovals: 32 },
    coverage: 'Only confirmed apply_patch writes are queued. Shell, Python and MCP writes need manual review. Local stdout success is not a recipient acknowledgement; exactly-once delivery is not guaranteed.'
  };
}
module.exports = { buildDiagnostics };
