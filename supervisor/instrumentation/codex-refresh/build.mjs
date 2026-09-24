import * as fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { checkEntry, checkManifest, checkWorkspace, sha256 } from './prepare.mjs';
import {
  decodeBoundaryJournal,
  validateBoundaryToken,
  MAX_BOUNDARY_FRAME,
} from '../../lib/refresh-boundary-source.mjs';

export const DELIVERY_ROOT = 'C:/src/dezintegra/TD_Game/.matchlog/refresh-source-deliveries/0372';
const HASH = /^[a-f0-9]{64}$/u;

// Индекс не содержит собственный hash: digest однозначно задан отсортированной описью.
export function admitPackageIndex(index) {
  if (
    !index ||
    index.version !== 1 ||
    !HASH.test(index.buildId) ||
    !Array.isArray(index.files) ||
    !index.files.length ||
    index.files.length > 10000 ||
    Object.keys(index).sort().join(',') !== 'buildId,files,version'
  )
    throw new Error('invalid-package-index');
  const names = new Set();
  let previous = '';
  for (const entry of index.files) {
    checkEntry(entry.path);
    if (
      entry.path === 'package-index.json' ||
      entry.path <= previous ||
      names.has(entry.path.toLowerCase()) ||
      !HASH.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      Object.keys(entry).sort().join(',') !== 'path,sha256,size'
    )
      throw new Error('invalid-package-entry');
    names.add(entry.path.toLowerCase());
    previous = entry.path;
  }
  return sha256(
    JSON.stringify({
      version: 1,
      buildId: index.buildId,
      files: index.files.map(({ path: name, size, sha256: hash }) => ({
        path: name,
        size,
        sha256: hash,
      })),
    }),
  );
}

function ordinaryDirectory(directory, io) {
  const absolute = path.resolve(directory);
  if (
    !io.lstatSync(absolute).isDirectory() ||
    io.lstatSync(absolute).isSymbolicLink() ||
    io.realpathSync(absolute) !== absolute
  )
    throw new Error('package-reparse');
  return absolute;
}

export function verifyPackage(directory, index, io = fs) {
  const packageSha256 = admitPackageIndex(index);
  const root = ordinaryDirectory(directory, io);
  const expected = new Map(index.files.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const files = [];
  function visit(parent, prefix = '') {
    for (const name of io.readdirSync(parent)) {
      const relative = checkEntry(prefix ? `${prefix}/${name}` : name);
      const absolute = checkWorkspace(root, path.join(root, relative), io);
      const stat = io.lstatSync(absolute);
      if (stat.isDirectory()) {
        if (![...expected.keys()].some((key) => key.startsWith(`${relative}/`)))
          throw new Error('unexpected-package-directory');
        visit(absolute, relative);
        continue;
      }
      if (!stat.isFile()) throw new Error('package-file-type');
      if (relative === 'package-index.json') {
        if (admitPackageIndex(JSON.parse(io.readFileSync(absolute, 'utf8'))) !== packageSha256)
          throw new Error('stored-index-mismatch');
        seen.add(relative);
        continue;
      }
      const entry = expected.get(relative);
      if (!entry) throw new Error('unexpected-package-file');
      if (stat.size !== entry.size) throw new Error('package-size-mismatch');
      const bytes = io.readFileSync(absolute);
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256)
        throw new Error('package-hash-mismatch');
      seen.add(relative);
      files.push({ ...entry, absolutePath: absolute });
    }
  }
  visit(root);
  if (seen.size !== index.files.length + 1) throw new Error('missing-package-file');
  return { packageSha256, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

function checkedDestination(destination, io) {
  const absolute = path.resolve(destination);
  if (absolute !== path.resolve(DELIVERY_ROOT)) throw new Error('unsupported-delivery-root');
  // Проверка всех родителей нужна и при ещё не созданном конечном каталоге.
  const volume = path.parse(absolute).root;
  checkWorkspace(volume, absolute, io);
  return absolute;
}

export function verifyDelivery({ destination, index }, dependencies = {}) {
  const io = dependencies.fs ?? fs;
  const packageSha256 = admitPackageIndex(index);
  const root = checkedDestination(destination, io);
  const final = checkWorkspace(root, path.join(root, packageSha256), io);
  const verified = verifyPackage(final, index, io);
  return {
    version: 1,
    status: 'verified',
    ...verified,
    verifiedUtc: (dependencies.now ?? (() => new Date()))().toISOString(),
    runtimeExecuted: false,
    sourceFallback: false,
  };
}

function writeAndFlush(file, bytes, io) {
  bytes = Buffer.from(bytes);
  const descriptor = io.openSync(file, 'wx');
  try {
    let written = 0;
    while (written < bytes.length) {
      const count = io.writeSync(descriptor, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error('package-short-write');
      written += count;
    }
    io.fsyncSync(descriptor);
  } finally {
    io.closeSync(descriptor);
  }
}

export function deliverPackage({ source, destination, index }, dependencies = {}) {
  const io = dependencies.fs ?? fs;
  const now = dependencies.now ?? (() => new Date());
  const verified = verifyPackage(source, index, io);
  const root = checkedDestination(destination, io);
  io.mkdirSync(root, { recursive: true });
  ordinaryDirectory(root, io);
  const final = checkWorkspace(root, path.join(root, verified.packageSha256), io);
  if (io.existsSync(final)) {
    // Идентичный повтор проверяет bytes, а не доверяет имени по digest.
    return { ...verifyDelivery({ destination, index }, { fs: io, now }), reused: true };
  }
  const staging = checkWorkspace(root, path.join(root, `${verified.packageSha256}.staging`), io);
  io.mkdirSync(staging);
  for (const entry of index.files) {
    const target = checkWorkspace(root, path.join(staging, entry.path), io);
    io.mkdirSync(path.dirname(target), { recursive: true });
    writeAndFlush(
      target,
      io.readFileSync(checkWorkspace(source, path.join(source, entry.path), io)),
      io,
    );
  }
  writeAndFlush(path.join(staging, 'package-index.json'), JSON.stringify(index), io);
  verifyPackage(staging, index, io);
  // На закреплённой Windows rename каталога не заменяет существующий каталог.
  if (io.existsSync(final)) throw new Error('delivery-publish-conflict');
  io.renameSync(staging, final);
  return {
    ...verifyDelivery({ destination, index }, { fs: io, now }),
    copiedUtc: now().toISOString(),
    reused: false,
  };
}

const NATIVE_FILES = [
  'codex-rs/Cargo.lock',
  'codex-rs/windows-sandbox-rs/Cargo.toml',
  'codex-rs/windows-sandbox-rs/src/lib.rs',
  'codex-rs/windows-sandbox-rs/src/refresh_boundary.rs',
  'codex-rs/windows-sandbox-rs/src/setup.rs',
  'codex-rs/windows-sandbox-rs/src/identity.rs',
  'codex-rs/windows-sandbox-rs/src/elevated_impl.rs',
  'codex-rs/windows-sandbox-rs/src/desktop_tests.rs',
  'codex-rs/windows-sandbox-rs/src/unified_exec/backends/elevated.rs',
  'codex-rs/windows-sandbox-rs/src/unified_exec/backends/elevated_tests.rs',
  'codex-rs/windows-sandbox-rs/src/spawn_prep.rs',
  'codex-rs/windows-sandbox-rs/src/unified_exec/mod.rs',
];

export function admitWireRecipe(manifest, recipe, patch, recipeBytes) {
  checkManifest(manifest);
  if (manifest.patchSha256 !== sha256(patch)) throw new Error('patch-mismatch');
  if (manifest.recipeSha256 !== sha256(recipeBytes)) throw new Error('recipe-mismatch');
  if (
    recipe.version !== 1 ||
    recipe.stage !== 'partial-source' ||
    recipe.target !== manifest.target ||
    recipe.toolchain !== manifest.toolchain
  )
    throw new Error('unsupported-recipe');
  if (
    !Array.isArray(recipe.tests) ||
    !recipe.tests.length ||
    new Set(recipe.tests).size !== recipe.tests.length ||
    recipe.tests.some(
      (name) =>
        name !==
          'unified_exec::backends::elevated::tests::refresh_boundary_singleflight_blocking_task_preserves_context' &&
        name !==
          'unified_exec::backends::elevated::tests::refresh_boundary_singleflight_retry_preserves_context' &&
        !/^refresh_boundary::(?:tests|token_tests)::refresh_boundary_(?:wire|singleflight|token|dispatch)_[a-z_]+$/u.test(
          name,
        ),
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

// Wire, singleflight and token selection are checked independently. Runtime carriers and
// final build/reproduce/package/delivery
// remain unavailable until their independent checks and receipts exist.
export function runBuild({ projectRoot, mode, group }, dependencies = {}) {
  if (mode === 'negative') return runNegative({ projectRoot, group }, dependencies);
  if (mode !== 'check' || !['wire', 'singleflight', 'token', 'dispatch'].includes(group))
    throw new Error('unsupported-build-mode');
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
  const expectedTests = recipe.tests.filter((name) => name.includes(`refresh_boundary_${group}_`));
  if (!expectedTests.length) throw new Error('invalid-test-list');
  const sourceReceipt = JSON.parse(
    io.readFileSync(path.join(packageRoot, 'receipts/source.json'), 'utf8'),
  );
  const verified = verifyWireInputs(root, sourceReceipt, recipe, io);
  verifyAppliedPatch(verified.root, path.join(packageRoot, 'refresh-boundary.patch'), run);
  const workspace = checkWorkspace(root, path.join(root, '.matchlog/0372-refresh'), io);
  const directories = ['cargo-home', 'target-preflight', 'temp'];
  for (const name of directories)
    io.mkdirSync(checkWorkspace(root, path.join(workspace, name), io), { recursive: true });
  const fixture = checkWorkspace(root, path.join(workspace, `${group}-fixture.bin`), io);
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
    stage: 'partial-source',
    group,
    sourceCommit: manifest.sourceCommit,
    patchSha256: manifest.patchSha256,
    recipeSha256: manifest.recipeSha256,
    driverSha256: sha256(io.readFileSync(path.join(packageRoot, 'build.mjs'))),
    startedUtc: started.toISOString(),
    runtimeExecuted: false,
    productionWindowsBoundaryTested: false,
    verifiedSourceInputs: verified.count,
    commands: [],
    tests: [],
    status: 'running',
  };
  const output = checkWorkspace(root, path.join(workspace, `${group}-check-receipt.json`), io);
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
    const args = ['test', ...target, `refresh_boundary_${group}_`];
    receipt.tests = checkNativeTestList(execute([...args, '--', '--list']), expectedTests);
    const stdout = execute([...args, '--', '--nocapture']);
    if (!stdout.includes(`test result: ok. ${expectedTests.length} passed; 0 failed;`))
      throw new Error('native-test-count-mismatch');
    if (group === 'token') {
      if (io.statSync(fixture).size > MAX_BOUNDARY_FRAME) throw new Error('native-reader-mismatch');
      const fixtureBytes = io.readFileSync(fixture);
      validateBoundaryToken(JSON.parse(fixtureBytes));
      receipt.token = { schemaValid: true, sourceAvailable: false };
      receipt.fixture = {
        path: fixture,
        format: 'token-json',
        size: fixtureBytes.length,
        sha256: sha256(fixtureBytes),
      };
    } else {
      const fixtureBytes = io.readFileSync(fixture);
      const decoded = decodeBoundaryJournal(fixtureBytes, {
        expectedWriterIds: ['root'],
        collectionId: 'collection',
        launchId: 'launch',
      });
      if (
        !decoded.integrity ||
        !decoded.completeness ||
        decoded.frames.length !== { wire: 2, singleflight: 7, dispatch: 10 }[group]
      )
        throw new Error('native-reader-mismatch');
      receipt.reader = {
        integrity: decoded.integrity,
        completeness: decoded.completeness,
        sourceAvailable: decoded.sourceAvailable,
        frames: decoded.frames.length,
      };
      receipt.fixture = { path: fixture, size: fixtureBytes.length, sha256: sha256(fixtureBytes) };
    }
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

// Fixed source mutations only: no user supplied program, path or Cargo filter.
const MUTATIONS = {
  dispatch: [
    [
      'refresh_boundary.rs',
      'reuse-attempt-id',
      'attempt_id: self.next_id()?,',
      'attempt_id: self.attempt_id.clone(),',
      'refresh_boundary::tests::refresh_boundary_dispatch_leaf_and_attempt_identity',
    ],
    [
      'refresh_boundary.rs',
      'ignore-cancelled-attempt',
      'if !self.finished {',
      'if false {',
      'refresh_boundary::tests::refresh_boundary_dispatch_cancelled_attempt_is_incomplete',
    ],
  ],
  singleflight: [
    [
      'setup.rs',
      'lost-join-edge',
      'context.refresh_edge(refresh_id, is_leader);',
      'if is_leader { context.refresh_edge(refresh_id, is_leader); }',
      'refresh_boundary::tests::refresh_boundary_singleflight_join_and_new_flight',
    ],
    [
      'setup.rs',
      'bypass-coalescing',
      'match flights.get(&key) {',
      'match None::<&Arc<SetupFlight>> {',
      'refresh_boundary::tests::refresh_boundary_singleflight_join_and_new_flight',
    ],
  ],
  carrier: [
    [
      'unified_exec/backends/elevated.rs',
      'drop-blocking-context',
      'spawn_blocking(move || run(request))',
      'spawn_blocking(move || { let mut request = request; request.diagnostic = None; run(request) })',
      'unified_exec::backends::elevated::tests::refresh_boundary_singleflight_blocking_task_preserves_context',
    ],
    [
      'unified_exec/backends/elevated.rs',
      'drop-retry-context',
      'refresh(\n                request.diagnostic.as_ref(),',
      'refresh(\n                None,',
      'unified_exec::backends::elevated::tests::refresh_boundary_singleflight_retry_preserves_context',
    ],
    [
      'setup.rs',
      'drop-request-at-flight',
      'run_setup_singleflight_observed(b64.clone(), request.diagnostic, |refresh_id| {',
      'run_setup_singleflight_observed(b64.clone(), None, |refresh_id| {',
      'refresh_boundary::tests::refresh_boundary_singleflight_setup_request_preserves_payload',
    ],
    [
      'setup.rs',
      'drop-request-at-helper',
      'run(&b64, request.codex_home, request.diagnostic, refresh_id)',
      'run(&b64, request.codex_home, None, refresh_id)',
      'refresh_boundary::tests::refresh_boundary_singleflight_setup_request_preserves_payload',
    ],
  ],
  token: [
    [
      'refresh_boundary.rs',
      'fallback-on-denied',
      /Err\(QueryError::Windows\s*\{\s*code: ERROR_NO_TOKEN,\s*\.\.\s*\}\)/gu,
      'Err(_)',
      'refresh_boundary::token_tests::refresh_boundary_token_denied_never_uses_process',
    ],
    [
      'refresh_boundary.rs',
      'ignore-snapshot-change',
      'if before != after {',
      'if false {',
      'refresh_boundary::token_tests::refresh_boundary_token_snapshot_change_is_unstable',
    ],
    [
      'refresh_boundary.rs',
      'ignore-call-token-change',
      'if same_effective_token(&before.snapshot, &after.snapshot) {',
      'if true {',
      'refresh_boundary::token_tests::refresh_boundary_token_acl_rejects_changed_token',
    ],
    [
      'refresh_boundary.rs',
      'replace-acl-result',
      '(dword, Some(observation))',
      '(0, Some(observation))',
      'refresh_boundary::token_tests::refresh_boundary_token_acl_preserves_dword_and_handle_lifetime',
    ],
  ],
};

export function checkMutation({ file, expectedSha256, from, to, test, execute }, io = fs) {
  const original = io.readFileSync(file);
  if (sha256(original) !== expectedSha256) throw new Error('mutation-source-mismatch');
  const text = original.toString('utf8');
  const count =
    typeof from === 'string' ? text.split(from).length - 1 : [...text.matchAll(from)].length;
  if (count !== 1) throw new Error('mutation-site-not-unique');
  const mutated = Buffer.from(text.replace(from, to));
  const sourceSha256 = sha256(mutated);
  const result = { test, sourceSha256, detected: false, restored: false };
  try {
    io.writeFileSync(file, mutated);
    if (sha256(io.readFileSync(file)) !== sourceSha256) throw new Error('mutation-write-mismatch');
    const run = execute(test);
    result.status = run.status;
    result.stdoutSha256 = sha256(run.stdout ?? '');
    result.stderrSha256 = sha256(run.stderr ?? '');
    result.detected =
      !run.error &&
      run.status === 101 &&
      run.stdout.includes(`test ${test} ... FAILED`) &&
      run.stdout.includes('test result: FAILED. 0 passed; 1 failed;');
  } catch {
    result.failure = 'mutation-execution-error';
  } finally {
    try {
      const current = sha256(io.readFileSync(file));
      if (current !== sourceSha256 && current !== expectedSha256) {
        result.failure = 'mutation-restore-failed';
      } else {
        io.writeFileSync(file, original);
        result.restored = sha256(io.readFileSync(file)) === expectedSha256;
      }
    } catch {
      result.failure = 'mutation-restore-failed';
    }
  }
  return result;
}

function runNegative({ projectRoot, group }, dependencies) {
  if (!Object.hasOwn(MUTATIONS, group)) throw new Error('unsupported-build-mode');
  const io = dependencies.fs ?? fs;
  const run = dependencies.run ?? spawnSync;
  const now = dependencies.now ?? (() => new Date());
  const root = io.realpathSync(projectRoot);
  const workspace = checkWorkspace(root, path.join(root, '.matchlog/0372-refresh'), io);
  const checkGroup = group === 'carrier' ? 'singleflight' : group;
  const startedUtc = now().toISOString();
  const baseline = runBuild({ projectRoot, mode: 'check', group: checkGroup }, dependencies);
  const receipt = {
    version: 1,
    stage: 'partial-source',
    group,
    startedUtc,
    patchSha256: baseline.patchSha256,
    recipeSha256: baseline.recipeSha256,
    driverSha256: baseline.driverSha256,
    baseline,
    controls: [],
    runtimeExecuted: false,
    status: 'failed',
  };
  try {
    if (baseline.status !== 'passed') throw new Error('baseline-failed');
    const recipe = JSON.parse(
      io.readFileSync(
        path.join(root, 'supervisor/instrumentation/codex-refresh/build-recipe.json'),
        'utf8',
      ),
    );
    for (const [name, id, from, to, test] of MUTATIONS[group]) {
      if (!baseline.tests.includes(test)) throw new Error('unverified-mutation-test');
      const relative = `codex-rs/windows-sandbox-rs/src/${name}`;
      const expectedSha256 = recipe.inputs.find((entry) => entry.path === relative)?.sha256;
      const file = checkWorkspace(root, path.join(workspace, 'source', relative), io);
      const original = io.readFileSync(file);
      if (sha256(original) !== expectedSha256) throw new Error('mutation-source-mismatch');
      const backup = checkWorkspace(
        root,
        path.join(workspace, `mutation-original-${expectedSha256}.rs`),
        io,
      );
      if (!io.existsSync(backup)) writeAndFlush(backup, original, io);
      if (sha256(io.readFileSync(backup)) !== expectedSha256)
        throw new Error('mutation-backup-mismatch');
      const control = checkMutation(
        {
          file,
          expectedSha256,
          from,
          to,
          test,
          execute: (filter) =>
            run(
              'rustup',
              [
                'run',
                '1.95.0',
                'cargo',
                'test',
                '--locked',
                '--offline',
                '-j',
                '2',
                '--target',
                'x86_64-pc-windows-msvc',
                '-p',
                'codex-windows-sandbox',
                '--lib',
                filter,
                '--',
                '--exact',
              ],
              {
                cwd: path.join(workspace, 'source/codex-rs'),
                shell: false,
                windowsHide: true,
                timeout: 120000,
                maxBuffer: 4 * 1024 * 1024,
                encoding: 'utf8',
                env: {
                  ...process.env,
                  CARGO_HOME: path.join(workspace, 'cargo-home'),
                  CARGO_TARGET_DIR: path.join(workspace, 'target-preflight'),
                  TMP: path.join(workspace, 'temp'),
                  TEMP: path.join(workspace, 'temp'),
                },
              },
            ),
        },
        io,
      );
      receipt.controls.push({ id, backup, expectedSha256, ...control });
      if (!control.detected || !control.restored) throw new Error('mutation-incomplete');
    }
    receipt.restoredCheck = runBuild(
      { projectRoot, mode: 'check', group: checkGroup },
      dependencies,
    );
    if (
      receipt.restoredCheck.status !== 'passed' ||
      receipt.restoredCheck.driverSha256 !== baseline.driverSha256 ||
      receipt.restoredCheck.patchSha256 !== baseline.patchSha256 ||
      receipt.restoredCheck.recipeSha256 !== baseline.recipeSha256
    )
      throw new Error('restored-check-failed');
    receipt.status = 'passed';
  } catch {
    receipt.failure = 'negative-check-incomplete';
  }
  receipt.finishedUtc = now().toISOString();
  io.writeFileSync(
    path.join(workspace, `${group}-negative-receipt.json`),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  return receipt;
}
