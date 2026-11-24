# HMCTS DTS Common Services code review action

Reusable GitHub Actions workflow for Codex PR reviews. The calling repository
owns the workflow triggers, repository guidance and environment credentials. Review
findings, request markers, publication receipts and stats remain in the calling
repository.

## Use in a repository

1. Confirm the calling repository's Actions policy allows the pinned workflow
   from `hmcts/dtscs-code-review-action` and the actions it uses.
2. Ask your repository maintainers which HMCTS-managed OpenAI project to use
   for the EU Responses API. In the calling repository, create the
   `code-review` environment and add the approved key as the
   `OPENAI_API_KEY` environment secret. Restrict the environment to the
   protected branch that supplies the review workflow.
3. Add `.github/workflows/codex-review.yml` with the repository's
   `issue_comment` and `pull_request_target` triggers. Keep this filename so
   active-run and artifact provenance checks can identify the caller. Call
   the shared workflow at a full commit SHA and pass the automatic review
   target branch as `target_branch` and `OPENAI_API_KEY` by name.
4. In the calling repository, open **Settings → Actions → Policies** and create
   or update an **Active** policy scoped to `.github/workflows/codex-review.yml`.
   Under **Restrict events**, allow `pull_request_target` and `issue_comment`.
   [GitHub's Actions policy guide](https://docs.github.com/en/actions/how-tos/administer/control-workflow-execution#creating-a-workflow-execution-policy)

The calling job needs `actions: write`, `checks: write`, `contents: read`,
`issues: write` and `pull-requests: write` as the ceiling for the workflow.
Each called job receives its own narrower permissions. The review job binds
to the caller's `code-review` environment and runs Codex read-only.

### Example caller workflow

Save this as `.github/workflows/codex-review.yml` in the calling repository.
Replace `master` in both places if the caller uses a different default branch.
Replace `RELEASE_SHA` with the full commit SHA of the
[`v1.0.0` tag](https://github.com/hmcts/dtscs-code-review-action/tree/v1.0.0).
For a later release, update the SHA and the version comment together.

```bash
git ls-remote https://github.com/hmcts/dtscs-code-review-action.git 'refs/tags/v1.0.0^{}'
```

```yaml
name: Codex PR review

on:
  issue_comment:
    types: [created]
  pull_request_target:
    branches: [master]
    types: [opened, ready_for_review, reopened, synchronize]

permissions: {}

jobs:
  review:
    permissions:
      actions: write
      checks: write
      contents: read
      issues: write
      pull-requests: write
    uses: hmcts/dtscs-code-review-action/.github/workflows/codex-review.yml@RELEASE_SHA # v1.0.0
    with:
      target_branch: master
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### Request a review

With write access, post either command in the **Conversation** tab of a
same-repository pull request.

- `/review` reviews the whole diff.
- `/review Check compatibility of the dependency upgrade` focuses the review on
  that area.

Marking a same-repository draft PR ready for review starts an automatic review.

## Repository guidance and dependencies

Keep repository-specific review guidance in `AGENTS.md`. Codex starts from the
trusted checkout and reads the PR revisions from Git objects.

When the Yarn lockfile changes, the workflow checks public npm metadata for
changed direct dependencies. If both locked releases identify the same `hmcts`
GitHub repository and supply source commits, Codex receives the exact upstream
diff. The review continues when that context is unavailable. Conditional installs
use the caller's trusted Node and Yarn pins.

## Tests and releases

Run `node --test actions/review-tools/*.test.cjs` with Node 24. The workflows
load the bundled helpers from the same commit via `$/actions/review-tools`.

1. Merge the tested workflow and helper changes into `main`.
2. Publish a new `vMAJOR.MINOR.PATCH` tag on the merged commit. Use a patch
   bump for behaviour-preserving changes, a minor bump for compatible features,
   and a major bump for breaking changes. Keep existing tags on their original
   commits. For example, replace `MERGED_SHA` below with the tested merge commit.

   ```bash
   git fetch origin main
   git tag -a v1.0.1 MERGED_SHA -m 'Code Review Workflow v1.0.1'
   git push origin refs/tags/v1.0.1
   ```

3. In each caller, pin the full SHA that the new tag points to and add the
   matching version comment, as in the example above. Renovate can propose
   updates to the SHA and comment when it has read access to the shared repo.
