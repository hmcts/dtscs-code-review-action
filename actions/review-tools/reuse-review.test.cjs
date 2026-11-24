const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findingsArtifactName, publicationReceiptName, readPublicationOutcome } = require('./review-artifacts.cjs');
const resolveExistingReview = require('./reuse-review.cjs');

const artifactName = 'codex-review-findings-12-base-head';
const origin = { id: 1, head_branch: 'master', head_repository_id: 2 };
const artifact = { id: 3, created_at: '2026-11-21T14:02:00Z', expired: false, workflow_run: origin };
const finishedRun = {
  event: 'issue_comment',
  path: '.github/workflows/codex-review.yml@master',
  created_at: '2026-11-21T14:00:00Z',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/owner/repo/actions/runs/1',
};
const publishingRun = { ...finishedRun, status: 'in_progress', conclusion: null };
const failedRun = { ...finishedRun, conclusion: 'failure' };
const confirmationTime = Date.parse('2026-11-21T14:02:45Z');
const coveredReceipt = { name: `codex-review-publication-3-2-covered-${confirmationTime}`, expired: false };
const covered = { mode: 'covered', url: finishedRun.html_url };
const retry = { mode: 'retry', runId: origin.id, artifactId: artifact.id, url: finishedRun.html_url };

test('keeps findings and publication receipt names compatible across reruns', () => {
  assert.equal(findingsArtifactName('12-base-head'), artifactName);
  const receiptName = publicationReceiptName(artifact.id, 2, { status: 'covered', confirmedAt: confirmationTime });
  assert.equal(receiptName, coveredReceipt.name);
  assert.deepEqual(readPublicationOutcome([{ name: receiptName }], artifact.id), {
    status: 'covered',
    confirmedAt: confirmationTime,
  });
  assert.equal(publicationReceiptName(artifact.id, 2, { status: 'invalid' }), 'codex-review-publication-3-2-invalid-0');
});

async function lookup(
  requestedAt,
  { artifacts = [artifact], run = finishedRun, receipts = [coveredReceipt], eventName = 'issue_comment', otherRuns = {} } = {}
) {
  const repo = { owner: 'owner', repo: 'repo' };
  const context = {
    repo,
    runId: 10,
    eventName,
    payload: {
      ...(eventName === 'issue_comment' ? { comment: { created_at: requestedAt } } : {}),
      repository: { id: 2, default_branch: 'master' },
    },
  };
  const actions = {
    listArtifactsForRepo: async (params) => {
      assert.deepEqual(params, { ...repo, name: artifactName, per_page: 100 });
      return artifacts;
    },
    getWorkflowRun: async (params) => {
      const { run_id } = params;
      assert.deepEqual(params, { ...repo, run_id });
      const data = run_id === 1 ? run : otherRuns[run_id];
      assert.ok(data, 'unexpected workflow run');
      return { data };
    },
    listWorkflowRunArtifacts: async (params) => {
      const { run_id } = params;
      assert.deepEqual(params, { ...repo, run_id, per_page: 100 });
      return typeof receipts === 'function' ? receipts(run_id) : receipts;
    },
  };
  const github = { rest: { actions }, paginate: (endpoint, params) => endpoint(params) };
  return resolveExistingReview({ github, context, artifactName });
}

test('reuses a review that finished while the duplicate request was queued', async () => {
  assert.deepEqual(await lookup('2026-11-21T14:01:00Z'), covered);
});

test('an automatic request is covered by a confirmed manual review', async () => {
  assert.deepEqual(await lookup(undefined, { eventName: 'pull_request_target' }), covered);
});

test('allows reviews from a pull_request_target run recorded against the PR branch', async () => {
  const run = { ...finishedRun, event: 'pull_request_target' };
  const artifacts = [{ ...artifact, workflow_run: { ...origin, head_branch: 'pr-branch' } }];
  assert.deepEqual(await lookup(undefined, { run, artifacts, eventName: 'pull_request_target' }), covered);
  assert.deepEqual(await lookup('2026-11-21T14:02:30Z', { run, artifacts }), covered);
  assert.equal(await lookup('2026-11-21T14:03:00Z', { run, artifacts }), null);
});

test('an automatic request uses an earlier confirmation when a newer publication is unfinished or failed', async () => {
  const earlierArtifact = { ...artifact, id: 4, workflow_run: { ...origin, id: 2 } };
  const earlierRun = { ...finishedRun, html_url: 'https://github.com/owner/repo/actions/runs/2' };
  const earlierReceipt = { ...coveredReceipt, name: `codex-review-publication-4-2-covered-${confirmationTime}` };
  const options = {
    eventName: 'pull_request_target',
    artifacts: [artifact, earlierArtifact],
    otherRuns: { 2: earlierRun },
    receipts: (runId) => (runId === 2 ? [earlierReceipt] : []),
  };
  for (const run of [publishingRun, failedRun]) {
    assert.deepEqual(await lookup(undefined, { ...options, run }), { mode: 'covered', url: earlierRun.html_url });
  }
});

test('chooses the newest artifact even when the API returns an older one first', async () => {
  const olderArtifact = { ...artifact, id: 4, created_at: '2026-11-21T14:01:00Z', workflow_run: { ...origin, id: 2 } };
  const olderRun = { ...finishedRun, html_url: 'https://github.com/owner/repo/actions/runs/2' };
  const olderReceipt = { name: `codex-review-publication-4-2-covered-${confirmationTime}` };
  assert.deepEqual(
    await lookup('2026-11-21T14:02:30Z', {
      artifacts: [olderArtifact, artifact],
      otherRuns: { 2: olderRun },
      receipts: (runId) => (runId === 2 ? [olderReceipt] : []),
    }),
    retry
  );
});

test('starts a fresh manual review when requested after publication', async () => {
  assert.equal(await lookup('2026-11-21T14:02:50Z'), null);
});

test('starts a new review for a different diff with no matching artifact', async () => {
  assert.equal(await lookup('2026-11-21T14:01:00Z', { artifacts: [] }), null);
});

test('ignores artifacts from forks, the current run, and expired artifacts', async () => {
  const artifacts = [
    { ...artifact, workflow_run: { ...origin, id: 2, head_repository_id: 3 } },
    { ...artifact, workflow_run: { ...origin, id: 10 } },
    { ...artifact, expired: true },
  ];
  assert.equal(await lookup('2026-11-21T14:01:00Z', { artifacts }), null);
});

test('ignores artifacts from an issue_comment run on another branch or an unsupported event', async () => {
  const artifacts = [{ ...artifact, workflow_run: { ...origin, head_branch: 'other-branch' } }];
  assert.equal(await lookup('2026-11-21T14:01:00Z', { artifacts }), null);
  assert.equal(await lookup('2026-11-21T14:01:00Z', { run: { ...finishedRun, event: 'pull_request' } }), null);
});

test('retries from the artifact even when the request follows a failed publication', async () => {
  assert.deepEqual(await lookup('2026-11-21T14:04:00Z', { run: failedRun, receipts: [] }), retry);
});

test('retries when the publisher skipped a diff that is now current again', async () => {
  const receipts = [{ name: 'codex-review-publication-3-2-stale-0' }];
  assert.deepEqual(await lookup('2026-11-21T14:02:30Z', { receipts }), retry);
});

test('regenerates findings when publication identified an invalid artifact', async () => {
  const receipts = [{ name: 'codex-review-publication-3-2-invalid-0' }];
  assert.equal(await lookup('2026-11-21T14:02:30Z', { receipts }), null);
});

test('requires a publication receipt even when the original run succeeded', async () => {
  assert.deepEqual(await lookup('2026-11-21T14:02:30Z', { receipts: [] }), retry);
});

test('reuses confirmed publication even if another part of the workflow failed', async () => {
  assert.deepEqual(await lookup('2026-11-21T14:02:30Z', { run: failedRun }), covered);
});

test('retries the artifact without waiting when a later rerun is queued behind this request', async () => {
  const rerun = { ...publishingRun, run_attempt: 3, run_started_at: '2026-11-21T14:04:00Z', status: 'queued' };
  const receipts = [{ name: `codex-review-publication-31-3-covered-${confirmationTime}` }, { ...coveredReceipt, expired: true }];
  assert.deepEqual(await lookup('2026-11-21T14:02:30Z', { run: rerun, receipts }), retry);
});

test('uses confirmed and invalid receipts for the same artifact from publisher-only reruns', async () => {
  const laterConfirmation = Date.parse('2026-11-21T14:04:45Z');
  const postedOnRetry = { name: `codex-review-publication-3-3-covered-${laterConfirmation}` };
  const rejectedOnRetry = { name: 'codex-review-publication-3-3-invalid-0' };
  assert.deepEqual(await lookup('2026-11-21T14:04:30Z', { receipts: [postedOnRetry] }), covered);
  assert.equal(await lookup('2026-11-21T14:04:30Z', { receipts: [rejectedOnRetry] }), null);
});

test('keeps the original confirmation time after another confirmation on rerun', async () => {
  const laterConfirmation = Date.parse('2026-11-21T14:04:45Z');
  const receipts = [{ name: `codex-review-publication-3-3-covered-${laterConfirmation}` }, coveredReceipt];
  assert.equal(await lookup('2026-11-21T14:03:00Z', { receipts }), null);
});

test('ignores output from another workflow or predating the run', async () => {
  for (const run of [
    { ...finishedRun, path: '.github/workflows/other.yml@master' },
    { ...finishedRun, created_at: '2026-11-21T14:02:01Z' },
  ]) {
    assert.equal(await lookup('2026-11-21T14:01:00Z', { run }), null);
  }
});
