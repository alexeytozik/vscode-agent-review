'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
async function main() {
  const baseline = process.env.REVIEW_BASELINE_VSIX, target = process.env.REVIEW_VSIX;
  if (!baseline || !target) throw new Error('Set REVIEW_BASELINE_VSIX and REVIEW_VSIX for the isolated package upgrade.');
  delete process.env.ELECTRON_RUN_AS_NODE;
  const source = path.resolve(__dirname, '..'), root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-upgrade.')), workspace = path.join(root, 'workspace'), user = path.join(root, 'user'), extensions = path.join(root, 'extensions'), home = path.join(root, 'home'), harness = path.join(root, 'harness');
  for (const directory of [workspace, extensions, home, harness, path.join(user, 'User')]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(harness, 'package.json'), JSON.stringify({ name: 'review-check', publisher: 'local-tests', version: '0.0.0', engines: { vscode: '^1.96.0' }, main: './index.js' })); await fs.writeFile(path.join(harness, 'index.js'), 'exports.activate=()=>{};');
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'telemetry.telemetryLevel': 'off', 'files.autoSave': 'off', 'changeReview.view': 'review', 'changeReview.enabled': true }));
  const executable = process.env.REVIEW_VSCODE_EXECUTABLE || await downloadAndUnzipVSCode(process.env.REVIEW_EDITOR_VERSION || 'stable'), cli = resolveCliArgsFromVSCodeExecutablePath(executable), results = [];
  for (const [phase, vsix] of [['before', baseline], ['after', target]]) {
    const manifest = spawnSync('unzip', ['-p', vsix, 'extension/package.json'], { encoding: 'utf8' }); if (manifest.status !== 0) throw new Error('Cannot inspect upgrade package.');
    const version = JSON.parse(manifest.stdout).version;
    const install = spawnSync(cli[0], [...cli.slice(1), '--user-data-dir=' + user, '--extensions-dir=' + extensions, '--install-extension', vsix, '--force'], { encoding: 'utf8' }); if (install.status !== 0) throw new Error('Isolated upgrade install failed: ' + install.stderr);
    const resultFile = path.join(root, phase + '.json');
    await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: harness, extensionTestsPath: path.join(__dirname, 'package-upgrade.integration.js'), launchArgs: [workspace, '--user-data-dir=' + user, '--extensions-dir=' + extensions, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window'], extensionTestsEnv: { REVIEW_TEST_PHASE: phase, REVIEW_RESULT_FILE: resultFile, REVIEW_UPGRADE_ROOT: root, REVIEW_UPGRADE_VERSION: version, REVIEW_UPGRADE_EXTENSIONS: extensions, REVIEW_UPGRADE_OFF: process.env.REVIEW_UPGRADE_OFF || '1', CODEX_HOME: home } });
    const result = JSON.parse(await fs.readFile(resultFile, 'utf8')); if (!result.passed) throw new Error(result.error); results.push({ phase, version, ...result });
  }
  const report = { passed: true, results }; await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(report, null, 2));
  const destination = process.env.REVIEW_UPGRADE_REPORT; if (destination) await fs.writeFile(destination, JSON.stringify(report, null, 2)); console.log('Report: ' + path.join(root, 'results.json'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
