#!/usr/bin/env python3
"""Run every selected suite, retain failures, and write a machine-readable report."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time

parser = argparse.ArgumentParser()
modes = parser.add_mutually_exclusive_group()
modes.add_argument('--all', action='store_true', help='Include fixture, edge cases, stress and one live model request')
modes.add_argument('--live', action='store_true')
modes.add_argument('--stress', action='store_true')
args = parser.parse_args()
source = pathlib.Path(__file__).resolve().parents[1]
runtime = os.environ.get('REVIEW_NODE', '/Applications/Visual Studio Code.app/Contents/MacOS/Code')
report_dir = pathlib.Path(tempfile.mkdtemp(prefix='review-checks.'))
node_env = dict(os.environ, ELECTRON_RUN_AS_NODE='1')
suites = [('unit', [runtime, '--test', '--test-reporter=tap', '--experimental-test-coverage', '--test-coverage-include=*.js', '--test-coverage-include=*.mjs', *[str(file.relative_to(source)) for file in sorted((source / 'test').glob('*.test.js'))]], node_env, 120),
          ('bridge-installer', [sys.executable, 'test/install.test.py'], None, 60),
          ('native-installer', [sys.executable, 'test/native-install.test.py'], None, 60),
          ('installer-cases', [sys.executable, 'test/installer-cases.test.py'], None, 120)]
if args.all:
    integration = [('fixture', []), ('mode', ['--mode']), ('edges', ['--edges']), ('stress', ['--stress']), ('live', ['--live'])]
elif args.live:
    integration = [('live', ['--live'])]
elif args.stress:
    integration = [('stress', ['--stress'])]
else:
    integration = [('fixture', []), ('mode', ['--mode']), ('edges', ['--edges'])]
for name, flags in integration:
    suites.append((name, [sys.executable, 'test/run-hook-live.py'] if name == 'live' else [sys.executable, 'test/run-integration.py', *flags], None, 480 if name == 'live' else 300))
results = []
print('Reports:', report_dir, flush=True)
for name, command, environment, timeout in suites:
    print('RUN:', name, flush=True); started = time.monotonic(); log = report_dir / (name + '.log')
    with log.open('w') as output:
        try:
            status = subprocess.run(command, cwd=source, env=environment, stdout=output, stderr=subprocess.STDOUT, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            status = 124
    text = log.read_text(errors='replace')
    result = {'suite': name, 'passed': status == 0, 'exitCode': status, 'elapsedSeconds': round(time.monotonic() - started, 2), 'log': str(log), 'command': command}
    if name == 'unit':
        result['counts'] = {key: int(value) for key, value in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', text, re.MULTILINE)}
        result['failures'] = re.findall(r'^not ok \d+ - (.*)$', text, re.MULTILINE)
        result['coverage'] = [{'file': file, 'lines': float(lines), 'branches': float(branches), 'functions': float(functions)}
                              for file, lines, branches, functions in re.findall(r'^# (\S+\.(?:js|mjs))\s+\|\s*([\d.]+)\s+\|\s*([\d.]+)\s+\|\s*([\d.]+)', text, re.MULTILINE)]
        if not result['coverage']:
            result['passed'] = False
            result['failures'].append('No runtime modules were included in the coverage report')
    results.append(result)
    print(('PASS: ' if result['passed'] else 'FAIL: ') + name + (' ' + json.dumps(result.get('counts', {})) if name == 'unit' else ''), flush=True)
    for failure in result.get('failures', []): print('  ' + failure, flush=True)
    for line in text.splitlines():
        if line.startswith(('Edges:', 'Result:', 'Logs:', 'PASS: stress', 'FAIL: ')): print('  ' + line, flush=True)
    (report_dir / 'results.json').write_text(json.dumps({'passed': all(item['passed'] for item in results), 'suites': results}, indent=2) + '\n')
failed = [item['suite'] for item in results if not item['passed']]
print(f'Completed {len(results)} suites: {len(results) - len(failed)} passed, {len(failed)} failed', flush=True)
print('Result:', report_dir / 'results.json', flush=True)
raise SystemExit(1 if failed else 0)
