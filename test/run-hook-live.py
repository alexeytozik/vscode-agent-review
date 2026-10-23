#!/usr/bin/env python3
"""Run one isolated real request through documented lifecycle hooks."""
import json, os, pathlib, shutil, subprocess, tempfile, time
source=pathlib.Path(__file__).resolve().parents[1]
root=pathlib.Path(tempfile.mkdtemp(prefix='review-live.'));root.chmod(0o700)
workspace=root/'workspace';workspace.mkdir();extensions=root/'extensions';extensions.mkdir();home=root/'home';home.mkdir(mode=0o700)
auth=pathlib.Path(os.environ.get('CODEX_HOME',str(pathlib.Path.home()/'.codex')))/'auth.json'
if auth.is_file():shutil.copyfile(auth,home/'auth.json');(home/'auth.json').chmod(0o600)
settings=root/'user/User/settings.json';settings.parent.mkdir(parents=True);settings.write_text(json.dumps({'workbench.startupEditor':'none','extensions.autoUpdate':False,'extensions.autoCheckUpdates':False,'telemetry.telemetryLevel':'off','editor.codeLens':True,'editor.hover.enabled':'off'}))
code=os.environ.get('REVIEW_CODE','/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
cli=os.environ.get('REVIEW_AGENT_CLI',shutil.which('codex') or '')
try:
    subprocess.run([code,f'--extensionDevelopmentPath={source}',f'--extensionTestsPath={source / "test/hook-live.integration.js"}',f'--user-data-dir={root / "user"}',f'--extensions-dir={extensions}','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--new-window',str(workspace)],check=True,timeout=20,env=dict(os.environ,CODEX_HOME=str(home),REVIEW_AGENT_CLI=cli))
    result=workspace/'hook-live-result.json';deadline=time.monotonic()+190
    while not result.exists() and time.monotonic()<deadline:time.sleep(.25)
    if not result.exists():raise SystemExit(f'FAIL: no result; logs: {root}')
    data=json.loads(result.read_text());print('PASS: real hook capture, public UI, Keep/Undo, duplicate decisions and batched context' if data['passed'] else 'FAIL: '+data['error']);print('Result:',result)
    raise SystemExit(0 if data['passed'] else 1)
finally:
    if (home/'auth.json').exists():(home/'auth.json').unlink()
