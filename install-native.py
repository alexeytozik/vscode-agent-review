#!/usr/bin/env python3
"""Install or restore native review controls for verified VS Code builds."""
import argparse
import base64
import datetime
import hashlib
import json
import pathlib
import shutil

BUILDS = {
    '1.141.0': {
        'main': '631c1d79c4f3af9177ca23a70cfe0cf2586a692678bd897af6c869324160d905',
        'product': '4db1f6986c25ce50ac51453c2d08676df542928a9bc61250c4411565a1d23126',
        'service': 'be', 'registry': 'Ge',
        'anchor': 'nde=I([h(2,vi),h(3,re),h(4,Mt),h(5,V),h(6,nF),h(7,It)],nde);'
    },
    '1.143.1': {
        'main': '987e8e58870a4b7f15d01559e96c44a962c71f85b3b77edd5a2560eb24676f8c',
        'product': 'a141a1de8ed44415c0c527b1882362e6abc25e674be052d67c09da71a27fbd7e',
        'service': 'ye', 'registry': 'Ke',
        'anchor': 'Rpe=I([m(2,yi),m(3,le),m(4,Dt),m(5,U),m(6,f0),m(7,Et)],Rpe);'
    }
}
ROOT = pathlib.Path(__file__).resolve().parent
IMPORT = 'import { reviewNative } from "./review-native.mjs";\n'


def hooks(build):
    execute = f'reviewNative.update(i.getCodeEditor(),e,t,(c,a)=>i.getCodeEditor().invokeWithinContext(s=>s.get({build["service"]}).executeCommand(c,a)))'
    anchor, registry = build['anchor'], build['registry']
    return {
        'i.setDecorations(e,t),Promise.resolve(void 0)': execute + '?i.setDecorations(e,[]):i.setDecorations(e,t),Promise.resolve(void 0)',
        'i.setDecorationsFast(e,t),Promise.resolve(void 0)': execute + '?i.setDecorationsFast(e,[]):i.setDecorationsFast(e,t),Promise.resolve(void 0)',
        '$removeTextEditorDecorationType(o){o=`${this._instanceId}-${o}`,delete': '$removeTextEditorDecorationType(o){o=`${this._instanceId}-${o}`,reviewNative.clear(o),delete',
        anchor: anchor + registry + '.registerCommand("_changeReview.nativeInspect",(s,uri)=>reviewNative.inspect(uri));' + registry + '.registerCommand("_changeReview.nativeAction",(s,arg,action,uri)=>reviewNative.act(uri,action,arg));'
    }


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['check', 'apply', 'restore'])
    parser.add_argument('--app', type=pathlib.Path, default=pathlib.Path('/Applications/Visual Studio Code.app'))
    args = parser.parse_args()
    app = args.app.resolve() / 'Contents/Resources/app'
    workbench = app / 'out/vs/workbench'
    target, module = workbench / 'workbench.desktop.main.js', workbench / 'review-native.mjs'
    product = app / 'product.json'
    record = workbench / 'review-native-patch.json'
    version = json.loads((app / 'package.json').read_text())['version']
    assert version in BUILDS, 'Unsupported VS Code version'
    build = BUILDS[version]
    current = target.read_bytes()
    if record.exists():
        state = json.loads(record.read_text())
        assert state['version'] == version and state['original'] == build['main'], 'Installed integration belongs to another build'
        assert digest(current) == state['patched'], 'Workbench changed after installation; refusing overwrite'
        backup = pathlib.Path(state['backup']) / target.name
        assert digest(backup.read_bytes()) == build['main'], 'Original backup mismatch'
        assert digest(module.read_bytes()) == state['module'], 'Native module changed after installation; refusing overwrite'
        if 'productPatched' in state:
            assert digest(product.read_bytes()) == state['productPatched'], 'Build manifest changed after installation; refusing overwrite'
            assert digest((pathlib.Path(state['backup']) / 'product.json').read_bytes()) == build['product'], 'Original build manifest mismatch'
        if args.action == 'restore':
            shutil.copy2(backup, target)
            if 'productPatched' in state:
                shutil.copy2(pathlib.Path(state['backup']) / 'product.json', product)
            module.unlink(); record.unlink()
            print('PASS: original workbench restored exactly')
        else:
            assert module.read_bytes() == (ROOT / 'review-native.mjs').read_bytes(), 'Native module changed; restore before upgrade'
            print('PASS: native controls installed; workbench and module hashes match')
        return
    assert digest(current) == build['main'], 'Unknown workbench checksum; refusing patch'
    original_product = product.read_bytes()
    assert digest(original_product) == build['product'], 'Unknown build manifest checksum; refusing patch'
    assert not module.exists(), 'Unmanaged native module exists'
    if args.action != 'apply':
        print('PASS: original supported workbench')
        return
    text = current.decode()
    for anchor, replacement in hooks(build).items():
        assert text.count(anchor) == 1, 'Integration anchor mismatch'
        text = text.replace(anchor, replacement, 1)
    patched = (IMPORT + text).encode()
    backup = pathlib.Path.home() / '.config/editor-backups' / ('review-native-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(target, backup / target.name)
    shutil.copy2(product, backup / 'product.json')
    shutil.copy2(ROOT / 'review-native.mjs', module)
    manifest = json.loads(original_product)
    checksum = lambda data: base64.b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
    assert manifest['checksums']['vs/workbench/workbench.desktop.main.js'] == checksum(current)
    manifest['checksums']['vs/workbench/workbench.desktop.main.js'] = checksum(patched)
    manifest['checksums']['vs/workbench/review-native.mjs'] = checksum(module.read_bytes())
    patched_product = (json.dumps(manifest, ensure_ascii=False, indent='\t') + '\n').encode()
    temporary = target.with_suffix('.review-tmp')
    try:
        temporary.write_bytes(patched); temporary.chmod(target.stat().st_mode); temporary.replace(target)
        product.write_bytes(patched_product)
        record.write_text(json.dumps({'version': version, 'original': build['main'], 'patched': digest(patched), 'module': digest(module.read_bytes()), 'productPatched': digest(patched_product), 'backup': str(backup)}, indent=2))
    except BaseException:
        shutil.copy2(backup / target.name, target); shutil.copy2(backup / 'product.json', product)
        module.unlink(missing_ok=True); temporary.unlink(missing_ok=True)
        raise
    print('PASS: native controls installed; backup:', backup)


if __name__ == '__main__':
    main()
