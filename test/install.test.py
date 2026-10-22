#!/usr/bin/env python3
"""Verify version guards, idempotence and exact restoration on disposable copies."""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

source = pathlib.Path(__file__).resolve().parents[1]
vendor = pathlib.Path.home() / '.vscode/extensions/openai.chatgpt-26.1007.21434-darwin-arm64'
root = pathlib.Path(tempfile.mkdtemp(prefix='review-install.'))
(root / 'out').mkdir()
shutil.copy2(vendor / 'package.json', root / 'package.json')
main = vendor / 'out/extension.js'
if (vendor / 'out/review-patch.json').exists():
    record = json.loads((vendor / 'out/review-patch.json').read_text())
    main = pathlib.Path(record['backup']) / 'extension.js'
shutil.copy2(main, root / 'out/extension.js')
original = (root / 'out/extension.js').read_bytes()
def run(action, success=True):
    p = subprocess.run([sys.executable, str(source / 'install.py'), action, '--extension', str(root), '--settings', str(root / 'settings.json')], capture_output=True, text=True)
    assert (p.returncode == 0) == success, p.stderr
(root / 'settings.json').write_text(json.dumps({'editor.codeLens': False, 'unrelated': 1, 'changeReview.scope': '/tmp/example'}))
run('check'); run('apply'); patched = (root / 'out/extension.js').read_bytes(); run('apply')
settings = json.loads((root / 'settings.json').read_text()); assert settings['editor.codeLens'] is False; assert 'changeReview.scope' not in settings
settings['unrelated'] = 2
(root / 'settings.json').write_text(json.dumps(settings))
assert (root / 'out/extension.js').read_bytes() == patched
(root / 'out/extension.js').write_bytes(patched + b'\n')
run('check', False); assert (root / 'out/extension.js').read_bytes() == patched + b'\n'
(root / 'out/extension.js').write_bytes(patched)
run('restore'); assert (root / 'out/extension.js').read_bytes() == original
settings = json.loads((root / 'settings.json').read_text()); assert settings['editor.codeLens'] is False; assert settings['unrelated'] == 2; assert settings['changeReview.scope'] == '/tmp/example'
run('restore')
package = json.loads((root / 'package.json').read_text()); package['version'] = '99.0.0'; (root / 'package.json').write_text(json.dumps(package))
run('apply', False); assert (root / 'out/extension.js').read_bytes() == original
print('PASS: version/hash guards, idempotence and byte-exact rollback')
