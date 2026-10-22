#!/usr/bin/env python3
"""Check native integration guards and byte-exact rollback on a disposable app."""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

source = pathlib.Path(__file__).resolve().parents[1]
original = pathlib.Path('/Applications/Visual Studio Code.app/Contents/Resources/app')
root = pathlib.Path(tempfile.mkdtemp(prefix='review-native-install.'))
app = root / 'Editor.app/Contents/Resources/app'
workbench = app / 'out/vs/workbench'
workbench.mkdir(parents=True)
for name in ['package.json', 'product.json']:
    shutil.copy2(original / name, app / name)
target = workbench / 'workbench.desktop.main.js'
record = original / 'out/vs/workbench/review-native-patch.json'
if record.exists() and 'productPatched' in json.loads(record.read_text()):
    shutil.copy2(pathlib.Path(json.loads(record.read_text())['backup']) / 'product.json', app / 'product.json')
main = pathlib.Path(json.loads(record.read_text())['backup']) / target.name if record.exists() else original / 'out/vs/workbench' / target.name
shutil.copy2(main, target)
before = target.read_bytes()
product = (app / 'product.json').read_bytes()

def run(action, success=True):
    result = subprocess.run([sys.executable, str(source / 'install-native.py'), action, '--app', str(root / 'Editor.app')], capture_output=True, text=True)
    assert (result.returncode == 0) == success, result.stderr

run('check'); run('apply'); patched = target.read_bytes(); run('apply'); run('check')
assert target.read_bytes() == patched and patched != before
before_checksums = json.loads(product)['checksums']
after_checksums = json.loads((app / 'product.json').read_text())['checksums']
assert len(after_checksums) == len(before_checksums) + 1, 'The native module is also covered by integrity validation'
for key, value in before_checksums.items():
    if key != 'vs/workbench/workbench.desktop.main.js':
        assert after_checksums[key] == value, 'Existing integrity checks remain unchanged'
target_manifest = (app / 'product.json').read_bytes()
(app / 'product.json').write_bytes(target_manifest + b'\n'); run('restore', False)
assert target.read_bytes() == patched
(app / 'product.json').write_bytes(target_manifest)
target.write_bytes(patched + b'\n'); run('restore', False)
assert target.read_bytes() == patched + b'\n'
target.write_bytes(patched); run('restore'); assert target.read_bytes() == before
assert (app / 'product.json').read_bytes() == product, 'The original build manifest is restored exactly'
assert not (workbench / 'review-native.mjs').exists()
run('restore')
target.write_bytes(before + b'\n'); run('apply', False)
assert target.read_bytes() == before + b'\n'
target.write_bytes(before)
package = json.loads((app / 'package.json').read_text()); package['version'] = '99.0.0'
(app / 'package.json').write_text(json.dumps(package)); run('apply', False)
assert target.read_bytes() == before
print('PASS: native version/hash guards, idempotence, active integrity checks and exact rollback')
