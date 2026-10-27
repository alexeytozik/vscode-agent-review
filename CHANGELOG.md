# 0.6.3 — Preview

- Support the local inline toolbar on verified VS Code 1.143.1 builds.
- Keep inline actions visible in the middle of long changes and wrapped paragraphs.
- Keep Undo/Keep labels visible beside long lines.
- Keep the mode switch ON/OFF and clickable regardless of connection readiness.
- Show connection problems in the tooltip and enable notification.
- Preserve pending reviews and skip requests made while review is off.

# 0.6.2 — Preview

- Restore the existing inline toolbar when the local workbench integration is present.
- Hide duplicate hover links, CodeLens and editor title actions in that mode.
- Preserve lifecycle hook capture and standard controls in unmodified editors.

# 0.6.1 — Preview

- Show SETUP or WAIT until a connection actually delivers events.
- Detect removed or outdated hook configuration instead of showing ON.
- Warn when code-mode command writes are outside review coverage.

# 0.6.0 — Preview

- Use public editor CodeLens, hover actions and toolbar buttons.
- Connect through documented lifecycle hooks without modifying installed applications.
- Batch review decisions into context for the next request.
- Preserve Unicode, manual edits and queues with more than 200 requests.
- Prevent duplicate decisions and keep controls accessible for long changes.
- Preserve existing settings and migrate snapshots from the local extension.
