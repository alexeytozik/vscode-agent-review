#!/usr/bin/env python3
"""Verify the exact supported VSIX surface and equality with local source bytes."""
import hashlib
import json
import pathlib
import sys
import zipfile
import xml.etree.ElementTree as ET

source = pathlib.Path(__file__).resolve().parents[1]
artifact = pathlib.Path(sys.argv[1]).resolve()
expected = set(json.loads((source / 'test/package-files.json').read_text()))
source_names = {'readme.md': 'README.md', 'changelog.md': 'CHANGELOG.md', 'LICENSE.txt': 'LICENSE'}
manifest = json.loads((source / 'package.json').read_text())
with zipfile.ZipFile(artifact) as archive:
    names = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
    assert len(names) == len(set(names)), 'Duplicate archive entries'
    assert set(name for name in names if not name.startswith('extension/')) == {'extension.vsixmanifest', '[Content_Types].xml'}, 'Unexpected VSIX metadata'
    actual = {name.removeprefix('extension/') for name in names if name.startswith('extension/')}
    assert actual == expected, f'Package surface differs: missing={sorted(expected-actual)}, extra={sorted(actual-expected)}'
    for name in sorted(actual):
        local = (source / source_names.get(name, name)).resolve()
        assert local.is_relative_to(source), 'Unsafe archive path'
        content = local.read_bytes()
        if name == 'readme.md':
            content = content.replace(b'"media/icon.png"', b'"https://github.com/alexeytozik/vscode-agent-review/raw/HEAD/media/icon.png"').replace(b'](docs/setup.md)', b'](https://github.com/alexeytozik/vscode-agent-review/blob/HEAD/docs/setup.md)')
        assert archive.read('extension/' + name) == content, f'Packaged bytes differ: {name}'
    packaged = json.loads(archive.read('extension/package.json'))
    assert packaged == manifest
    assert packaged['main'] == './review.js' and packaged['publisher'] == 'alexeytozik'
    assert packaged['engines']['vscode'] == '^1.96.0'
    assert packaged['dependencies'] == {'diff': '9.0.0', 'picomatch': '4.0.7'}
    runtime_dependencies = {name.split('/')[1] for name in actual if name.startswith('node_modules/')}
    assert runtime_dependencies == {'diff', 'picomatch'}
    identity = ET.fromstring(archive.read('extension.vsixmanifest')).find('{*}Metadata/{*}Identity')
    assert identity is not None and identity.attrib['Publisher'] == packaged['publisher'] and identity.attrib['Version'] == packaged['version']
report = {'passed': True, 'artifact': str(artifact), 'sha256': hashlib.sha256(artifact.read_bytes()).hexdigest(), 'extensionFiles': len(expected), 'version': manifest['version'], 'sourceBytesEqual': True, 'documentTransforms': 'vsce canonical names and two README links', 'runtimeDependencies': sorted(runtime_dependencies)}
destination = source / 'output/validation/package.json'
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
