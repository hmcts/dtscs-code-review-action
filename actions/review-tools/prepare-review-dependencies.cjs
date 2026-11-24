const childProcess = require('node:child_process');
const { mkdtempSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const prepareDependencyContext = require('./dependency-context.cjs');
const prepareDependencyInputs = require('./review-dependency-inputs.cjs');

const lockfileBuffer = 16 * 1024 * 1024;
const upstreamUnavailable = 'Exact upstream dependency context is unavailable for this review.';

function parseYaml(contents) {
  // GitHub-hosted Ubuntu includes yq, so lockfile parsing needs no npm packages.
  return JSON.parse(
    childProcess.execFileSync('yq', ['-o=json', '-I=0', '.', '-'], {
      input: contents,
      encoding: 'utf8',
      maxBuffer: lockfileBuffer,
    })
  );
}

function readYarnLockfile(revision) {
  const contents = childProcess.execFileSync('git', ['show', `${revision}:yarn.lock`], { maxBuffer: lockfileBuffer });
  const entries = parseYaml(contents);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    throw new Error('yarn.lock must contain a mapping.');
  return { contents, entries };
}

function readYarnConfig(revision) {
  const path = '.yarnrc.yml';
  if (
    !childProcess.execFileSync('git', ['ls-tree', '--name-only', revision, '--', path], { encoding: 'utf8' }).trim()
  ) {
    return {};
  }
  const config = parseYaml(childProcess.execFileSync('git', ['show', `${revision}:${path}`]));
  if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('.yarnrc.yml must contain a mapping.');
  }
  return config ?? {};
}

module.exports = function prepareReviewDependencies({ base, head, tempDir, workspace, warn }) {
  let lockfileChanged = true;
  let patchesChanged;
  let baseLockfile;
  let headLockfile;
  try {
    const paths = childProcess
      .execFileSync(
        'git',
        [
          'diff',
          '--name-only',
          '--no-renames',
          '-z',
          base,
          head,
          '--',
          'yarn.lock',
          '.yarnrc.yml',
          '.yarn/patches',
          ':(glob)**/package.json',
        ],
        { encoding: 'utf8' }
      )
      .split('\0')
      .filter(Boolean);
    if (paths.length === 0) return {};
    const headLockfileType = childProcess.execFileSync(
      'git',
      ['ls-tree', '--format=%(objecttype)', head, '--', 'yarn.lock'],
      { encoding: 'utf8' }
    );
    if (headLockfileType.trim() !== 'blob') return {};
    lockfileChanged = paths.includes('yarn.lock');
    patchesChanged = paths.some((path) => path === '.yarn/patches' || path.startsWith('.yarn/patches/'));
    headLockfile = readYarnLockfile(head);
    baseLockfile = lockfileChanged ? readYarnLockfile(base) : headLockfile;
  } catch (error) {
    warn(`Could not read dependency inputs. Continuing with the review. ${error.message}`);
    return { upstreamContext: lockfileChanged ? upstreamUnavailable : '' };
  }

  const before = baseLockfile.entries;
  const after = headLockfile.entries;
  let upstreamContext = '';
  if (lockfileChanged) {
    try {
      upstreamContext = prepareDependencyContext({
        before,
        after,
        beforeConfig: readYarnConfig(base),
        afterConfig: readYarnConfig(head),
        outputDir: tempDir,
        warn,
      });
    } catch (error) {
      warn(`Could not prepare dependency source diffs from yarn.lock. ${error.message}`);
      upstreamContext = upstreamUnavailable;
    }
  }

  let installDirectory;
  try {
    const installRoot = mkdtempSync(join(tempDir, 'codex-review-install.'));
    const directory = join(installRoot, 'project');
    if (
      prepareDependencyInputs({
        base,
        head,
        directory,
        before,
        after,
        lockfileContents: headLockfile.contents,
        patchesChanged,
      })
    ) {
      const release = childProcess
        .execFileSync('yq', ['-r', '.yarnPath', '.yarnrc.yml'], { cwd: workspace, encoding: 'utf8' })
        .trimEnd();
      symlinkSync(join(workspace, release), join(installRoot, 'yarn'));
      installDirectory = directory;
    }
  } catch (error) {
    warn(`Could not prepare dependency inputs. Continuing with the review. ${error.message}`);
  }
  return { upstreamContext, installDirectory };
};
