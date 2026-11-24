const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');
const prepareDependencyContext = require('./dependency-context.cjs');
const prepareReviewDependencies = require('./prepare-review-dependencies.cjs');

const toolkit = '@hmcts/ccd-case-ui-toolkit';
const mediaViewer = '@hmcts/media-viewer';
const ccPay = '@hmcts/ccpay-web-component';
const oldCommit = 'a'.repeat(40);
const newCommit = 'b'.repeat(40);

function lockfile(toolkitVersion, mediaVersion) {
  return Buffer.from(
    JSON.stringify({
      'rpx-exui@workspace:.': {
        resolution: 'rpx-exui@workspace:.',
        dependencies: { [toolkit]: 'npm:^7.4.0', [mediaViewer]: 'npm:^4.2.0', [ccPay]: 'npm:6.5.28' },
      },
      [`${toolkit}@npm:^7.4.0`]: { resolution: `${toolkit}@npm:${toolkitVersion}` },
      [`${mediaViewer}@npm:^4.0.0, ${mediaViewer}@npm:^4.2.0`]: { resolution: `${mediaViewer}@npm:${mediaVersion}` },
      [`${ccPay}@npm:6.5.28`]: { resolution: `${ccPay}@npm:6.5.28` },
    })
  );
}

test('shares parsed lockfiles with Yarn staging even when an upstream source commit is unavailable', (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'codex-dependency-test-'));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const base = lockfile('7.4.26', '4.2.48');
  const head = lockfile('7.4.27', '4.2.49');
  const requestedReleases = [];
  const fetchedRefs = [];
  const locksRead = [];
  let lockfilesParsed = 0;

  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === 'git' && args[0] === 'diff') return 'yarn.lock\0';
    if (command === 'git' && args[0] === 'ls-tree') {
      if (args.at(-1) === 'yarn.lock') return 'blob\n';
      return args.at(-1) === '.yarnrc.yml' ? '.yarnrc.yml\n' : '';
    }
    if (command === 'git' && args[0] === 'show') {
      if (args[1].endsWith(':yarn.lock')) {
        locksRead.push(args[1]);
        return args[1] === 'base:yarn.lock' ? base : head;
      }
      assert.match(args[1], /^(?:base|head):(?:\.yarnrc\.yml|package\.json)$/);
      return '{}';
    }
    if (command === 'yq') {
      if (args[0] === '-r') return '.yarn/releases/yarn.cjs\n';
      if (Buffer.isBuffer(options.input)) lockfilesParsed++;
      return options.input.toString();
    }
    if (command === 'curl') {
      const [name, version] = new URL(args.at(-1)).pathname.slice(1).split('/').map(decodeURIComponent);
      requestedReleases.push([name, version]);
      const gitHead = name === mediaViewer ? (version === '4.2.48' ? oldCommit : newCommit) : undefined;
      const repository =
        name === mediaViewer
          ? {
              url:
                version === '4.2.48'
                  ? 'git@github.com:HMCTS/rpx-xui-media-viewer.git'
                  : 'git+https://github.com/hmcts/rpx-xui-media-viewer.git',
            }
          : 'github:hmcts/ccd-case-ui-toolkit';
      return JSON.stringify({ name, version, gitHead, repository });
    }
    assert.equal(command, 'git');
    if (args[0] === 'init') return;
    if (args[4] === 'fetch') {
      fetchedRefs.push(args.slice(-3));
      assert.equal(args[3], 'http.followRedirects=false');
      assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
      return;
    }
    assert.equal(args[2], 'diff');
    assert.deepEqual(args.slice(-3), [oldCommit, newCommit, '--']);
    const outputFile = join(outputDir, `${encodeURIComponent(mediaViewer)}.diff`);
    assert.ok(args.includes(`--output=${outputFile}`));
    writeFileSync(outputFile, 'diff --git a/viewer.ts b/viewer.ts\n');
  });
  const warnings = [];

  const { upstreamContext, installDirectory } = prepareReviewDependencies({
    base: 'base',
    head: 'head',
    tempDir: outputDir,
    workspace: outputDir,
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(locksRead, ['head:yarn.lock', 'base:yarn.lock']);
  assert.equal(lockfilesParsed, 2);
  assert.deepEqual(requestedReleases, [
    [toolkit, '7.4.27'],
    [toolkit, '7.4.26'],
    [mediaViewer, '4.2.49'],
    [mediaViewer, '4.2.48'],
  ]);
  assert.deepEqual(fetchedRefs, [['https://github.com/hmcts/rpx-xui-media-viewer.git', oldCommit, newCommit]]);
  assert.equal(
    readFileSync(join(outputDir, `${encodeURIComponent(mediaViewer)}.diff`), 'utf8'),
    'diff --git a/viewer.ts b/viewer.ts\n'
  );
  assert.ok(upstreamContext.includes(`context for ${toolkit} is unavailable`));
  assert.ok(upstreamContext.includes('media-viewer.diff'));
  assert.ok(warnings.some((message) => message.includes(`Could not retrieve the exact source diff for ${toolkit}`)));
  assert.deepEqual(readFileSync(join(installDirectory, 'yarn.lock')), head);
  assert.equal(readlinkSync(join(installDirectory, '..', 'yarn')), join(outputDir, '.yarn/releases/yarn.cjs'));
});

function exactLockfile(versions) {
  return {
    'caller@workspace:.': {
      resolution: 'caller@workspace:.',
      dependencies: Object.fromEntries(Object.entries(versions).map(([name, version]) => [name, `npm:${version}`])),
    },
    ...Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [
        `${name}@npm:${version}`,
        { resolution: `${name}@npm:${version}` },
      ])
    ),
  };
}

test('discovers HMCTS ownership independently of the npm scope and skips unsupported or unavailable sources', (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'codex-upstream-test-'));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const packages = ['@private/service', 'external', 'spoofed', 'missing', 'moved', 'unavailable', 'unscoped-hmcts'];
  const before = exactLockfile(Object.fromEntries(packages.map((name) => [name, '1.0.0'])));
  const after = exactLockfile(Object.fromEntries(packages.map((name) => [name, '2.0.0'])));
  const beforeConfig = { npmScopes: { private: { npmRegistryServer: 'https://private.example.test/' } } };
  const afterConfig = { npmRegistryServer: 'https://registry.yarnpkg.com/' };
  const requested = [];
  const fetched = [];
  const warnings = [];

  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    if (command === 'curl') {
      const [name, version] = new URL(args.at(-1)).pathname.slice(1).split('/').map(decodeURIComponent);
      requested.push([name, version]);
      const repository = {
        external: 'https://github.com/other/hmcts',
        spoofed: 'https://github.com@other.example.test/hmcts/repo',
        moved: version === '1.0.0' ? 'hmcts/old-repo' : 'hmcts/new-repo',
        unavailable: 'https://github.com/hmcts/unavailable',
        'unscoped-hmcts': 'git+ssh://git@github.com/hmcts/unscoped-source.git',
      }[name];
      return JSON.stringify({ name, version, repository, gitHead: version === '1.0.0' ? oldCommit : newCommit });
    }
    assert.equal(command, 'git');
    if (args[4] === 'fetch') {
      fetched.push(args.at(-3));
      if (args.at(-3).endsWith('/unavailable.git')) throw new Error('Source commit could not be fetched.');
    }
  });

  const context = prepareDependencyContext({
    before,
    after,
    beforeConfig,
    afterConfig,
    outputDir,
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual(requested, [
    ['external', '2.0.0'],
    ['spoofed', '2.0.0'],
    ['missing', '2.0.0'],
    ['moved', '2.0.0'],
    ['moved', '1.0.0'],
    ['unavailable', '2.0.0'],
    ['unavailable', '1.0.0'],
    ['unscoped-hmcts', '2.0.0'],
    ['unscoped-hmcts', '1.0.0'],
  ]);
  assert.deepEqual(fetched, [
    'https://github.com/hmcts/unavailable.git',
    'https://github.com/hmcts/unscoped-source.git',
  ]);
  assert.equal(warnings.length, 2);
  assert.match(context, /upstream context for moved is unavailable/);
  assert.match(context, /upstream context for unavailable is unavailable/);
  assert.match(context, /Read its exact upstream source diff at .*unscoped-hmcts\.diff/);
});

test('caps all upstream metadata requests at a shared deadline', (t) => {
  const before = exactLockfile({ first: '1.0.0', second: '1.0.0', third: '1.0.0' });
  const after = exactLockfile({ first: '2.0.0', second: '2.0.0', third: '2.0.0' });
  const warnings = [];
  const timeouts = [];
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === 'git') {
      assert.equal(options.timeout, 30_000);
      return;
    }
    assert.equal(command, 'curl');
    timeouts.push(options.timeout);
    now += 15_000;
    const [name, version] = new URL(args.at(-1)).pathname.slice(1).split('/');
    return JSON.stringify({ name, version, repository: 'hmcts/example', gitHead: newCommit });
  });

  const context = prepareDependencyContext({
    before,
    after,
    beforeConfig: {},
    afterConfig: {},
    outputDir: tmpdir(),
    warn: (message) => warnings.push(message),
  });

  assert.match(context, /Read its exact upstream source diff at .*first\.diff/);
  assert.match(context, /second is unavailable/);
  assert.deepEqual(timeouts, [20_000, 20_000, 20_000, 15_000]);
  assert.ok(warnings.some((message) => message.includes('60-second time limit')));
});

test('skips Yarn preparation when a manifest changes without a root Yarn lockfile', (t) => {
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, 'git');
    if (args[0] === 'diff') return 'package.json\0';
    assert.deepEqual(args, ['ls-tree', '--format=%(objecttype)', 'head', '--', 'yarn.lock']);
    return '';
  });

  const result = prepareReviewDependencies({
    base: 'base',
    head: 'head',
    warn: (message) => assert.fail(message),
  });

  assert.deepEqual(result, {});
});

test('skips upstream comparisons for a manifest-only dependency change', (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'codex-dependency-test-'));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  const lock = lockfile('7.4.26', '4.2.48');
  const locksRead = [];
  let lockfilesParsed = 0;
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === 'yq') {
      if (args[0] === '-r') return '.yarn/releases/yarn.cjs\n';
      if (Buffer.isBuffer(options.input)) lockfilesParsed++;
      return options.input.toString();
    }
    assert.equal(command, 'git');
    if (args[0] === 'diff') return 'package.json\0';
    if (args[0] === 'ls-tree') return args.at(-1) === 'yarn.lock' ? 'blob\n' : '';
    assert.equal(args[0], 'show');
    if (args[1].endsWith(':yarn.lock')) {
      locksRead.push(args[1]);
      return lock;
    }
    if (args[1] === 'head:package.json') return '{"dependencies":{"example":"^1.0.0"}}';
    return '{}';
  });

  const { upstreamContext, installDirectory } = prepareReviewDependencies({
    base: 'base',
    head: 'head',
    tempDir: outputDir,
    workspace: outputDir,
    warn: (message) => assert.fail(message),
  });
  assert.equal(upstreamContext, '');
  assert.deepEqual(locksRead, ['head:yarn.lock']);
  assert.equal(lockfilesParsed, 1);
  assert.deepEqual(readFileSync(join(installDirectory, 'yarn.lock')), lock);
});
