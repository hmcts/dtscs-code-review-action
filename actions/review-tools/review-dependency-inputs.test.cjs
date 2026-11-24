const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const prepareDependencyInputs = require('./review-dependency-inputs.cjs');

const locked = {
  __metadata: { version: 10 },
  'exui@workspace:.': { resolution: 'exui@workspace:.' },
  'api@workspace:api': { resolution: 'api@workspace:api' },
  'example@npm:^1.0.0': { resolution: 'example@npm:1.0.0' },
};

function fixture(t, { lockfile = locked, manifests = {}, patches = '', config = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-dependency-inputs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === 'yq') return options.input.toString();
    assert.equal(command, 'git');
    if (args[0] === 'ls-tree') return patches ? '.yarn/patches/example.patch\0' : '';
    assert.equal(args[0], 'show');
    if (args[1] === 'base:.yarnrc.yml') return JSON.stringify({ nodeLinker: 'node-modules' });
    if (args[1] === 'head:.yarnrc.yml') return JSON.stringify({ nodeLinker: 'node-modules', ...config });
    if (args[1] === 'head:.yarn/patches/example.patch') return 'patch content';
    assert.match(args[1], /^(base|head):(api\/)?package\.json$/u);
    return JSON.stringify(manifests[args[1]] ?? {});
  });
  const prepare = () =>
    prepareDependencyInputs({
      base: 'base',
      head: 'head',
      directory,
      before: locked,
      after: lockfile,
      lockfileContents: JSON.stringify(lockfile),
      patchesChanged: Boolean(patches),
    });
  return { directory, prepare };
}

test('skips installation for script, formatting, and lockfile metadata changes', (t) => {
  const { directory, prepare } = fixture(t, {
    lockfile: { ...Object.fromEntries(Object.entries(locked).reverse()), __metadata: { version: 11 } },
    manifests: { 'head:package.json': { scripts: { build: 'a new build command' } } },
  });
  assert.equal(prepare(), false);
  assert.deepEqual(readdirSync(directory), []);
});

test('detects changed lockfile resolutions', (t) => {
  const lockfile = { ...locked, 'example@npm:^1.0.0': { resolution: 'example@npm:1.0.1' } };
  const { directory, prepare } = fixture(t, { lockfile });
  assert.equal(prepare(), true);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'yarn.lock'), 'utf8')), lockfile);
});

test('detects a workspace dependency change even before the lockfile is updated', (t) => {
  const { prepare } = fixture(t, { manifests: { 'head:api/package.json': { dependencies: { example: '^1.0.0' } } } });
  assert.equal(prepare(), true);
});

test('detects a change to a Yarn patch', (t) => {
  const { directory, prepare } = fixture(t, { patches: '.yarn/patches/example.patch\n' });
  assert.equal(prepare(), true);
  assert.equal(readFileSync(join(directory, '.yarn/patches/example.patch'), 'utf8'), 'patch content');
});

test('preserves layout changes while excluding executable Yarn settings', (t) => {
  const { directory, prepare } = fixture(t, {
    config: { nmHoistingLimits: 'workspaces', enableConstraintsChecks: true, plugins: ['./untrusted.cjs'] },
  });
  assert.equal(prepare(), true);
  const config = JSON.parse(readFileSync(join(directory, '.yarnrc.yml'), 'utf8'));
  assert.equal(config.nmHoistingLimits, 'workspaces');
  assert.equal(config.enableConstraintsChecks, false);
  assert.equal(config.enableScripts, false);
  assert.equal(config.plugins, undefined);
});
