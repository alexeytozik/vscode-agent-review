#!/usr/bin/env python3
"""Test the editor in an isolated profile; --live also tests the event bridge."""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

parser = argparse.ArgumentParser()
modes = parser.add_mutually_exclusive_group()
modes.add_argument('--live', action='store_true')
modes.add_argument('--stress', action='store_true')
modes.add_argument('--edges', action='store_true')
modes.add_argument('--mode', action='store_true')
args = parser.parse_args()
source = pathlib.Path(__file__).resolve().parents[1]
code = os.environ.get('REVIEW_CODE', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
root = pathlib.Path(tempfile.mkdtemp(prefix='review-host.'))
workspace = root / 'workspace'
workspace.mkdir()
extensions = root / 'extensions'
extensions.mkdir()
settings = root / 'user/User/settings.json'
settings.parent.mkdir(parents=True)
settings.write_text(json.dumps({'workbench.startupEditor': 'none', 'extensions.autoUpdate': False,
    'extensions.autoCheckUpdates': False, 'telemetry.telemetryLevel': 'off', 'files.autoSave': 'off',
    'editor.codeLens': True,
    'editor.hover.enabled': 'off', 'editor.hover.delay': 10000,
    'changeReview.autoOpen': True,
    **({'changeReview.enabled': False} if args.mode else {})}))
if args.live:
    raise SystemExit('Use test/run-hook-live.py for the supported lifecycle-hook integration')

for phase in (['mode', 'mode-restore'] if args.mode else ['edges'] if args.edges else ['stress'] if args.stress else ['live' if args.live else 'fixture', 'restore', 'resume']):
    result_file = workspace / (f'{phase}-result.json' if phase in ['restore', 'resume', 'stress', 'edges', 'mode', 'mode-restore'] else 'integration-result.json')
    test_module = source / ('test/mode.integration.js' if args.mode else 'test/edges.integration.js' if args.edges else 'test/stress.integration.js' if args.stress else 'test/agent.integration.js')
    command = [code, f'--extensionDevelopmentPath={source}', f'--extensionTestsPath={test_module}',
        f'--user-data-dir={root / "user"}', f'--extensions-dir={extensions}', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--new-window', str(workspace)]
    if phase == 'resume':
        command.append(json.loads((workspace / 'expected-pending.json').read_text())['path'])
    subprocess.run(command, check=True, timeout=20, env=dict(os.environ, REVIEW_TEST_PHASE=phase))
    deadline = time.monotonic() + (200 if phase in ['live', 'stress', 'edges'] else 45)
    reported = 0
    while not result_file.exists() and time.monotonic() < deadline:
        progress = workspace / 'stress-progress.json'
        if args.stress and progress.exists():
            iterations = json.loads(progress.read_text())
            for iteration in iterations[reported:]:
                print(f'PASS: iteration {iteration["iteration"]} — 50 changes, 25 accepted, 25 rejected', flush=True)
            reported = len(iterations)
        time.sleep(0.25)
    if not result_file.exists():
        raise SystemExit(f'FAIL: no result; logs: {root / "user/logs"}')
    result = json.loads(result_file.read_text())
    if args.edges:
        print(f'Edges: {result["total"] - result["failed"]} passed, {result["failed"]} failed; result: {result_file}', flush=True)
        for case in result['cases']:
            print(('PASS: ' if case['passed'] else 'FAIL: ') + case['name'], flush=True)
    if not result['passed']:
        raise SystemExit('FAIL: ' + result['error'])
    if args.stress:
        for iteration in result['iterations'][reported:]:
            print(f'PASS: iteration {iteration["iteration"]} — 50 changes, 25 accepted, 25 rejected', flush=True)
        print(f'PASS: stress — {result["totalChanges"]} changes across {len(result["iterations"])} new editor tabs', flush=True)
        print(f'Result: {result_file}')
    elif args.mode:
        print(f'PASS: {phase} — real mode indicator, commands, notifications and pending queue', flush=True)
    else:
        print(f'PASS: {phase} — editor blocks, manual changes, conflicts and persistence', flush=True)
print(f'Logs: {root / "user/logs"}')
