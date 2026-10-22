'use strict';
// Compatibility entry point for the maintained integration suite.
module.exports = { run: async () => {
  process.env.REVIEW_TEST_PHASE ||= 'fixture';
  return require('./agent.integration').run();
} };
