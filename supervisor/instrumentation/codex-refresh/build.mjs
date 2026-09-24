import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkEntry, checkManifest, checkWorkspace, sha256 } from './prepare.mjs';
import { decodeBoundaryJournal } from '../../lib/refresh-boundary-source.mjs';

const NATIVE_FILES = [
  'codex-rs/Cargo.lock',
  'codex-rs/windows-sandbox-rs/Cargo.toml',
  'codex-rs/windows-sandbox-rs/src/lib.rs',
  'codex-rs/windows-sandbox-rs/src/refresh_boundary.rs',
];

export function admitWireRecipe(manifest, recipe, patch, recipeBytes) {
  checkManifest(manifest);
  if (manifest.patchSha256 !== sha256(patch)) throw new Error('patch-mismatch');
  if (manifest.recipeSha256 !== sha256(recipeBytes)) throw new Error('recipe-mismatch');
  if (
    recipe.version !== 1 ||
    recipe.stage !== 'wire-only' ||
    recipe.target !== manifest.target ||
    recipe.toolchain !== manifest.toolchain
  )
    throw new Error('unsupported-recipe');
  if (
    !Array.isArray(recipe.tests) ||
    !recipe.tests.length ||
    new Set(recipe.tests).size !== recipe.tests.length ||
    recipe.tests.some(
      (name) => !/^refresh_boundary::tests::refresh_boundary_wire_[a-z_]+$/u.test(name),
    )
  )
    throw new Error('invalid-test-list');
  if (
    !Array.isArray(recipe.inputs) ||
    recipe.inputs.length !== NATIVE_FILES.length ||
    NATIVE_FILES.some(
      (name) =>
        recipe.inputs.filter((input) => input.path === name && /^[a-f0-9]{64}$/u.test(input.sha256))
          .length !== 1,
    )
  )
    throw new Error('invalid-input-list');
}

export function verifyWireInputs(projectRoot, sourceReceipt, recipe, io = fs) {
  if (
    sourceReceipt.inputs.length !== 6497 ||
    sourceReceipt.sourceCommit !== '3d2ee51ca2d5db578f328aa75e20aa22c0197c9a'
  )
    throw new Error('invalid-source-receipt');
  const root = checkWorkspace(
    projectRoot,
    path.join(projectRoot, '.matchlog/0372-refresh/source'),
    io,
  );
  const expected = new Map();
  for (const input of sourceReceipt.inputs) {
    checkEntry(input.path);
    if (expected.has(input.path)) throw new Error('duplicate-source-input');
    expected.set(input.path, input.sha256);
  }
  for (const input of recipe.inputs) expected.set(checkEntry(input.path), input.sha256);
  const seen = new Set();
  function visit(directory, prefix) {
    for (const name of io.readdirSync(directory)) {
      const relative = checkEntry(prefix ? `${prefix}/${name}` : name);
      const absolute = checkWorkspace(root, path.join(root, relative), io);
      const stat = io.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute, relative);
      else {
        if (!stat.isFile() || !expected.has(relative)) throw new Error('unexpected-source-input');
        if (sha256(io.readFileSync(absolute)) !== expected.get(relative))
          throw new Error('source-input-mismatch');
        seen.add(relative);
      }
    }
  }
  visit(root, '');
  if (seen.size !== expected.size) throw new Error('missing-source-input');
  return { root, count: seen.size };
}

export function checkNativeTestList(text, expected) {
  const names = text
    .split(/\r?\n/u)
    .filter((line) => line.endsWith(': test'))
    .map((line) => line.slice(0, -6))
    .sort();
  if (!names.length || JSON.stringify(names) !== JSON.stringify([...expected].sort()))
    throw new Error('native-test-list-mismatch');
  return names;
}

export function verifyAppliedPatch(sourceRoot, patchPath, run = spawnSync) {
  // Хеши patch и source по отдельности не доказывают, что тестировался этот patch.
  const result = run('git', ['-C', sourceRoot, 'apply', '--check', '--reverse', patchPath], {
    shell: false,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) throw new Error('patch-source-mismatch');
}

// Only the wire step is implemented. Final build/reproduce/package/delivery
// remain unavailable until their independent checks and receipts exist.
export function runBuild({ projectRoot, mode, group }, dependencies = {}) {
  if (mode !== 'check' || group !== 'wire') throw new Error('unsupported-build-mode');
  const io = dependencies.fs ?? fs;
  const run = dependencies.run ?? spawnSync;
  const now = dependencies.now ?? (() => new Date());
  const root = io.realpathSync(projectRoot);
  const packageRoot = path.join(root, 'supervisor/instrumentation/codex-refresh');
  const manifest = JSON.parse(
    io.readFileSync(path.join(packageRoot, 'source-manifest.json'), 'utf8'),
  );
  const recipeBytes = io.readFileSync(path.join(packageRoot, 'build-recipe.json'));
  const recipe = JSON.parse(recipeBytes);
  const patch = io.readFileSync(path.join(packageRoot, 'refresh-boundary.patch'));
  admitWireRecipe(manifest, recipe, patch, recipeBytes);
  const sourceReceipt = JSON.parse(
    io.readFileSync(path.join(packageRoot, 'receipts/source.json'), 'utf8'),
  );
  const verified = verifyWireInputs(root, sourceReceipt, recipe, io);
  verifyAppliedPatch(verified.root, path.join(packageRoot, 'refresh-boundary.patch'), run);
  const workspace = checkWorkspace(root, path.join(root, '.matchlog/0372-refresh'), io);
  const directories = ['cargo-home', 'target-preflight', 'temp'];
  for (const name of directories)
    io.mkdirSync(checkWorkspace(root, path.join(workspace, name), io), { recursive: true });
  const fixture = checkWorkspace(root, path.join(workspace, 'wire-fixture.bin'), io);
  const env = {
    ...process.env,
    CARGO_HOME: path.join(workspace, 'cargo-home'),
    CARGO_TARGET_DIR: path.join(workspace, 'target-preflight'),
    TMP: path.join(workspace, 'temp'),
    TEMP: path.join(workspace, 'temp'),
    REFRESH_BOUNDARY_TEST_FIXTURE: fixture,
  };
  const started = now();
  const receipt = {
    receiptVersion: 1,
    stage: 'wire-only',
    sourceCommit: manifest.sourceCommit,
    patchSha256: manifest.patchSha256,
    recipeSha256: manifest.recipeSha256,
    startedUtc: started.toISOString(),
    runtimeExecuted: false,
    productionWindowsBoundaryTested: false,
    verifiedSourceInputs: verified.count,
    commands: [],
    tests: [],
    status: 'running',
  };
  const output = checkWorkspace(root, path.join(workspace, 'wire-check-receipt.json'), io);
  const base = ['run', '1.95.0', 'cargo'];
  const target = [
    '--locked',
    '--offline',
    '-j',
    '2',
    '--target',
    'x86_64-pc-windows-msvc',
    '-p',
    'codex-windows-sandbox',
    '--lib',
  ];
  function execute(args) {
    const remaining = 7200000 - (now().getTime() - started.getTime());
    if (remaining <= 0) throw new Error('wire-deadline');
    const result = run('rustup', [...base, ...args], {
      cwd: path.join(verified.root, 'codex-rs'),
      env,
      shell: false,
      windowsHide: true,
      timeout: remaining,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    receipt.commands.push({
      command: ['rustup', ...base, ...args],
      status: result.status,
      error: result.error ? 'process-error' : null,
      stdoutSha256: sha256(result.stdout ?? ''),
      stderrSha256: sha256(result.stderr ?? ''),
    });
    if (result.error || result.status !== 0) throw new Error('wire-command-failed');
    return result.stdout;
  }
  try {
    // Старый fixture не должен подменять отсутствующий output нового harness.
    if (io.existsSync(fixture)) io.unlinkSync(fixture);
    execute(['check', ...target]);
    const args = ['test', ...target, 'refresh_boundary'];
    receipt.tests = checkNativeTestList(execute([...args, '--', '--list']), recipe.tests);
    const stdout = execute([...args, '--', '--nocapture']);
    if (!stdout.includes(`test result: ok. ${recipe.tests.length} passed; 0 failed;`))
      throw new Error('native-test-count-mismatch');
    const fixtureBytes = io.readFileSync(fixture);
    const decoded = decodeBoundaryJournal(fixtureBytes, {
      expectedWriterIds: ['root'],
      collectionId: 'collection',
      launchId: 'launch',
    });
    if (!decoded.integrity || !decoded.completeness || decoded.frames.length !== 2)
      throw new Error('native-reader-mismatch');
    receipt.reader = {
      integrity: decoded.integrity,
      completeness: decoded.completeness,
      sourceAvailable: decoded.sourceAvailable,
      frames: decoded.frames.length,
    };
    receipt.fixture = { path: fixture, size: fixtureBytes.length, sha256: sha256(fixtureBytes) };
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed';
    const allowed = [
      'wire-deadline',
      'wire-command-failed',
      'native-test-list-mismatch',
      'native-test-count-mismatch',
      'native-reader-mismatch',
    ];
    receipt.failure = allowed.includes(error.message) ? error.message : 'wire-output-unavailable';
  }
  receipt.finishedUtc = now().toISOString();
  io.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
