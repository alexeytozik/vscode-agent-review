'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vscode=require('vscode'),{spawn,spawnSync}=require('node:child_process');
async function run(){
  const folder=vscode.workspace.workspaceFolders[0].uri.fsPath,root=await fs.realpath(folder),manifest=require('../package.json');
  const api=await vscode.extensions.getExtension(manifest.publisher+'.'+manifest.name).activate();await api.ready;await api.hooks.ready;
  assert.ok(!(await vscode.commands.getCommands()).includes('_changeReview.nativeInspect'));
  await fs.writeFile(path.join(root,'first.txt'),'before\n');await fs.writeFile(path.join(root,'second.txt'),'old\n');
  await api.hooks.connect();
  const cli=process.env.REVIEW_AGENT_CLI;if(!cli)throw Error('REVIEW_AGENT_CLI is required for a live request');
  const prompt='Use apply_patch only. In first.txt replace before with after. In second.txt replace old with new. Preserve final newlines and all other files. Do not run shell commands, delegate or read credentials. Reply done.';
  let server;
  try {
  if(process.env.REVIEW_LIVE_TRANSPORT==='app-server'){
    server=await require('./live-client').appServer(cli,root,api.hooks.store);await server.turn(prompt);
  }else{
  const help=spawnSync(cli,['--help'],{encoding:'utf8'}).stdout||'';
  const args=[...(help.includes('--no-daemon')?['--no-daemon']:[]),'--dangerously-bypass-hook-trust','-a','never','-s','workspace-write','-C',root,'exec','--skip-git-repo-check','--json',prompt];
  const child=spawn(cli,args,{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const timeout=setTimeout(()=>child.kill('SIGTERM'),150000);
  const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timeout);
  await fs.writeFile(path.join(folder,'live-events.log'),out+'\n'+err,{mode:0o600});assert.equal(status,0,'Live request must finish successfully; inspect the isolated live-events.log');
  }
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){await api.hooks.drain();if(api.entries().length===2&&api.entries().every(e=>!e.turn.running))break;await new Promise(r=>setTimeout(r,50));}
  const entries=api.entries();assert.equal(entries.length,2,'Actual lifecycle hooks produce exactly two files');assert.ok(entries.every(e=>!e.file.error&&!e.turn.running));
  assert.equal(await fs.readFile(path.join(root,'first.txt'),'utf8'),'after\n');assert.equal(await fs.readFile(path.join(root,'second.txt'),'utf8'),'new\n');
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath,entries[0].file.path,'Automatically open the first change');
  const {actionAt}=require('./review-actions');
  const first=entries.find(e=>path.basename(e.file.path)==='first.txt');await api.show({turn:first.turn.key,path:first.file.path});const keep=await actionAt(vscode.window.activeTextEditor.document,0,'accept');await vscode.commands.executeCommand(keep.command,...keep.arguments);
  const second=api.entries()[0];const undo=await actionAt(vscode.window.activeTextEditor.document,0,'reject');await Promise.all([vscode.commands.executeCommand(undo.command,...undo.arguments),vscode.commands.executeCommand(undo.command,...undo.arguments)]);
  assert.equal(await fs.readFile(path.join(root,'second.txt'),'utf8'),'old\n');assert.equal(api.entries().length,0);
  const connection=JSON.parse(await fs.readFile(path.join(api.hooks.store,'connection.json'),'utf8'));
  assert.ok(connection.enabled);const {handle}=require('../hook-runner');
  if(server){
    const reply=await server.turn('Do not use any tools. What does the automatic local review summary say? Reply only as kept=X undone=Y using the counts in that summary.');
    assert.match(reply,/kept=1\s+undone=1/,'The next real request receives the batched review decisions');
  }else{
    const session=first.turn.threadId;const summary=await handle(api.hooks.store,{hook_event_name:'UserPromptSubmit',session_id:session,turn_id:'summary-check',cwd:root});
    assert.match(summary.hookSpecificOutput.additionalContext,/1 kept, 1 undone/);
  }
  await api.hooks.disconnect();
  }finally{if(server){await fs.writeFile(path.join(folder,'live-events.log'),server.log(),{mode:0o600});server.close();}}
}
module.exports={run:async()=>{const root=vscode.workspace.workspaceFolders[0].uri.fsPath;try{await run();await fs.writeFile(path.join(root,'hook-live-result.json'),JSON.stringify({passed:true}));}catch(error){await fs.writeFile(path.join(root,'hook-live-result.json'),JSON.stringify({passed:false,error:error.stack}));throw error;}}};
