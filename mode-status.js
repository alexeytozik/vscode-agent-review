'use strict';
function statusDetails(state) {
  const time = value => Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : 'not observed in this window';
  return `Last lifecycle event: ${time(state.lastEvent)}.\nLast confirmed queued patch: ${time(state.lastPatch)}.\nQueue: ${state.ready || 0} ready blocks, ${state.blocked || 0} paused files, ${state.running || 0} running files.\nLatest request: ${state.skipped || 0}${state.skippedAtLeast ? '+' : ''} unsupported or skipped operations.\nAuto-open: ${state.autoOpenReason || 'waiting for a completed request'}.`;
}

function createModeStatus(vscode, enabled, connection = () => ({})) {
  const item = vscode.window.createStatusBarItem('changeReview.mode', vscode.StatusBarAlignment.Left, 10);
  item.name = 'Agent Review';
  item.command = 'changeReview.toggle';
  let previous;

  function update() {
    const active = enabled(), state = connection();
    const mode = active ? 'ON' : 'OFF';
    let icon = 'circle-slash', problem;
    let tooltip = 'Agent Review is OFF. New changes are not recorded or queued. Pending reviews are preserved. Click to turn it on.';
    if (active) {
      icon = 'warning';
      if (state.available === false) {
        problem = 'Open one local, trusted workspace folder to connect review.';
      } else if (!state.connected) {
        problem = 'Review is not connected. New changes are not being recorded. Run Agent Review: Connect.';
      } else if (state.captureBlocked) {
        problem = 'Review exclusions could not be applied. Recording is paused until the settings or storage problem is resolved.';
      } else if (state.incomplete) {
        problem = 'Review coverage is incomplete: an invalid lifecycle event was skipped. Review affected changes manually; later events can still arrive.';
      } else if (!state.lastEvent) {
        problem = 'Hooks are configured, but event delivery is not verified. Trust them in /hooks and start a new request.';
      } else {
        icon = 'check';
      }
      tooltip = 'Agent Review is ON. Click to turn it off.\n' + (problem || 'Connection is receiving events. Only confirmed apply_patch changes are queued after editing; shell and Python writes need manual review.');
    }
    tooltip += '\n' + statusDetails(state);
    item.command = 'changeReview.toggle';
    item.text = `$(${icon}) Review: ${mode}`;
    item.tooltip = tooltip;
    item.accessibilityInformation = { label: item.tooltip };
    item.show();
    const changed = previous !== undefined && previous !== active;
    previous = active;
    if (changed) vscode.window.showInformationMessage(`Agent Review is ${mode}.` + (active && problem ? ' ' + problem : ''));
  }

  update();
  return { update, dispose: () => item.dispose() };
}

module.exports = { createModeStatus, statusDetails };
