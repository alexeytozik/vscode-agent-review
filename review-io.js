'use strict';

// Test failures at the write boundary without replacing read-only VS Code APIs.
function createReviewIO(vscode) {
  return {
    edit: (editor, callback) => editor.edit(callback),
    save: document => document.save(),
    create: edit => vscode.workspace.applyEdit(edit),
    remove: uri => vscode.workspace.fs.delete(uri, { useTrash: true, recursive: false })
  };
}

module.exports = { createReviewIO };
