const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  reviewRequestArtifactName,
  cancelSupersededManualReviews,
  findSupersededAutomaticReviews,
  cancelSupersededAutomaticReviews,
} = require('./review-request.cjs');

const olderHead = 'a'.repeat(40);
const head = 'b'.repeat(40);
const mergeBase = 'c'.repeat(40);
const focusHash = 'd'.repeat(64);
const requestedAt = '2026-11-21T15:04:00Z';
const olderTime = '2026-11-21T15:01:00Z';
const repo = { owner: 'owner', repo: 'repo' };
const context = {
  repo,
  issue: { number: 12 },
  runId: 1,
  eventName: 'issue_comment',
  payload: { comment: { created_at: requestedAt }, repository: { id: 7, default_branch: 'master' } },
};
const env = { HEAD_SHA: head, MERGE_BASE_SHA: mergeBase, BASE_TIP_SHA: 'default', REVIEW_FOCUS_HASH: focusHash };
const automaticContext = {
  ...context,
  eventName: 'pull_request_target',
  payload: { repository: context.payload.repository, pull_request: { id: 25, head: { sha: head } } },
};
const automaticBranch = 'codex/feature';

function candidate(id, { scope = focusHash, candidateHead = olderHead, time = olderTime, number = 12, attempt = '1' } = {}) {
  const name = reviewRequestArtifactName(
    { eventName: 'issue_comment', issue: { number }, payload: { comment: { created_at: time } } },
    { ...env, HEAD_SHA: candidateHead, REVIEW_FOCUS_HASH: scope, GITHUB_RUN_ATTEMPT: attempt }
  );
  return {
    run: {
      id,
      head_branch: 'master',
      head_repository: { id: 7 },
      event: 'issue_comment',
      path: '.github/workflows/codex-review.yml@master',
      status: 'in_progress',
      run_attempt: 1,
    },
    artifact: { name, expired: false },
  };
}

function automaticCandidate(id, { targetHead = olderHead, number = 12, expired = false, artifacts = [], ...overrides } = {}) {
  const name = reviewRequestArtifactName(
    { ...automaticContext, issue: { number } },
    { ...env, HEAD_SHA: targetHead, GITHUB_RUN_ATTEMPT: overrides.run_attempt ?? 1 }
  );
  return {
    run: {
      id,
      head_branch: automaticBranch,
      head_repository: { id: 7 },
      head_sha: olderHead,
      event: 'pull_request_target',
      path: '.github/workflows/codex-review.yml',
      pull_requests: [],
      status: 'in_progress',
      run_attempt: 1,
      ...overrides,
    },
    artifact: { name, expired },
    artifacts,
  };
}

async function runCancellation({
  candidates,
  expectedHeads = [head],
  cancellationError,
  focus = focusHash,
  reviewContext = context,
  onPullLookup,
}) {
  const cancelled = [];
  const searched = [];
  const heads = [...expectedHeads];
  const automatic = reviewContext.eventName === 'pull_request_target';
  const actions = {
    listWorkflowRuns: async (params) => {
      assert.deepEqual(params, {
        ...repo,
        workflow_id: 'codex-review.yml',
        event: reviewContext.eventName,
        branch: automatic ? automaticBranch : 'master',
        status: params.status,
        per_page: 100,
      });
      return candidates.map(({ run }) => run).filter((run) => run.status === params.status);
    },
    listWorkflowRunArtifacts: async ({ run_id }) => {
      searched.push(run_id);
      const { artifact, artifacts = [] } = candidates.find(({ run }) => run.id === run_id);
      return [artifact, ...artifacts];
    },
    getWorkflowRun: async ({ run_id }) => {
      const { run, latest } = candidates.find(({ run }) => run.id === run_id);
      return { data: latest ?? run };
    },
    cancelWorkflowRun: async ({ run_id }) => {
      cancelled.push(run_id);
      if (cancellationError) throw cancellationError;
    },
  };
  const github = {
    paginate: (endpoint, params) => endpoint(params),
    rest: {
      actions,
      pulls: {
        get: async () => {
          onPullLookup?.();
          return {
            data: {
              state: 'open',
              head: { sha: heads.shift() ?? head, ref: automaticBranch },
              base: { sha: 'default', ref: 'master' },
            },
          };
        },
      },
    },
  };
  const args = { github, context: reviewContext, core: { info() {} }, env: { ...env, REVIEW_FOCUS_HASH: focus } };
  if (automatic) {
    const runs = await findSupersededAutomaticReviews(args);
    await cancelSupersededAutomaticReviews({ ...args, runs });
    return { cancelled, searched, replacement: runs.length > 0 };
  }
  await cancelSupersededManualReviews(args);
  return { cancelled, searched };
}

test('cancels only manual requests for superseded revisions of the same PR and focus', async () => {
  const legacyAttempt = candidate(8, { attempt: '2' });
  const anotherWorkflow = candidate(9);
  anotherWorkflow.run.path = '.github/workflows/other.yml@master';
  const automatic = candidate(10);
  automatic.run.event = 'pull_request_target';
  const result = await runCancellation({
    candidates: [
      candidate(2),
      candidate(3, { candidateHead: head }),
      candidate(4, { scope: '' }),
      candidate(5, { number: 13 }),
      candidate(6, { time: requestedAt }),
      candidate(context.runId),
      legacyAttempt,
      anotherWorkflow,
      automatic,
    ],
  });
  assert.deepEqual(result, { cancelled: [2, 6], searched: [2, 3, 4, 5, 6, 8] });
});

test('cancels a stale manual run even when its comment was posted later', async () => {
  const laterCommentOnStaleHead = candidate(2, { time: '2026-11-21T15:05:00Z' });
  const result = await runCancellation({ candidates: [laterCommentOnStaleHead] });
  assert.deepEqual(result.cancelled, [2]);
});

test('plain review requests only supersede other plain reviews', async () => {
  const result = await runCancellation({ candidates: [candidate(2), candidate(3, { scope: '' })], focus: '' });
  assert.deepEqual(result.cancelled, [3]);
});

test('keeps an explicit manual rerun even if its marker names the current attempt', async () => {
  const rerun = candidate(3, { attempt: '2' });
  rerun.run.run_attempt = 2;
  assert.deepEqual(await runCancellation({ candidates: [candidate(2), rerun] }), { cancelled: [2], searched: [2] });
});

test('a request superseded during lookup skips cancellation', async () => {
  const result = await runCancellation({ candidates: [candidate(2)], expectedHeads: [head, 'e'.repeat(40)] });
  assert.deepEqual(result, { cancelled: [], searched: [2] });
});

test('ignores candidates that completed or changed attempts since their marker was checked', async () => {
  const complete = candidate(2);
  complete.latest = { ...complete.run, status: 'completed' };
  const rerun = candidate(3);
  rerun.latest = { ...rerun.run, run_attempt: 2 };
  const result = await runCancellation({ candidates: [complete, rerun] });
  assert.deepEqual(result.cancelled, []);
});

test('preserves an explicit rerun created during PR revision validation', async () => {
  for (const [reviewContext, staleRun] of [
    [context, candidate(2)],
    [automaticContext, automaticCandidate(2)],
  ]) {
    let lookups = 0;
    const result = await runCancellation({
      candidates: [staleRun],
      reviewContext,
      onPullLookup() {
        lookups += 1;
        if (lookups === 2) staleRun.latest = { ...staleRun.run, run_attempt: 2 };
      },
    });
    assert.deepEqual(result.cancelled, [], reviewContext.eventName);
    assert.deepEqual(result.searched, [2]);
    assert.equal(lookups, reviewContext === automaticContext ? 3 : 2);
  }
});

test('continues when a superseded run finishes before GitHub accepts cancellation', async () => {
  const conflict = Object.assign(new Error('Workflow completed'), { status: 409 });
  const result = await runCancellation({ candidates: [candidate(2), candidate(3)], cancellationError: conflict });
  assert.deepEqual(result.cancelled, [2, 3]);
});

test('cancels only first-attempt automatic reviews with a superseded target for the same PR', async () => {
  const candidates = [
    automaticCandidate(2),
    automaticCandidate(3, { targetHead: head }),
    automaticCandidate(4, { number: 13, pull_requests: [{ id: 26 }] }),
    automaticCandidate(6, { run_attempt: 2 }),
    automaticCandidate(7, { head_repository: { id: 8 } }),
    automaticCandidate(8, { event: 'issue_comment' }),
    automaticCandidate(10, { expired: true }),
    automaticCandidate(context.runId),
  ];
  assert.deepEqual(await runCancellation({ candidates, reviewContext: automaticContext }), {
    cancelled: [2],
    searched: [2, 3, 4, 10],
    replacement: true,
  });
});

test('a push leaves completed or already published automatic reviews alone', async () => {
  const candidates = [
    automaticCandidate(2, { status: 'completed' }),
    automaticCandidate(3, {
      artifacts: [
        { id: 9, name: `codex-review-findings-12-${mergeBase}-${olderHead}` },
        { name: `codex-review-publication-9-1-covered-${Date.parse(olderTime)}` },
      ],
    }),
  ];
  assert.deepEqual(await runCancellation({ candidates, reviewContext: automaticContext }), {
    cancelled: [],
    searched: [3],
    replacement: false,
  });
});

test('a push can supersede a replacement registered before its review starts', async () => {
  const result = await runCancellation({
    candidates: [automaticCandidate(2, { status: 'queued' })],
    reviewContext: automaticContext,
  });
  assert.deepEqual(result, { cancelled: [2], searched: [2], replacement: true });
});

test('a delayed push cannot cancel reviews after the live PR has moved on', async () => {
  const candidates = [automaticCandidate(2)];
  const initial = await runCancellation({ candidates, expectedHeads: ['e'.repeat(40)], reviewContext: automaticContext });
  assert.deepEqual(initial, { cancelled: [], searched: [], replacement: false });
  const duringLookup = await runCancellation({
    candidates,
    expectedHeads: [head, 'e'.repeat(40)],
    reviewContext: automaticContext,
  });
  assert.deepEqual(duringLookup, { cancelled: [], searched: [2], replacement: false });
});
