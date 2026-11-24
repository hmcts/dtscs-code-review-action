const getReviewedPullRequest = require('./review-revision.cjs');
const { isAvailableFindingsArtifact, readPublicationOutcome } = require('./review-artifacts.cjs');

const activeStatuses = new Set(['queued', 'in_progress', 'waiting', 'pending']);

function manualRequestPrefix(context, env) {
  return `codex-manual-review-${context.issue.number}-${env.REVIEW_FOCUS_HASH || 'general'}-`;
}

function automaticRequestPrefix(context) {
  return `codex-automatic-review-${context.issue.number}-`;
}

function reviewRequestArtifactName(context, env) {
  const prefix = context.eventName === 'issue_comment' ? manualRequestPrefix(context, env) : automaticRequestPrefix(context);
  return prefix + [env.MERGE_BASE_SHA, env.HEAD_SHA, env.GITHUB_RUN_ATTEMPT].join('-');
}

function isSupersededRevision(artifact, prefix, run, env) {
  if (artifact.expired || !artifact.name.startsWith(prefix)) return false;
  const match = /^([a-f0-9]{40})-([a-f0-9]{40})-(\d+)$/.exec(artifact.name.slice(prefix.length));
  if (!match) return false;
  const [, mergeBase, head, attempt] = match;
  return Number(attempt) === run.run_attempt && (mergeBase !== env.MERGE_BASE_SHA || head !== env.HEAD_SHA);
}

async function findActiveReviewRuns(github, context, branch) {
  const { actions } = github.rest;
  const listParams = {
    ...context.repo,
    workflow_id: 'codex-review.yml',
    event: context.eventName,
    branch,
    per_page: 100,
  };
  const groups = await Promise.all(
    [...activeStatuses].map((status) => github.paginate(actions.listWorkflowRuns, { ...listParams, status }))
  );
  const runs = new Map(groups.flat().map((run) => [run.id, run]));
  return [...runs.values()].filter(
    (run) =>
      run.id !== context.runId &&
      run.head_repository?.id === context.payload.repository.id &&
      run.head_branch === branch &&
      run.event === context.eventName &&
      run.path?.split('@')[0] === '.github/workflows/codex-review.yml'
  );
}

async function* supersededReviewCandidates({ github, context, env, branch, prefix }) {
  const { actions } = github.rest;
  const runs = await findActiveReviewRuns(github, context, branch);
  for (const run of runs) {
    if (run.run_attempt !== 1) continue;
    // GitHub can omit pull_requests on automatic runs. Use the marker to identify the PR and resolved head.
    const runParams = { ...context.repo, run_id: run.id };
    const artifacts = await github.paginate(actions.listWorkflowRunArtifacts, { ...runParams, per_page: 100 });
    if (artifacts.some((artifact) => isSupersededRevision(artifact, prefix, run, env))) {
      yield { run, runParams, artifacts };
    }
  }
}

async function cancelActiveRun({ github, context, core, env, run, trigger }) {
  if (!(await getReviewedPullRequest({ github, context, env }))) return false;

  const { actions } = github.rest;
  const runParams = { ...context.repo, run_id: run.id };
  const { data: current } = await actions.getWorkflowRun(runParams);
  if (current.run_attempt !== run.run_attempt || !activeStatuses.has(current.status)) return true;

  try {
    await actions.cancelWorkflowRun(runParams);
    core.info(`Requested cancellation of superseded ${trigger} review run ${run.id}.`);
  } catch (error) {
    if (error.status !== 404 && error.status !== 409) throw error;
  }
  return true;
}

async function cancelSupersededManualReviews({ github, context, core, env }) {
  if (!(await getReviewedPullRequest({ github, context, env }))) return;

  const branch = context.payload.repository.default_branch;
  const candidates = supersededReviewCandidates({ github, context, env, branch, prefix: manualRequestPrefix(context, env) });
  for await (const { run } of candidates) {
    if (!(await cancelActiveRun({ github, context, core, env, run, trigger: 'manual' }))) return;
  }
}

async function findSupersededAutomaticReviews({ github, context, env }) {
  const { pull_request: requested } = context.payload;
  const pr = await getReviewedPullRequest({ github, context, env });
  if (!pr || requested.head.sha !== env.HEAD_SHA) return [];

  const { actions } = github.rest;
  const candidates = supersededReviewCandidates({
    github,
    context,
    env,
    branch: pr.head.ref,
    prefix: automaticRequestPrefix(context),
  });
  const superseded = [];
  for await (const { run, runParams, artifacts } of candidates) {
    const findings = artifacts.find(isAvailableFindingsArtifact);
    if (findings && readPublicationOutcome(artifacts, findings.id).status === 'covered') continue;
    const { data: current } = await actions.getWorkflowRun(runParams);
    if (current.run_attempt !== run.run_attempt || !activeStatuses.has(current.status)) continue;
    superseded.push({ id: run.id, run_attempt: run.run_attempt });
  }
  return superseded.length && (await getReviewedPullRequest({ github, context, env })) ? superseded : [];
}

async function cancelSupersededAutomaticReviews({ github, context, core, env, runs }) {
  for (const run of runs) {
    if (!(await cancelActiveRun({ github, context, core, env, run, trigger: 'automatic' }))) return;
  }
}

module.exports = {
  reviewRequestArtifactName,
  cancelSupersededManualReviews,
  findSupersededAutomaticReviews,
  cancelSupersededAutomaticReviews,
};
