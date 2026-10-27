'use strict';
const events = { PreToolUse: '^apply_patch$', PostToolUse: '^(apply_patch|Bash|exec|exec_command|functions\\.exec|functions\\.exec_command)$|^mcp__', UserPromptSubmit: null, Stop: null, Interrupt: null };
const timeout = event => event === 'Interrupt' ? 3 : 10;
function isConfigured(input, command) {
  return Object.entries(events).every(([event, matcher]) => Array.isArray(input?.hooks?.[event]) && input.hooks[event].some(group =>
    (group?.matcher || null) === matcher && Array.isArray(group?.hooks) && group.hooks.some(hook => hook?.type === 'command' && hook.command === command && hook.timeout === timeout(event))));
}
function quote(value, platform = process.platform) {
  if (platform === 'win32') {
    if (/[\r\n"%!]/.test(value)) throw new Error('This Windows path cannot be used in a hook command.');
    return '"' + value + '"';
  }
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function hookCommand(executable, script, storage, platform = process.platform) {
  const args = [executable, script, storage].map(p => quote(p, platform)).join(' ');
  return platform === 'win32' ? 'set "ELECTRON_RUN_AS_NODE=1" && ' + args : 'ELECTRON_RUN_AS_NODE=1 ' + args;
}
function configure(input, command, previous = [], remove = false) {
  const result = JSON.parse(JSON.stringify(input));
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.hooks && (typeof result.hooks !== 'object' || Array.isArray(result.hooks))) throw new Error('Unsupported hooks configuration.');
  result.hooks ||= {};
  const owned = new Set([command, ...previous]);
  for (const [event, matcher] of Object.entries(events)) {
    const groups = result.hooks[event] || [];
    if (!Array.isArray(groups)) throw new Error('Unsupported hooks configuration.');
    const remaining = groups.map(group => {
      if (!Array.isArray(group.hooks)) throw new Error('Unsupported hook group.');
      return { ...group, hooks: group.hooks.filter(hook => !(typeof hook.command === 'string' && owned.has(hook.command))) };
    }).filter(group => group.hooks.length);
    if (!remove) remaining.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: timeout(event) }] });
    if (remaining.length) result.hooks[event] = remaining; else delete result.hooks[event];
  }
  return result;
}
module.exports = { quote, hookCommand, configure, isConfigured };
