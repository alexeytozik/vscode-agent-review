'use strict';
const { createHash } = require('node:crypto');
function createRequestHistory({ maxRequests = 128, maxIds = 512 } = {}) {
  const records = new Map();
  function use(key) {
    const record = records.get(key) || { key, skipped: new Set(), skippedAtLeast: false, reason: 'request is still running' };
    records.delete(key); records.set(key, record);
    while (records.size > maxRequests) records.delete(records.keys().next().value);
    return record;
  }
  function skip(record, id) {
    const digest = createHash('sha256').update(String(id)).digest('hex');
    if (record.skipped.has(digest)) return;
    if (record.skipped.size < maxIds) record.skipped.add(digest); else record.skippedAtLeast = true;
  }
  return { use, skip, size: () => records.size };
}
module.exports = { createRequestHistory };
