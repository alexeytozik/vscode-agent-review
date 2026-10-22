'use strict';

function createModeStatus(vscode, enabled) {
  const item = vscode.window.createStatusBarItem('changeReview.mode', vscode.StatusBarAlignment.Left, 10);
  item.name = 'Agent Review';
  item.command = 'changeReview.toggle';
  let previous;

  function update() {
    const active = enabled(), mode = active ? 'ON' : 'OFF';
    item.text = `${active ? '$(check)' : '$(circle-slash)'} Review: ${mode}`;
    item.tooltip = `Agent Review is ${mode}. Click to turn it ${active ? 'off' : 'on'}.`;
    item.accessibilityInformation = { label: item.tooltip };
    item.show();
    const changed = previous !== undefined && previous !== active;
    previous = active;
    if (changed) vscode.window.showInformationMessage(`Agent Review is ${mode}.`);
  }

  update();
  return { update, dispose: () => item.dispose() };
}

module.exports = { createModeStatus };
