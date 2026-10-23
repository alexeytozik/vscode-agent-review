'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),vscode=require('vscode');
module.exports={run:async()=>{const output=process.env.REVIEW_RESULT_FILE;try{
  const count=process.env.REVIEW_TEST_PHASE==='multi'?2:0;assert.equal(vscode.workspace.workspaceFolders?.length||0,count);
  const extension=vscode.extensions.getExtension('alexeytozik.agent-review'),api=await extension.activate();await api.ready;assert.equal(api.hooks,undefined);assert.equal(api.entries().length,0);
  await api.setEnabled(false);assert.equal(api.isEnabled(),false);await api.setEnabled(true);assert.equal(api.isEnabled(),true);
  const document=await vscode.workspace.openTextDocument({content:'unchanged\n'});assert.deepEqual(api.codeLenses(document),[]);
  await fs.writeFile(output,JSON.stringify({passed:true}));
}catch(error){await fs.writeFile(output,JSON.stringify({passed:false,error:error.stack}));throw error;}}};
