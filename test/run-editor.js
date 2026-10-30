'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {downloadAndUnzipVSCode,runTests,resolveCliArgsFromVSCodeExecutablePath}=require('@vscode/test-electron');
async function main(){
  delete process.env.ELECTRON_RUN_AS_NODE;
  const source=path.resolve(__dirname,'..'),root=await fs.mkdtemp(path.join(os.tmpdir(),'review-editor.'));
  console.log('Reports: '+root);
  const executable=process.env.REVIEW_VSCODE_EXECUTABLE||await downloadAndUnzipVSCode(process.env.REVIEW_EDITOR_VERSION||'stable');
  const live=process.argv.includes('--live');
  if(process.argv.includes('--package')&&!process.env.REVIEW_VSIX)throw Error('Set REVIEW_VSIX to test an installed package.');
  const groups=live?['live']:process.argv.includes('--native')?['native']:process.argv.includes('--performance')?['performance']:process.argv.includes('--renderer')?['renderer']:process.argv.includes('--diagnostics')?['diagnostics']:process.argv.includes('--retention')?['retention']:process.argv.includes('--privacy')?['privacy']:process.argv.includes('--ux')?['ux']:process.argv.includes('--connection')?['connection']:process.argv.includes('--refresh')?['refresh']:process.argv.includes('--decisions')?['decisions']:process.argv.includes('--state')?['state']:process.argv.includes('--panel')?['panel']:process.argv.includes('--package')?['package']:process.argv.includes('--mode')?['mode']:['fixture','mode','state','decisions','refresh','connection','ux','privacy','retention','diagnostics','edges','stress','empty','multi','panel',...(process.env.REVIEW_VSIX?['package']:[])];
  const results=[];
  for(const group of groups){
    const work=path.join(root,group),workspace=path.join(work,'workspace'),user=path.join(work,'user'),extensions=path.join(work,'extensions'),home=path.join(work,'home');
    await fs.mkdir(workspace,{recursive:true});await fs.mkdir(extensions);await fs.mkdir(home,{mode:0o700});await fs.mkdir(path.join(user,'User'),{recursive:true});
    await fs.writeFile(path.join(user,'User/settings.json'),JSON.stringify({'workbench.startupEditor':'none','extensions.autoUpdate':false,'extensions.autoCheckUpdates':false,'telemetry.telemetryLevel':'off','files.autoSave':'off','editor.codeLens':true,'editor.hover.enabled':process.env.REVIEW_EDITOR_VERSION==='1.96.0'?false:'off','editor.hover.delay':10000,'changeReview.autoOpen':true,...(['fixture','mode','edges','stress','native','live'].includes(group)?{'changeReview.view':'editor'}:{}),...(group==='mode'?{'changeReview.enabled':false}:{})}));
    if(live){const auth=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'auth.json');try{await fs.copyFile(auth,path.join(home,'auth.json'));await fs.chmod(path.join(home,'auth.json'),0o600);}catch(error){if(error.code!=='ENOENT')throw error;}}
    let development=source;
    if(group==='package'||process.env.REVIEW_VSIX&&['renderer','performance'].includes(group)){
      const cli=resolveCliArgsFromVSCodeExecutablePath(executable);const installed=spawnSync(cli[0],[...cli.slice(1),`--user-data-dir=${user}`,`--extensions-dir=${extensions}`,'--install-extension',process.env.REVIEW_VSIX],{encoding:'utf8'});
      if(installed.status!==0)throw Error('VSIX install failed: '+installed.stdout+installed.stderr);
      development=path.join(work,'harness');await fs.mkdir(development);await fs.writeFile(path.join(development,'package.json'),JSON.stringify({name:'review-check',publisher:'local-tests',version:'0.0.0',engines:{vscode:'^1.96.0'},main:'./index.js'}));await fs.writeFile(path.join(development,'index.js'),'exports.activate=()=>{};');
    }
    const phases=group==='fixture'?['fixture','restore','resume']:group==='state'?['state','state-corrupt','state-partial','state-readonly','state-transient','state-resume']:group==='retention'?['retention','retention-restore']:group==='privacy'?['privacy','privacy-restore']:group==='decisions'?['decisions','decisions-restore']:group==='panel'?['panel','panel-restore','panel-resume']:group==='mode'?['mode','mode-restore']:[group];
    try{for(const phase of phases){
      const module=group==='live'?'hook-live':group==='package'?'package':group==='fixture'?'agent':group==='multi'?'empty':group;
      const workspaceArg=group==='multi'?path.join(work,'multiple.code-workspace'):workspace;
      if(group==='multi'){const second=path.join(work,'second');await fs.mkdir(second);await fs.writeFile(workspaceArg,JSON.stringify({folders:[{path:workspace},{path:second}]}));}
      const launchArgs=[...(group==='empty'?[]:[workspaceArg]),`--user-data-dir=${user}`,`--extensions-dir=${extensions}`,'--disable-workspace-trust','--skip-welcome','--skip-release-notes','--new-window'];
      let debugPort;
      if(['renderer','performance'].includes(group)){
        const listener=require('node:net').createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));debugPort=listener.address().port;await new Promise(resolve=>listener.close(resolve));
        launchArgs.push('--remote-debugging-port='+debugPort);
      }
      if(phase==='resume')launchArgs.push(JSON.parse(await fs.readFile(path.join(workspace,'expected-pending.json'),'utf8')).path);
      await runTests({vscodeExecutablePath:executable,extensionDevelopmentPath:development,extensionTestsPath:path.join(source,'test',module+'.integration.js'),launchArgs,extensionTestsEnv:{REVIEW_TEST_PHASE:phase,REVIEW_RESULT_FILE:path.join(workspace,phase+'-result.json'),REVIEW_DEBUG_PORT:String(debugPort||''),REVIEW_RENDERER_READY_FILE:process.env.REVIEW_RENDERER_READY_FILE||path.join(workspace,'renderer-ready.json'),CODEX_HOME:home,REVIEW_AGENT_CLI:process.env.REVIEW_AGENT_CLI||'codex',REVIEW_LIVE_TRANSPORT:process.env.REVIEW_LIVE_TRANSPORT||'exec'}});
      const resultFile=path.join(workspace,group==='fixture'&&phase==='fixture'?'integration-result.json':`${group==='live'?'hook-live':phase}-result.json`);
      const result=JSON.parse(await fs.readFile(resultFile,'utf8'));if(!result.passed)throw Error(result.error);results.push({phase,passed:true});console.log('PASS: '+phase);
    }}finally{await fs.rm(path.join(home,'auth.json'),{force:true});}
  }
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({passed:true,results},null,2));console.log('Report: '+path.join(root,'results.json'));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
