'use strict';

function createModeStatus(vscode, enabled, connection = () => ({})) {
  const item = vscode.window.createStatusBarItem('changeReview.mode', vscode.StatusBarAlignment.Left, 10);
  item.name = 'Agent Review';
  item.command = 'changeReview.toggle';
  let previous;

  function update() {
    const active = enabled(), state = connection();
    let mode = 'OFF', icon = 'circle-slash', command = 'changeReview.toggle';
    let tooltip = 'Agent Review is OFF. Click to turn it on.';
    if (active) {
      icon = 'warning'; command = 'changeReview.status';
      if (state.available === false) {
        mode = 'UNAVAILABLE'; tooltip = 'Open one local, trusted workspace folder to connect review.';
      } else if (!state.connected) {
        mode = 'SETUP'; command = 'changeReview.connect';
        tooltip = 'Agent Review is enabled but not connected. New changes are not being recorded. Click to connect.';
      } else if (!state.lastEvent) {
        mode = 'WAIT'; tooltip = 'Hooks are configured, but event delivery is not verified. Trust them in /hooks and start a new request. Click for status.';
      } else {
        mode = 'ON'; icon = 'check'; command = 'changeReview.toggle';
        tooltip = 'Agent Review is ON and receiving events. Only confirmed apply_patch changes are queued after editing; shell and Python writes need manual review. Click to turn it off.';
      }
    }
    item.command = command;
    item.text = `$(${icon}) Review: ${mode}`;
    item.tooltip = tooltip;
    item.accessibilityInformation = { label: item.tooltip };
    item.show();
    const changed = previous !== undefined && previous !== active;
    previous = active;
    if (changed) vscode.window.showInformationMessage(mode === 'ON' || mode === 'OFF' ? `Agent Review is ${mode}.` : 'Agent Review: ' + tooltip);
  }

  update();
  return { update, dispose: () => item.dispose() };
}

module.exports = { createModeStatus };
