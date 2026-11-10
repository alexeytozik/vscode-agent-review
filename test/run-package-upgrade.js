'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
const { fromManifest } = require('./extension-id');
function inspect(vsix) {
  const result = spawnSync('unzip', ['-p', vsix, 'extension/package.json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot inspect upgrade package.');
  const manifest = JSON.parse(result.stdout), id = fromManifest(manifest);
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('The upgrade package needs a version.');
  return { id, version: manifest.version, vsix };
}
async function prepareOutbox(root) {
  const checkpoint = path.join(root, 'checkpoint.json'), saved = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
  const cache = path.join(saved.storage, 'request-review.json'), state = JSON.parse(await fs.readFile(cache, 'utf8'));
  const full = path.join(root, 'workspace', 'reviewed.txt');
  await fs.writeFile(full, 'original\n');
  saved.feedback = [{ id: 'e'.repeat(64), turn: 'upgrade/reviewed', path: await fs.realpath(full), action: 'reject', created: Date.now() }];
  state.feedback = saved.feedback;
  saved.archive = JSON.stringify(state);
  await fs.writeFile(cache, saved.archive);
  await fs.writeFile(checkpoint, JSON.stringify(saved));
}
async function main() {
  const baseline = process.env.REVIEW_BASELINE_VSIX, target = process.env.REVIEW_VSIX;
  if (!baseline || !target) throw new Error('Set REVIEW_BASELINE_VSIX and REVIEW_VSIX for the isolated package upgrade.');
  const oldPackage = inspect(baseline), newPackage = inspect(target), crossId = oldPackage.id.toLowerCase() !== newPackage.id.toLowerCase();
  delete process.env.ELECTRON_RUN_AS_NODE;
  const source = path.resolve(__dirname, '..'), root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-upgrade.')), workspace = path.join(root, 'workspace'), user = path.join(root, 'user'), extensions = path.join(root, 'extensions'), home = path.join(root, 'home'), harness = path.join(root, 'harness');
  for (const directory of [workspace, extensions, home, harness, path.join(user, 'User')]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(harness, 'package.json'), JSON.stringify({ name: 'review-check', publisher: 'local-tests', version: '0.0.0', engines: { vscode: '^1.96.0' }, main: './index.js' })); await fs.writeFile(path.join(harness, 'index.js'), 'exports.activate=()=>{};');
  await fs.writeFile(path.join(user, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'telemetry.telemetryLevel': 'off', 'files.autoSave': 'off', 'changeReview.view': 'review', 'changeReview.enabled': true }));
  const executable = process.env.REVIEW_VSCODE_EXECUTABLE || await downloadAndUnzipVSCode(process.env.REVIEW_EDITOR_VERSION || 'stable'), cli = resolveCliArgsFromVSCodeExecutablePath(executable), results = [];
  for (const [stage, pkg] of [['before', oldPackage], ['after', newPackage]]) {
    const install = spawnSync(cli[0], [...cli.slice(1), '--user-data-dir=' + user, '--extensions-dir=' + extensions, '--install-extension', pkg.vsix, '--force'], { encoding: 'utf8' }); if (install.status !== 0) throw new Error('Isolated upgrade install failed: ' + install.stderr);
    const phases = stage === 'after' && crossId && process.env.REVIEW_UPGRADE_COEXIST === '1' ? ['coexist', 'after'] : [stage];
    for (const phase of phases) {
      const resultFile = path.join(root, phase + '.json');
      const disabled = phase === 'after' && crossId ? ['--disable-extension', oldPackage.id] : [];
      await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: harness, extensionTestsPath: path.join(__dirname, 'package-upgrade.integration.js'), launchArgs: [workspace, '--user-data-dir=' + user, '--extensions-dir=' + extensions, ...disabled, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window'], extensionTestsEnv: { REVIEW_TEST_PHASE: phase, REVIEW_RESULT_FILE: resultFile, REVIEW_UPGRADE_ROOT: root, REVIEW_UPGRADE_ID: pkg.id, REVIEW_UPGRADE_PREVIOUS_ID: oldPackage.id, REVIEW_UPGRADE_VERSION: pkg.version, REVIEW_UPGRADE_EXTENSIONS: extensions, REVIEW_UPGRADE_OFF: process.env.REVIEW_UPGRADE_OFF || '1', CODEX_HOME: home } });
      const result = JSON.parse(await fs.readFile(resultFile, 'utf8')); if (!result.passed) throw new Error(result.error);
      // No extension host is alive while preparing the next migration fixture.
      if (crossId && (phase === 'coexist' || phase === 'before' && process.env.REVIEW_UPGRADE_COEXIST !== '1')) await prepareOutbox(root);
      results.push({ phase, id: pkg.id, version: pkg.version, ...result });
    }
  }
  const report = { passed: true, crossId, previousId: oldPackage.id, targetId: newPackage.id, results }; await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(report, null, 2));
  const destination = process.env.REVIEW_UPGRADE_REPORT; if (destination) await fs.writeFile(destination, JSON.stringify(report, null, 2)); console.log('Report: ' + path.join(root, 'results.json'));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
