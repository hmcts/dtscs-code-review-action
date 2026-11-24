module.exports = async function getReviewedPullRequest({ github, context, env, knownBaseTip = env.BASE_TIP_SHA }) {
  const { HEAD_SHA: head, MERGE_BASE_SHA: mergeBase } = env;
  const { pulls, repos } = github.rest;
  const { data: pr } = await pulls.get({ ...context.repo, pull_number: context.issue.number });
  if (pr.state !== 'open' || pr.head.sha !== head) return null;
  if (context.eventName === 'pull_request_target' && (pr.draft || pr.base.ref !== (env.REVIEW_TARGET_BRANCH || 'master')))
    return null;

  const currentBaseTip = pr.base.sha;
  if (currentBaseTip === knownBaseTip) return pr;

  const { data: comparison } = await repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${currentBaseTip}...${head}`,
    per_page: 1,
  });
  return comparison.merge_base_commit.sha === mergeBase ? pr : null;
};
