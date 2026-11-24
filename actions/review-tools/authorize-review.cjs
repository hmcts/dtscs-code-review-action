const { createHash } = require('node:crypto');

module.exports = async function authorizeReview({ github, context, core, targetBranch = 'master' }) {
  const { comment, repository, sender } = context.payload;
  const manual = context.eventName === 'issue_comment';
  const push = !manual && context.payload.action === 'synchronize';
  const requester = manual ? comment.user : sender;
  let focus = '';
  if (manual) {
    const command = /^\/review(?:[ \t]+(.*))?$/u.exec(comment.body);
    if (!command) return;
    focus = (command[1] ?? '').trim();
    if (!focus.isWellFormed() || /\p{Cc}/u.test(focus) || [...focus].length > 500) {
      core.notice('Use a single-line review focus of up to 500 characters.');
      return;
    }
  }

  let permission;
  try {
    const { data: access } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...context.repo,
      username: requester.login,
    });
    permission = access.permission;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (!['write', 'admin'].includes(permission)) {
    core.notice('PR review requires repository write access.');
    return;
  }

  const pullNumber = context.issue.number;
  const { data: pr } = await github.rest.pulls.get({
    ...context.repo,
    pull_number: pullNumber,
  });
  if (pr.state !== 'open' || pr.head.repo?.id !== repository.id) {
    core.notice('PR review requires an open pull request from this repository.');
    return;
  }
  if (!manual && pr.user?.type === 'Bot') {
    core.notice('Bot-authored PRs require a manual /review request.');
    return;
  }
  if (!manual && (pr.draft || pr.base.ref !== targetBranch)) {
    core.notice(`Automatic review requires a non-draft pull request targeting ${targetBranch}.`);
    return;
  }
  if (push && pr.head.sha !== context.payload.pull_request.head.sha) {
    core.notice('The automatic review request was superseded by another PR revision.');
    return;
  }

  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${pr.base.sha}...${pr.head.sha}`,
    per_page: 1,
  });
  const mergeBase = comparison.merge_base_commit.sha;
  const focusHash = focus ? createHash('sha256').update(focus).digest('hex') : '';
  return {
    base_tip: pr.base.sha,
    head: pr.head.sha,
    merge_base: mergeBase,
    focus,
    focus_hash: focusHash,
    review_key: [pullNumber, mergeBase, pr.head.sha, focusHash].filter(Boolean).join('-'),
  };
};
