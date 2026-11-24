const childProcess = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');

const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HMCTS_REPOSITORY =
  /^(?:(?:git\+)?(?:https|git):\/\/github\.com\/|(?:git\+)?ssh:\/\/git@github\.com\/|git@github\.com:|github:)?hmcts\/([\w.-]+?)(?:\.git)?\/?$/i;
const PUBLIC_NPM_REGISTRY = /^https:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/?$/i;

function remainingTime(deadline, maximum) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) throw new Error('Upstream dependency review reached its 60-second time limit.');
  return Math.min(remaining, maximum);
}

function rootWorkspace(lockfile) {
  const workspace = Object.values(lockfile).find((entry) => entry?.resolution?.endsWith('@workspace:.'));
  if (!workspace) throw new Error('Root workspace is missing from yarn.lock');

  const resolutions = new Map();
  for (const [descriptors, entry] of Object.entries(lockfile)) {
    for (const descriptor of descriptors.split(', ')) resolutions.set(descriptor, entry?.resolution);
  }
  return { dependencies: workspace.dependencies ?? {}, resolutions };
}

function lockedVersion({ dependencies, resolutions }, packageName) {
  const descriptor = dependencies[packageName];
  if (!descriptor) return;

  const resolution = resolutions.get(`${packageName}@${descriptor}`);
  const prefix = `${packageName}@npm:`;
  const version = resolution?.startsWith(prefix) ? resolution.slice(prefix.length) : '';
  return NPM_VERSION.test(version) ? version : undefined;
}

function usesPublicRegistry(packageName, config) {
  const scope = /^@([^/]+)\//.exec(packageName)?.[1];
  const scopedRegistry = scope ? config.npmScopes?.[scope]?.npmRegistryServer : undefined;
  const registry = scopedRegistry ?? config.npmRegistryServer;
  return registry === undefined || (typeof registry === 'string' && PUBLIC_NPM_REGISTRY.test(registry));
}

function publishedRelease(packageName, version, deadline) {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const release = JSON.parse(
    childProcess.execFileSync('curl', ['--disable', '--fail', '--silent', '--show-error', registryUrl], {
      encoding: 'utf8',
      timeout: remainingTime(deadline, 20_000),
      killSignal: 'SIGKILL',
    })
  );
  if (release.name !== packageName || release.version !== version) {
    throw new Error(`npm metadata does not match ${packageName}@${version}`);
  }
  return release;
}

function hmctsRepository({ repository }) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  const repo = typeof url === 'string' ? HMCTS_REPOSITORY.exec(url)?.[1] : undefined;
  if (repo && repo !== '.' && repo !== '..') return `hmcts/${repo.toLowerCase()}`;
}

function sourceCommit({ name, version, gitHead }) {
  if (typeof gitHead !== 'string' || !/^[0-9a-f]{40}$/i.test(gitHead)) {
    throw new Error(`npm metadata has no source commit for ${name}@${version}`);
  }
  return gitHead.toLowerCase();
}

function writeUpstreamDiff(packageName, upstream, oldCommit, newCommit, outputDir, deadline) {
  const path = resolve(outputDir, `${encodeURIComponent(packageName)}.diff`);
  const repository = mkdtempSync(join(outputDir, 'codex-dependency-'));
  const git = (args, maximum = Infinity) =>
    childProcess.execFileSync('git', args, {
      timeout: remainingTime(deadline, maximum),
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '/bin/false',
      },
    });
  try {
    git(['init', '--bare', '--quiet', repository]);
    git(
      [
        '-C',
        repository,
        '-c',
        'http.followRedirects=false',
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        `https://github.com/${upstream}.git`,
        oldCommit,
        newCommit,
      ],
      45_000
    );

    git([
      '-C',
      repository,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      `--output=${path}`,
      oldCommit,
      newCommit,
      '--',
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
  return path;
}

module.exports = function prepareDependencyContext({ before, after, beforeConfig, afterConfig, outputDir, warn }) {
  const previousLockfile = rootWorkspace(before);
  const currentLockfile = rootWorkspace(after);
  const sections = [];
  const deadline = performance.now() + 60_000;

  for (const packageName of Object.keys(currentLockfile.dependencies)) {
    const oldVersion = lockedVersion(previousLockfile, packageName);
    const newVersion = lockedVersion(currentLockfile, packageName);
    if (!oldVersion || !newVersion || oldVersion === newVersion) continue;
    if (!usesPublicRegistry(packageName, beforeConfig) || !usesPublicRegistry(packageName, afterConfig)) continue;
    if (deadline - performance.now() < 1) {
      warn('Upstream dependency review reached its 60-second time limit.');
      break;
    }

    try {
      const newRelease = publishedRelease(packageName, newVersion, deadline);
      const upstream = hmctsRepository(newRelease);
      if (!upstream) continue;

      const oldRelease = publishedRelease(packageName, oldVersion, deadline);
      if (hmctsRepository(oldRelease) !== upstream)
        throw new Error('The npm releases identify different source repositories.');
      const oldCommit = sourceCommit(oldRelease);
      const newCommit = sourceCommit(newRelease);
      const path = writeUpstreamDiff(packageName, upstream, oldCommit, newCommit, outputDir, deadline);

      sections.push(
        `${packageName} changed from ${oldVersion} (${oldCommit}) to ${newVersion} (${newCommit}).\nRead its exact upstream source diff at ${path}.`
      );
    } catch (error) {
      warn(`Could not retrieve the exact source diff for ${packageName}. ${error.message}`);
      sections.push(`Exact upstream context for ${packageName} is unavailable for this review.`);
    }
  }
  return sections.join('\n\n');
};
