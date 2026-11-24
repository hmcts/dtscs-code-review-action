const { readPublicationOutcome } = require('./review-artifacts.cjs');

module.exports = async function resolveExistingReview({ github, context, artifactName }) {
  const { comment, repository } = context.payload;
  const automatic = context.eventName === 'pull_request_target';
  const { actions } = github.rest;
  // Intake only uses confirmed results. Decisions to generate or retry happen
  // inside the same queue that protects publication.
  const artifacts = await github.paginate(actions.listArtifactsForRepo, {
    ...context.repo,
    name: artifactName,
    per_page: 100,
  });

  let latest;
  const newestFirst = artifacts.toSorted((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  for (const artifact of newestFirst) {
    const origin = artifact.workflow_run;
    if (artifact.expired || !origin || origin.id === context.runId || origin.head_repository_id !== repository.id) {
      continue;
    }

    const runParams = { ...context.repo, run_id: origin.id };
    const { data: run } = await actions.getWorkflowRun(runParams);
    // For pull_request_target, Actions records the PR branch as the run's head branch.
    const fromReviewEvent =
      run.event === 'pull_request_target' || (run.event === 'issue_comment' && origin.head_branch === repository.default_branch);
    if (
      !fromReviewEvent ||
      run.path?.split('@')[0] !== '.github/workflows/codex-review.yml' ||
      artifact.created_at < run.created_at
    ) {
      continue;
    }

    const receipts = await github.paginate(actions.listWorkflowRunArtifacts, { ...runParams, per_page: 100 });
    const outcome = readPublicationOutcome(receipts, artifact.id);
    if (automatic && outcome.status === 'covered') return { mode: 'covered', url: run.html_url };
    latest ??= { runId: origin.id, artifactId: artifact.id, url: run.html_url, outcome };
    if (!automatic) break;
  }

  if (!latest) return null;

  const { runId, artifactId, url, outcome } = latest;

  if (outcome.status === 'covered') {
    return Date.parse(comment.created_at) <= outcome.confirmedAt ? { mode: 'covered', url } : null;
  }
  if (outcome.status === 'invalid') return null;
  return { mode: 'retry', runId, artifactId, url };
};
