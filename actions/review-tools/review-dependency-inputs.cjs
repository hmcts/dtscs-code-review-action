const childProcess = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'dependenciesMeta',
  'installConfig',
  'resolutions',
  'workspaces',
];

const yarnLayoutFields = [
  'compressionLevel',
  'enableTransparentWorkspaces',
  'nmHoistingLimits',
  'nmMode',
  'nmSelfReferences',
  'nodeLinker',
  'npmMinimalAgeGate',
  'packageExtensions',
  'supportedArchitectures',
];

function readAt(revision, path) {
  return childProcess.execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' });
}

function yarnLayout(revision) {
  const config = JSON.parse(
    childProcess.execFileSync('yq', ['-o=json', '-I=0', '.', '-'], { input: readAt(revision, '.yarnrc.yml'), encoding: 'utf8' })
  );
  return Object.fromEntries(yarnLayoutFields.filter((key) => Object.hasOwn(config, key)).map((key) => [key, config[key]]));
}

function dependencyDeclarations(revision, path) {
  const manifest = JSON.parse(readAt(revision, path));
  return dependencyFields.map((field) => manifest[field]);
}

module.exports = function prepareDependencyInputs({ base, head, directory, before, after, lockfileContents, patchesChanged }) {
  const baseEntries = { ...before };
  const headEntries = { ...after };
  delete baseEntries.__metadata;
  delete headEntries.__metadata;

  const manifests = new Set(['package.json']);
  for (const { resolution } of Object.values(headEntries)) {
    const workspace = /@workspace:(.+)$/.exec(resolution)?.[1];
    if (!workspace || workspace === '.') continue;
    if (workspace.startsWith('/') || workspace.split('/').includes('..')) throw new Error('Invalid Yarn workspace path.');
    manifests.add(`${workspace}/package.json`);
  }

  const layout = yarnLayout(head);
  const changed =
    !isDeepStrictEqual(baseEntries, headEntries) ||
    !isDeepStrictEqual(yarnLayout(base), layout) ||
    patchesChanged ||
    [...manifests].some((path) => !isDeepStrictEqual(dependencyDeclarations(base, path), dependencyDeclarations(head, path)));
  if (!changed) return false;

  const patches = childProcess.execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', head, '--', '.yarn/patches'], {
    encoding: 'utf8',
  });
  for (const path of [...manifests, ...patches.split('\0').filter(Boolean)]) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readAt(head, path));
  }
  writeFileSync(join(directory, 'yarn.lock'), lockfileContents);
  // Only layout settings come from the PR. Yarn code, plugins and executable config stay out of the install.
  const config = {
    ...layout,
    approvedGitRepositories: [],
    enableConstraintsChecks: false,
    enableGlobalCache: false,
    enableScripts: false,
    globalFolder: './.yarn/global',
    injectEnvironmentFiles: [],
  };
  writeFileSync(join(directory, '.yarnrc.yml'), JSON.stringify(config));
  return true;
};
