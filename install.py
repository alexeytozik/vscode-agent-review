#!/usr/bin/env python3
"""Apply or restore one versioned local integration patch."""
import argparse
import datetime
import hashlib
import json
import pathlib
import shutil

VERSION = '26.1007.21434'
SHA256 = 'a8069de80c8f8141481d033f94c3a95e1b59f399143cb2554d3f68469dfbe5b8'
ANCHOR = 'let v=new QN,w=y.startCodexProcess();'
REPLACEMENT = 'e.push(require("./review-bridge").attach(y));' + ANCHOR
source = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['apply', 'restore', 'check'])
parser.add_argument('--extension', required=True, type=pathlib.Path)
parser.add_argument('--settings', type=pathlib.Path, help='Configure inline review in this profile; restore preserves unrelated settings')
args = parser.parse_args()
extension = args.extension.resolve()
main = extension / 'out/extension.js'
bridge = extension / 'out/review-bridge.js'
record = extension / 'out/review-patch.json'
digest = lambda data: hashlib.sha256(data).hexdigest()

def write_settings(target, data):
    temporary = target.with_name(target.name + '.review-tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=4) + '\n')
    temporary.chmod(0o600)
    temporary.replace(target)

def configure(state):
    if not args.settings or 'configuration' in state:
        return
    target = args.settings.resolve()
    data = json.loads(target.read_text())
    changes = {'chatgpt.commentCodeLensEnabled': False}
    removed = ['changeReview.scope', 'changeReview.autoStart']
    keys = list(changes) + removed
    previous = {key: {'present': key in data, 'value': data.get(key)} for key in keys}
    shutil.copy2(target, pathlib.Path(state['backup']) / 'settings.json')
    (pathlib.Path(state['backup']) / 'settings.json').chmod(0o600)
    for key in removed:
        data.pop(key, None)
    data.update(changes)
    applied = {key: {'present': key in data, 'value': data.get(key)} for key in keys}
    state['configuration'] = {'path': str(target), 'before': previous, 'applied': applied}
    record.write_text(json.dumps(state, indent=2))
    write_settings(target, data)

def restore_configuration(state):
    config = state.get('configuration')
    if not config:
        return
    target = pathlib.Path(config['path'])
    data = json.loads(target.read_text())
    for key, applied in config['applied'].items():
        if {'present': key in data, 'value': data.get(key)} != applied:
            print('Preserved a setting changed after installation:', key)
            continue
        previous = config['before'][key]
        if previous['present']:
            data[key] = previous['value']
        else:
            data.pop(key, None)
    write_settings(target, data)
package = json.loads((extension / 'package.json').read_text())
assert package['publisher'] == 'openai' and package['name'] == 'chatgpt', 'Unexpected extension'
assert package['version'] == VERSION, 'Unsupported version; verify a new version before patching'
original = main.read_bytes()
if args.action == 'restore':
    if not record.exists():
        assert digest(original) == SHA256, 'Unknown unpatched package'
        print('PASS: already original')
    else:
        state = json.loads(record.read_text())
        assert digest(original) == state['patched'], 'Patched package changed; refusing overwrite'
        backup = pathlib.Path(state['backup']) / 'extension.js'
        assert digest(backup.read_bytes()) == SHA256, 'Backup mismatch'
        restore_configuration(state)
        shutil.copy2(backup, main)
        bridge.unlink(missing_ok=True)
        record.unlink()
        print('PASS: original restored; working files untouched')
elif record.exists():
    state = json.loads(record.read_text())
    assert digest(original) == state['patched'], 'Patched package changed'
    assert bridge.read_bytes() == (source / 'bridge.js').read_bytes(), 'Bridge changed; restore before upgrade'
    if args.action == 'apply':
        configure(state)
    print('PASS: patch already installed')
else:
    assert digest(original) == SHA256, 'Unknown package checksum'
    assert original.count(ANCHOR.encode()) == 1, 'Integration anchor mismatch'
    if args.action == 'check':
        print('PASS: original package is supported')
    else:
        backup = pathlib.Path.home() / '.config/editor-backups' / ('review-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
        backup.mkdir(parents=True, mode=0o700)
        shutil.copy2(main, backup / 'extension.js')
        shutil.copy2(extension / 'package.json', backup / 'package.json')
        patched = original.replace(ANCHOR.encode(), REPLACEMENT.encode(), 1)
        shutil.copy2(source / 'bridge.js', bridge)
        main.write_bytes(patched)
        state = {'version': VERSION, 'original': SHA256, 'patched': digest(patched), 'backup': str(backup)}
        record.write_text(json.dumps(state, indent=2))
        configure(state)
        print('PASS: minimal event bridge installed; backup:', backup)
