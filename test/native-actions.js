'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');

async function actionAt(document, line, action) {
  const api = vscode.extensions.getExtension('local-tools.change-review').exports;
  const expected = api.controlItems(document).find(item => item.start <= line + 1 && line + 1 <= item.end);
  assert.ok(expected, 'The change is actionable');
  const deadline = Date.now() + 3000; let state;
  do {
    const states = await vscode.commands.executeCommand('_changeReview.nativeInspect', document.uri.toString());
    state = states.find(item => item.visible && item.current?.arg.hunk === expected.arg.hunk && !item.invalidated);
    if (state) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.ok(state, 'Native controls are visible at the selected change: ' + JSON.stringify({ expected, state }));
  assert.equal(state.height, 22, 'Compact native row matches Cursor height');
  assert.deepEqual(state.actions.map(item => item.label), ['Undo', 'Keep']);
  assert.deepEqual(state.actions.map(item => item.title), ['Reject change', 'Accept change']);
  assert.deepEqual(state.current.arg, expected.arg, 'Native controls carry fresh decision arguments');
  const command = state.actions.find(item => item.command === 'changeReview.' + action); assert.ok(command);
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(line, 0));
  assert.ok(hovers.flatMap(item => item.contents).every(item => !item.value?.includes('change-review-controls:') && !item.value?.includes('command:changeReview.accept')), 'No action popup or internal metadata leaks into the hover');
  return { command: '_changeReview.nativeAction', arguments: [state.current.arg, action, document.uri.toString()] };
}
module.exports = { actionAt };
