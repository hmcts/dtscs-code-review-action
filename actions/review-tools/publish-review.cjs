const { readFileSync } = require('node:fs');
const { parseFindings, readPublicationId, countFindings } = require('./review-findings.cjs');
const getReviewedPullRequest = require('./review-revision.cjs');

const countsMarkerPrefix = '<!-- codex-review-counts:';
const countsMarkerEnd = ' -->';
const cleanOutcome = 'No actionable findings';

function changedLines(patch) {
  const lines = { LEFT: new Set(), RIGHT: new Set() };
  let oldLine;
  let newLine;

  for (const row of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (oldLine !== undefined) {
      switch (row[0]) {
        case '-':
          lines.LEFT.add(oldLine++);
          break;
        case '+':
          lines.RIGHT.add(newLine++);
          break;
        case ' ':
          oldLine++;
          newLine++;
          break;
      }
    }
  }

  return lines;
}

function formatFinding({ priority, title, body }) {
  return `**[P${priority}] ${title.trim()}**\n\n${body.trim()}`;
}

function recoverPublishedFindings(body, marker) {
  const beforeMarker = body.trimEnd().slice(0, -marker.length).trimEnd();
  const metadata = beforeMarker.slice(beforeMarker.lastIndexOf('\n') + 1);
  if (!metadata.startsWith(countsMarkerPrefix) || !metadata.endsWith(countsMarkerEnd)) return null;

  let saved;
  try {
    saved = JSON.parse(metadata.slice(countsMarkerPrefix.length, -countsMarkerEnd.length));
  } catch {
    return null;
  }

  const counts = countFindings();
  for (const [placement, priorities] of Object.entries(counts)) {
    for (const priority of Object.keys(priorities)) {
      const count = saved?.[placement]?.[priority];
      if (!Number.isSafeInteger(count) || count < 0) return null;
      priorities[priority] = count;
    }
  }
  return counts;
}

function formatCodeSpan(text) {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  return `${fence} ${text} ${fence}`;
}

async function sourceLineCount(github, repo, path, ref) {
  try {
    let { data } = await github.rest.repos.getContent({
      ...repo,
      path,
      ref,
      headers: { accept: 'application/vnd.github.object+json' },
    });
    if (data.type !== 'file') return 0;
    if (data.encoding === 'none') {
      const blob = await github.rest.git.getBlob({ ...repo, file_sha: data.sha });
      data = blob.data;
    }
    if (data.encoding !== 'base64' || typeof data.content !== 'string') return 0;

    const contents = Buffer.from(data.content, 'base64');
    if (!contents.length || contents.includes(0)) return 0;
    return contents.toString('utf8').replace(/\n$/, '').split('\n').length;
  } catch (error) {
    if (error.status === 404) return 0;
    throw error;
  }
}

async function renderSummaryFindings({ github, context, summaryFindings, head, mergeBase }) {
  const { owner, repo } = context.repo;
  const lineCounts = new Map();
  const summaries = new Map();

  for (const finding of summaryFindings) {
    const links = new Set();
    for (const { path, line, revision } of finding.locations) {
      const ref = revision === 'head' ? head : mergeBase;
      const key = `${ref}:${path}`;
      if (!lineCounts.has(key)) {
        lineCounts.set(key, await sourceLineCount(github, context.repo, path, ref));
      }
      if (line > lineCounts.get(key)) continue;

      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      const label = `${path}:${line}`.replace(/[\\\[\]]/g, '\\$&');
      const url = `${context.serverUrl}/${owner}/${repo}/blob/${ref}/${encodedPath}#L${line}`;
      links.add(`[${label}](<${url}>)`);
    }
    if (links.size) summaries.set(`${formatFinding(finding)}\n\n**Related code** ${[...links].join(', ')}`, finding.priority);
  }

  return summaries;
}

function isPermanentPayloadRejection(error) {
  if (error.status === 413) return true;
  if (error.status !== 422 || error.response?.headers?.['retry-after']) return false;

  const { message, errors } = error.response?.data ?? {};
  const details = Array.isArray(errors) ? errors : [];
  const diagnostics = [message, ...details.map((detail) => detail?.message ?? detail)].join(' ');
  // GitHub also returns 422 when it throttles review creation as spam.
  if (/\b(spam\w*|abuse|rate[ -]limit|pending review)\b/i.test(diagnostics)) return false;
  return /^Invalid request\b/i.test(message ?? '') || (details.length > 0 && /^Validation Failed\b/i.test(message ?? ''));
}

module.exports = async function publish({ github, context, core, env }) {
  const { HEAD_SHA: head, MERGE_BASE_SHA: mergeBase, REVIEW_FOCUS: focus, REVIEW_FOCUS_HASH: focusHash } = env;
  if (Boolean(focus) !== Boolean(focusHash)) throw new Error('The requested review focus is unavailable.');
  const pr = { ...context.repo, pull_number: context.issue.number };
  const { pulls } = github.rest;

  let publicationId = null;
  function finish(
    status,
    outcome,
    { publicationOutcome = status, postedFindings = countFindings(), publishedFindings = null, confirmedAt } = {}
  ) {
    core[status === 'covered' ? 'info' : 'notice'](outcome);
    return {
      status,
      outcome,
      confirmedAt,
      publication_id: publicationId,
      publication_outcome: publicationOutcome,
      posted_findings: postedFindings,
      published_findings: publishedFindings,
    };
  }

  function confirm(
    publicationOutcome,
    outcome,
    { submittedAt, postedFindings = countFindings(), publishedFindings = postedFindings } = {}
  ) {
    const timestamp = Date.parse(submittedAt);
    const confirmedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
    return finish('covered', outcome, { publicationOutcome, confirmedAt, postedFindings, publishedFindings });
  }

  let review;
  try {
    publicationId = readPublicationId(env.REVIEW_PUBLICATION_ID_FILE);
    review = parseFindings(readFileSync(env.REVIEW_OUTPUT_FILE, 'utf8'));
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw error;
    return finish('invalid', 'The Codex findings artifact is missing or invalid');
  }
  if (!publicationId) {
    return finish('invalid', 'The Codex findings artifact has an invalid publication ID');
  }
  const { findings, summaryFindings } = review;
  const clean = findings.length === 0 && summaryFindings.length === 0;

  const reviewedPullRequest = await getReviewedPullRequest({ github, context, env });
  if (reviewedPullRequest === null) {
    return finish('stale', 'The PR changed or closed after the review was requested');
  }

  const markerKey = [mergeBase, head, focusHash, publicationId].filter(Boolean).join(':');
  const marker = `<!-- codex-review:${markerKey} -->`;
  const reviews = await github.paginate(pulls.listReviews, { ...pr, per_page: 100 });
  const publishedReview = reviews.find(
    (review) =>
      review.user?.login === 'github-actions[bot]' && review.state !== 'PENDING' && review.body?.trimEnd().endsWith(marker)
  );
  if (publishedReview) {
    return confirm('already_posted', 'This Codex review was already posted', {
      submittedAt: publishedReview.submitted_at,
      publishedFindings: recoverPublishedFindings(publishedReview.body, marker),
    });
  }

  const files = findings.length ? await github.paginate(pulls.listFiles, { ...pr, per_page: 100 }) : [];
  const linesByPath = new Map(files.filter(({ patch }) => patch).map(({ filename, patch }) => [filename, changedLines(patch)]));
  const comments = [];
  const inlinePriorities = [];
  const seen = new Set();

  for (const finding of findings) {
    const { path, side, line, title } = finding;
    const key = JSON.stringify([path, side, line, title]);
    if (seen.has(key) || !linesByPath.get(path)?.[side].has(line)) continue;
    seen.add(key);
    comments.push({ path, side, line, body: formatFinding(finding) });
    inlinePriorities.push(finding.priority);
  }

  const summaries = await renderSummaryFindings({ github, context, summaryFindings, head, mergeBase });
  if (!clean && !comments.length && !summaries.size) {
    if (summaryFindings.length) return finish('invalid', 'No findings had verifiable code locations');
    return finish('invalid', 'No findings could be anchored to changed lines in the PR diff');
  }

  if ((await getReviewedPullRequest({ github, context, env, knownBaseTip: reviewedPullRequest.base.sha })) === null) {
    return finish('stale', 'The PR changed or closed before the review could be posted');
  }

  const reviewIntro = `Codex review of \`${head.slice(0, 12)}\``;
  const body = [`${reviewIntro}${focus ? ` — ${formatCodeSpan(focus)}` : ''}.`];
  if (clean) body.push(`${cleanOutcome}.`);
  if (summaries.size) body.push('### PR-wide findings', ...summaries.keys());
  const postedFindings = countFindings(inlinePriorities, summaries.values());
  body.push(`${countsMarkerPrefix}${JSON.stringify(postedFindings)}${countsMarkerEnd}`, marker);
  let submittedAt;
  try {
    const { data } = await pulls.createReview({
      ...pr,
      commit_id: head,
      event: 'COMMENT',
      body: body.join('\n\n'),
      ...(comments.length ? { comments } : {}),
    });
    submittedAt = data.submitted_at;
  } catch (error) {
    if (!isPermanentPayloadRejection(error)) throw error;
    return finish('invalid', 'GitHub rejected the Codex review payload');
  }

  if (clean) return confirm('empty', cleanOutcome, { submittedAt, postedFindings });

  const counts = [
    [comments.length, 'inline'],
    [summaries.size, 'PR-wide'],
  ]
    .filter(([count]) => count > 0)
    .map(([count, kind]) => `${count} ${kind} ${count === 1 ? 'finding' : 'findings'}`);
  return confirm('posted', `${counts.join(' and ')} posted`, { submittedAt, postedFindings });
};
