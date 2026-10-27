#!/usr/bin/env python3
"""Exercise installers only against disposable application and profile copies."""
import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
APP = Path('/Applications/Visual Studio Code.app/Contents/Resources/app')
VENDOR = Path.home() / '.vscode/extensions/openai.chatgpt-26.1007.21434-darwin-arm64'


def original_file(root, record_name, name):
    record = root / record_name
    if record.exists():
        backup = Path(json.loads(record.read_text())['backup']) / name
        if backup.exists():
            return backup.read_bytes()
    return (root / name).read_bytes()


class InstallerCases(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        workbench = APP / 'out/vs/workbench'
        cls.main_bytes = original_file(workbench, 'review-native-patch.json', 'workbench.desktop.main.js')
        record = workbench / 'review-native-patch.json'
        cls.product_bytes = (Path(json.loads(record.read_text())['backup']) / 'product.json').read_bytes() if record.exists() else (APP / 'product.json').read_bytes()
        cls.version = json.loads((APP / 'package.json').read_text())['version']
        cls.vendor_bytes = original_file(VENDOR / 'out', 'review-patch.json', 'extension.js') if (VENDOR / 'out/extension.js').exists() else None

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='review-installer-cases.')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'profile'; self.home.mkdir()
        self.app = self.root / 'Editor Test.app'
        self.resources = self.app / 'Contents/Resources/app'
        self.workbench = self.resources / 'out/vs/workbench'; self.workbench.mkdir(parents=True)
        (self.resources / 'package.json').write_text(json.dumps({'version': self.version}))
        self.main = self.workbench / 'workbench.desktop.main.js'; self.main.write_bytes(self.main_bytes); self.main.chmod(0o640)
        self.product = self.resources / 'product.json'; self.product.write_bytes(self.product_bytes)
        self.module = self.workbench / 'review-native.mjs'
        self.record = self.workbench / 'review-native-patch.json'
        self.vendor = self.root / 'vendor'; (self.vendor / 'out').mkdir(parents=True)
        if self.vendor_bytes is not None:
            (self.vendor / 'package.json').write_bytes((VENDOR / 'package.json').read_bytes())
        self.vendor_main = self.vendor / 'out/extension.js'
        if self.vendor_bytes is not None:
            self.vendor_main.write_bytes(self.vendor_bytes)
        self.settings = self.root / 'settings.json'; self.settings.write_text(json.dumps({'unrelated': 1, 'changeReview.scope': '/tmp/example'}))

    def run_installer(self, native, action):
        if not native and self.vendor_bytes is None:
            self.skipTest('The legacy vendor build is not installed')
        script = SOURCE / ('install-native.py' if native else 'install.py')
        arguments = [str(script), action, '--app', str(self.app)] if native else [str(script), action, '--extension', str(self.vendor), '--settings', str(self.settings)]
        with patch.object(sys, 'argv', arguments), patch.object(Path, 'home', return_value=self.home), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(script), run_name='__main__')

    def test_native_clean_check_does_not_write(self):
        self.run_installer(True, 'check'); self.assertEqual(self.main.read_bytes(), self.main_bytes); self.assertFalse(self.record.exists()); self.assertFalse(self.module.exists())

    def test_native_idempotence_preserves_record_and_backup(self):
        self.run_installer(True, 'apply'); state = self.record.read_bytes(); self.run_installer(True, 'apply'); self.assertEqual(self.record.read_bytes(), state)

    def test_native_exact_rollback_and_file_mode(self):
        self.run_installer(True, 'apply'); self.run_installer(True, 'restore'); self.assertEqual(self.main.read_bytes(), self.main_bytes); self.assertEqual(self.product.read_bytes(), self.product_bytes); self.assertEqual(self.main.stat().st_mode & 0o777, 0o640); self.assertFalse(self.record.exists()); self.assertFalse(self.module.exists())

    def test_native_build_manifest_preserves_existing_checks(self):
        before = json.loads(self.product_bytes)['checksums']; self.run_installer(True, 'apply'); after = json.loads(self.product.read_text())['checksums']
        self.assertEqual(len(after), len(before) + 1)
        for name, checksum in before.items():
            if name != 'vs/workbench/workbench.desktop.main.js': self.assertEqual(after[name], checksum)
        for name in ['workbench.desktop.main.js', 'review-native.mjs']:
            checksum = base64.b64encode(hashlib.sha256((self.workbench / name).read_bytes()).digest()).decode().rstrip('=')
            self.assertEqual(after['vs/workbench/' + name], checksum)

    def test_native_original_restore_is_idempotent(self):
        self.run_installer(True, 'restore'); self.run_installer(True, 'restore'); self.assertEqual(self.main.read_bytes(), self.main_bytes)

    def test_native_missing_module_refuses_restore_before_writing(self):
        self.run_installer(True, 'apply'); before = self.main.read_bytes(); self.module.unlink()
        with self.assertRaises(OSError): self.run_installer(True, 'restore')
        self.assertEqual(self.main.read_bytes(), before)

    def test_vendor_check_does_not_patch(self):
        self.run_installer(False, 'check'); self.assertEqual(self.vendor_main.read_bytes(), self.vendor_bytes)

    def test_vendor_apply_is_idempotent(self):
        self.run_installer(False, 'apply'); before = self.vendor_main.read_bytes(); self.run_installer(False, 'apply'); self.assertEqual(self.vendor_main.read_bytes(), before)

    def test_vendor_restore_preserves_independent_setting_changes(self):
        self.run_installer(False, 'apply'); data = json.loads(self.settings.read_text()); data['unrelated'] = 2; self.settings.write_text(json.dumps(data)); self.run_installer(False, 'restore')
        restored = json.loads(self.settings.read_text()); self.assertEqual(restored['unrelated'], 2); self.assertEqual(restored['changeReview.scope'], '/tmp/example'); self.assertEqual(self.vendor_main.read_bytes(), self.vendor_bytes)

    def test_vendor_restore_preserves_user_override_of_owned_setting(self):
        self.run_installer(False, 'apply'); data = json.loads(self.settings.read_text()); data['chatgpt.commentCodeLensEnabled'] = True; self.settings.write_text(json.dumps(data)); self.run_installer(False, 'restore'); self.assertTrue(json.loads(self.settings.read_text())['chatgpt.commentCodeLensEnabled'])

    def test_vendor_changed_bridge_refuses_check(self):
        self.run_installer(False, 'apply'); bridge = self.vendor / 'out/review-bridge.js'; bridge.write_bytes(bridge.read_bytes() + b'\n'); before = self.vendor_main.read_bytes()
        with self.assertRaises(AssertionError): self.run_installer(False, 'check')
        self.assertEqual(self.vendor_main.read_bytes(), before)


def native_guard(name, installed, target):
    def run(self):
        if installed: self.run_installer(True, 'apply')
        if target == 'version':
            (self.resources / 'package.json').write_text(json.dumps({'version': '99.0.0'}))
        elif target == 'known-version':
            version = '1.141.0' if self.version != '1.141.0' else '1.143.1'
            (self.resources / 'package.json').write_text(json.dumps({'version': version}))
        elif target in ['record-version', 'record-original']:
            state = json.loads(self.record.read_text())
            state['version' if target == 'record-version' else 'original'] = 'unknown'
            self.record.write_text(json.dumps(state))
        elif target == 'unmanaged-module': self.module.write_text('unmanaged')
        else:
            file = {'main': self.main, 'product': self.product, 'module': self.module}.get(target)
            if file is None:
                state = json.loads(self.record.read_text()); file = Path(state['backup']) / ('product.json' if target == 'backup-product' else 'workbench.desktop.main.js')
            file.write_bytes(file.read_bytes() + b'\n')
        main, product = self.main.read_bytes(), self.product.read_bytes()
        with self.assertRaises(AssertionError): self.run_installer(True, 'restore' if installed else 'apply')
        self.assertEqual(self.main.read_bytes(), main); self.assertEqual(self.product.read_bytes(), product)
    run.__name__ = 'test_native_guard_' + name
    return run


for name, installed, target in [('unknown-main', False, 'main'), ('unknown-product', False, 'product'), ('version', False, 'version'), ('known-version', False, 'known-version'), ('record-version', True, 'record-version'), ('record-original', True, 'record-original'), ('unmanaged-module', False, 'unmanaged-module'), ('patched-main', True, 'main'), ('patched-product', True, 'product'), ('patched-module', True, 'module'), ('backup-main', True, 'backup-main'), ('backup-product', True, 'backup-product')]:
    setattr(InstallerCases, 'test_native_guard_' + name.replace('-', '_'), native_guard(name, installed, target))


if __name__ == '__main__': unittest.main(verbosity=2)
