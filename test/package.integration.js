'use strict';
const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{createPatch}=require('diff');
module.exports={run:async()=>{const root=vscode.workspace.workspaceFolders[0].uri.fsPath;try{
  const extension=vscode.extensions.getExtension('alexeytozik.agent-review');assert.ok(extension);assert.ok(extension.extensionPath.includes(path.sep+'extensions'+path.sep),'The installed VSIX is tested, not development sources');
  const api=await extension.activate();await api.ready;assert.ok(!vscode.extensions.getExtension('openai.chatgpt'));assert.ok(!(await vscode.commands.getCommands()).includes('_changeReview.nativeInspect'));
  const full=path.join(root,'package.txt'),before='ёж😺\n',after='другой🐱\n';await fs.writeFile(full,after);
  await api.receive({method:'item/completed',type:'fileChange',status:'completed',threadId:'package',turnId:'turn',itemId:'change',changes:[{path:full,kind:{type:'update'},diff:createPatch(full,before,after),snapshot:{disk:after,text:after,mode:0o644}}]});await api.receive({method:'turn/completed',threadId:'package',turnId:'turn'});
  const lenses=await vscode.commands.executeCommand('vscode.executeCodeLensProvider',vscode.Uri.file(full));const undo=lenses.find(lens=>lens.command?.command==='changeReview.reject').command;await vscode.commands.executeCommand(undo.command,...undo.arguments);assert.equal(await fs.readFile(full,'utf8'),before);assert.equal(api.entries().length,0);
  await fs.writeFile(path.join(root,'package-result.json'),JSON.stringify({passed:true}));
}catch(error){await fs.writeFile(path.join(root,'package-result.json'),JSON.stringify({passed:false,error:error.stack}));throw error;}}};
