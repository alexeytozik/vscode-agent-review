'use strict';

function actions(items) {
  return items.flatMap(item => [
    { line: item.start - 1, title: '✓ Keep', command: 'changeReview.accept', arguments: [item.arg] },
    { line: item.start - 1, title: '✕ Undo', command: 'changeReview.reject', arguments: [item.arg] }
  ]);
}

function decisionGate(run) {
  const pending = new Map();
  return (arg, action, advance) => {
    if (!arg) return Promise.reject(new Error('Select a pending change first.'));
    const key = JSON.stringify([arg.turn, arg.path, arg.revision, arg.hunk]);
    if (pending.has(key)) return pending.get(key);
    const job = Promise.resolve().then(() => run(arg, action, advance)).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  };
}
module.exports = { actions, decisionGate };
