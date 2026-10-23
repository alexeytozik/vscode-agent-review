'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const manifest = require('../package.json');
async function actionAt(document, line, action) {
  const api = vscode.extensions.getExtension(manifest.publisher + '.' + manifest.name).exports;
  const expected = api.controlItems(document).find(item => item.start <= line + 1 && line + 1 <= item.end);
  assert.ok(expected, 'The change is actionable');
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', document.uri);
  const command = lenses.find(lens => lens.command?.command === 'changeReview.' + action && lens.command.arguments[0].hunk === expected.arg.hunk)?.command;
  assert.ok(command, 'Public CodeLens actions exist at the start of each change, including large changes');
  assert.deepEqual(command.arguments[0], expected.arg, 'The control carries fresh decision arguments');
  return command;
}
module.exports = { actionAt };
