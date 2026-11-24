const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const publish = require('./publish-review.cjs');

const submittedAt = '2026-11-21T14:02:45Z';
const confirmedAt = Date.parse(submittedAt);
const zeroCounts = { P0: 0, P1: 0, P2: 0, P3: 0 };
const noPostedFindings = { inline: zeroCounts, pr_wide: zeroCounts };

const finding = {
  path: 'src/new-name.ts',
  side: 'RIGHT',
  line: 12,
  priority: 1,
  title: 'Preserve the selected case',
  body: 'Clearing the selection leaves the case details pane blank.',
};
const summaryFinding = {
  priority: 2,
  title: 'Keep event state consistent across the API and UI',
  body: 'The caller expects the previous response shape and clears the selected case when it receives the new shape.',
  locations: [
    { path: 'src/consumer.ts', line: 2, revision: 'head' },
    { path: 'api/old response [fixture].ts', line: 1, revision: 'merge_base' },
  ],
};

const patch = [
  '@@ -4,2 +4,2 @@',
  ' context',
  '-old line',
  '+new line',
  '@@ -10,3 +10,4 @@',
  ' context',
  '-deleted line',
  '+added line',
  '+++increment',
  ' trailing context',
  '\\ No newline at end of file',
].join('\n');

function mockRun(
  t,
  {
    findings = [finding],
    summaryFindings = [],
    sourceFiles = {},
    focus = '',
    reviews = [],
    publicationId = '71-1',
    eventName = 'issue_comment',
    heads = ['head', 'head'],
    bases = ['base', 'base'],
    drafts = [false, false],
    baseRef = 'master',
    currentMergeBase = 'merge-base',
    filePatch = patch,
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-review-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputFile = join(directory, 'codex-review-findings.json');
  writeFileSync(outputFile, JSON.stringify({ findings, summaryFindings }));
  const publicationIdFile = join(directory, 'codex-review-publication-id.txt');
  writeFileSync(publicationIdFile, publicationId + '\n');

  const posted = [];
  const comparisons = [];
  const sourceReads = [];
  const parameters = {
    env: {
      REVIEW_OUTPUT_FILE: outputFile,
      REVIEW_PUBLICATION_ID_FILE: publicationIdFile,
      BASE_TIP_SHA: 'base',
      HEAD_SHA: 'head',
      MERGE_BASE_SHA: 'merge-base',
      REVIEW_FOCUS: focus,
      REVIEW_FOCUS_HASH: focus ? createHash('sha256').update(focus).digest('hex') : '',
    },
    context: { serverUrl: 'https://github.com', repo: { owner: 'owner', repo: 'repo' }, issue: { number: 2 }, eventName },
    core: { info() {}, notice() {} },
    github: {
      paginate: (endpoint, params) => endpoint(params),
      rest: {
        pulls: {
          get: async () => ({
            data: {
              state: 'open',
              draft: drafts.shift(),
              base: { sha: bases.shift(), ref: baseRef },
              head: { sha: heads.shift() },
            },
          }),
          listReviews: async () => reviews,
          listFiles: async () => [{ filename: finding.path, previous_filename: 'src/old-name.ts', patch: filePatch }],
          createReview: async (review) => {
            posted.push(review);
            return { data: { submitted_at: submittedAt } };
          },
        },
        repos: {
          compareCommitsWithBasehead: async (params) => {
            comparisons.push(params);
            return { data: { merge_base_commit: { sha: currentMergeBase } } };
          },
          getContent: async ({ path, ref }) => {
            const key = `${ref}:${path}`;
            sourceReads.push(key);
            if (!Object.hasOwn(sourceFiles, key)) throw Object.assign(new Error('File not found'), { status: 404 });
            return { data: { type: 'file', encoding: 'base64', content: Buffer.from(sourceFiles[key]).toString('base64') } };
          },
        },
      },
    },
  };
  return { parameters, posted, comparisons, sourceReads };
}

test('anchors findings to additions and deletions and skips duplicates or unrelated lines', async (t) => {
  const { parameters, posted } = mockRun(t, {
    findings: [
      finding,
      { ...finding, side: 'LEFT', line: 11, priority: 3 },
      finding,
      { ...finding, line: 13 },
      { ...finding, path: 'src/old-name.ts' },
    ],
  });

  const totals = { inline: { ...zeroCounts, P1: 1, P3: 1 }, pr_wide: zeroCounts };
  assert.deepEqual(await publish(parameters), {
    status: 'covered',
    confirmedAt,
    outcome: '2 inline findings posted',
    publication_id: '71-1',
    publication_outcome: 'posted',
    posted_findings: totals,
    published_findings: totals,
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].event, 'COMMENT');
  assert.equal(posted[0].commit_id, 'head');
  assert.equal(posted[0].pull_number, 2);
  assert.match(posted[0].body, /<!-- codex-review:merge-base:head:71-1 -->/);
  assert.deepEqual(posted[0].comments, [
    { path: finding.path, side: 'RIGHT', line: 12, body: `**[P1] ${finding.title}**\n\n${finding.body}` },
    { path: finding.path, side: 'LEFT', line: 11, body: `**[P3] ${finding.title}**\n\n${finding.body}` },
  ]);
});

test('skips publication if the PR head moves after the diff is fetched', async (t) => {
  const { parameters, posted } = mockRun(t, { heads: ['head', 'another-head'] });
  assert.equal((await publish(parameters)).status, 'stale');
  assert.deepEqual(posted, []);
});

test('publishes an automatic review to the PR from the event', async (t) => {
  const { parameters, posted } = mockRun(t, { eventName: 'pull_request_target' });
  assert.equal((await publish(parameters)).status, 'covered');
  assert.equal(posted[0].pull_number, 2);
});

test('skips automatic publication if the PR returns to draft or is retargeted', async (t) => {
  const eventName = 'pull_request_target';
  for (const options of [{ drafts: [false, true] }, { baseRef: 'another-branch' }]) {
    const { parameters, posted } = mockRun(t, { eventName, ...options });
    assert.equal((await publish(parameters)).status, 'stale');
    assert.deepEqual(posted, []);
  }
});

test('still publishes an explicitly requested review on a draft PR', async (t) => {
  const { parameters, posted } = mockRun(t, { drafts: [true, true] });
  assert.equal((await publish(parameters)).status, 'covered');
  assert.equal(posted.length, 1);
});

test('publishes when the base branch advances and the merge base stays the same', async (t) => {
  const { parameters, posted, comparisons } = mockRun(t, { bases: ['new-base', 'new-base'] });
  await publish(parameters);

  assert.equal(posted.length, 1);
  assert.deepEqual(comparisons, [{ owner: 'owner', repo: 'repo', basehead: 'new-base...head', per_page: 1 }]);
});

test('skips publication if the merge base moves after the diff is fetched', async (t) => {
  const { parameters, posted } = mockRun(t, { bases: ['base', 'new-base'], currentMergeBase: 'new-merge-base' });
  assert.equal((await publish(parameters)).status, 'stale');
  assert.deepEqual(posted, []);
});

test('publishes every valid finding from a file larger than 128 KiB', async (t) => {
  const body = finding.body.padEnd(1800, 'x');
  const findings = Array.from({ length: 75 }, (_, index) => ({ ...finding, line: index + 1, body }));
  const filePatch = [`@@ -0,0 +1,${findings.length} @@`, ...findings.map(({ line }) => `+Added line ${line}`)].join('\n');
  const { parameters, posted } = mockRun(t, { findings, filePatch });

  assert.ok(statSync(parameters.env.REVIEW_OUTPUT_FILE).size > 128 * 1024);

  await publish(parameters);

  assert.equal(posted.length, 1);
  assert.deepEqual(
    posted[0].comments.map(({ line }) => line),
    findings.map(({ line }) => line)
  );
});

test('skips findings already posted by the workflow even if the base branch has advanced', async (t) => {
  const { parameters, posted } = mockRun(t, {
    bases: ['new-base'],
    reviews: [{ user: { login: 'github-actions[bot]' }, body: '<!-- codex-review:merge-base:head:71-1 -->' }],
  });
  assert.equal((await publish(parameters)).status, 'covered');
  assert.deepEqual(posted, []);
});

test('posts fresh findings for the same diff and focus and recovers their original totals on retry', async (t) => {
  const focus = 'regression coverage';
  const earlier = mockRun(t, { focus });
  await publish(earlier.parameters);
  const reviews = earlier.posted.map(({ body }) => ({ body, user: { login: 'github-actions[bot]' } }));

  const options = {
    focus,
    reviews,
    publicationId: '72-1',
    summaryFindings: [summaryFinding],
    sourceFiles: { 'head:src/consumer.ts': 'first line\nsecond line\n' },
  };
  const totals = { inline: { ...zeroCounts, P1: 1 }, pr_wide: { ...zeroCounts, P2: 1 } };
  const fresh = mockRun(t, options);
  assert.partialDeepStrictEqual(await publish(fresh.parameters), {
    status: 'covered',
    publication_id: '72-1',
    posted_findings: totals,
    published_findings: totals,
  });
  assert.equal(fresh.posted.length, 1);
  assert.ok(fresh.posted[0].body.endsWith(`:72-1 -->`));

  // Simulate a retry with the submitted review available and its receipt lost.
  reviews.push({ body: fresh.posted[0].body, submitted_at: submittedAt, user: { login: 'github-actions[bot]' } });
  const retry = mockRun(t, options);
  assert.partialDeepStrictEqual(await publish(retry.parameters), {
    status: 'covered',
    confirmedAt,
    publication_id: '72-1',
    publication_outcome: 'already_posted',
    posted_findings: noPostedFindings,
    published_findings: totals,
  });
  assert.deepEqual(retry.posted, []);
});

test('posts the focus as literal text in the opening line and keeps it separate from other reviews of the diff', async (t) => {
  const focus =
    'Check `client` and ``handler`` [docs](https://example.invalid) @owner <!-- codex-review:merge-base:head:71-1 -->';
  const otherHash = createHash('sha256').update('another focus').digest('hex');
  const { parameters, posted } = mockRun(t, {
    focus,
    reviews: [
      { user: { login: 'github-actions[bot]' }, body: 'General review\n\n<!-- codex-review:merge-base:head:71-1 -->' },
      {
        user: { login: 'github-actions[bot]' },
        body: `Other focused review\n\n<!-- codex-review:merge-base:head:${otherHash}:71-1 -->`,
      },
    ],
  });

  assert.partialDeepStrictEqual(await publish(parameters), {
    status: 'covered',
    confirmedAt,
    outcome: '1 inline finding posted',
  });
  assert.equal(posted.length, 1);
  const [openingLine] = posted[0].body.split('\n');
  assert.equal(openingLine, `Codex review of \`head\` — \`\`\` ${focus} \`\`\`.`);
  assert.ok(posted[0].body.endsWith(`<!-- codex-review:merge-base:head:${parameters.env.REVIEW_FOCUS_HASH}:71-1 -->`));
});

test('deduplicates a focused review only by its own final publication marker', async (t) => {
  const focus = 'case creation regression coverage';
  const hash = createHash('sha256').update(focus).digest('hex');
  const prior = {
    user: { login: 'github-actions[bot]' },
    submitted_at: submittedAt,
    body: `Earlier review\n\n<!-- codex-review:merge-base:head:${hash}:71-1 -->\n`,
  };
  const matching = mockRun(t, { focus, reviews: [prior] });
  assert.partialDeepStrictEqual(await publish(matching.parameters), {
    status: 'covered',
    confirmedAt,
    outcome: 'This Codex review was already posted',
    posted_findings: noPostedFindings,
    published_findings: null,
  });
  assert.deepEqual(matching.posted, []);

  const embedded = {
    ...prior,
    body: 'Focused heading includes the general marker <!-- codex-review:merge-base:head:71-1 -->\n\n' + prior.body,
  };
  const general = mockRun(t, { reviews: [embedded] });
  assert.partialDeepStrictEqual(await publish(general.parameters), {
    status: 'covered',
    confirmedAt,
    outcome: '1 inline finding posted',
  });
  assert.equal(general.posted.length, 1);
  assert.ok(general.posted[0].body.startsWith('Codex review of `head`.'));
});

test('keeps the review covered when its counts metadata is malformed or misplaced', async (t) => {
  const marker = '<!-- codex-review:merge-base:head:71-1 -->';
  const invalid = { inline: { ...zeroCounts, P1: -1 }, pr_wide: zeroCounts };
  for (const body of [
    `<!-- codex-review-counts:{ -->\n\n${marker}`,
    `<!-- codex-review-counts:${JSON.stringify(invalid)} -->\n\n${marker}`,
    `<!-- codex-review-counts:${JSON.stringify(noPostedFindings)} -->\n\nReview text\n\n${marker}`,
  ]) {
    const { parameters, posted } = mockRun(t, { reviews: [{ user: { login: 'github-actions[bot]' }, body }] });
    assert.partialDeepStrictEqual(await publish(parameters), {
      status: 'covered',
      publication_outcome: 'already_posted',
      posted_findings: noPostedFindings,
      published_findings: null,
    });
    assert.deepEqual(posted, []);
  }
});

test('posts a neutral review for an empty result and confirms it at submission', async (t) => {
  const { parameters, posted } = mockRun(t, { findings: [] });
  assert.partialDeepStrictEqual(await publish(parameters), {
    status: 'covered',
    confirmedAt,
    outcome: 'No actionable findings',
    publication_outcome: 'empty',
    posted_findings: noPostedFindings,
    published_findings: noPostedFindings,
  });
  assert.deepEqual(posted, [
    {
      owner: 'owner',
      repo: 'repo',
      pull_number: 2,
      commit_id: 'head',
      event: 'COMMENT',
      body: [
        'Codex review of `head`.',
        'No actionable findings.',
        `<!-- codex-review-counts:${JSON.stringify(noPostedFindings)} -->`,
        '<!-- codex-review:merge-base:head:71-1 -->',
      ].join('\n\n'),
    },
  ]);
});

test('deduplicates a retried clean review while publishing a fresh one for the same revision', async (t) => {
  const original = mockRun(t, { findings: [] });
  await publish(original.parameters);
  const reviews = [{ body: original.posted[0].body, submitted_at: submittedAt, user: { login: 'github-actions[bot]' } }];

  const retry = mockRun(t, { findings: [], reviews });
  assert.partialDeepStrictEqual(await publish(retry.parameters), {
    status: 'covered',
    confirmedAt,
    publication_outcome: 'already_posted',
    posted_findings: noPostedFindings,
    published_findings: noPostedFindings,
  });
  assert.deepEqual(retry.posted, []);

  const fresh = mockRun(t, { findings: [], reviews, publicationId: '72-1' });
  assert.equal((await publish(fresh.parameters)).publication_outcome, 'empty');
  assert.equal(fresh.posted.length, 1);
  assert.ok(fresh.posted[0].body.endsWith('<!-- codex-review:merge-base:head:72-1 -->'));
});

test('keeps a clean review silent when the head changes before publication', async (t) => {
  for (const heads of [['another-head'], ['head', 'another-head']]) {
    const { parameters, posted } = mockRun(t, { findings: [], heads });
    assert.partialDeepStrictEqual(await publish(parameters), {
      status: 'stale',
      publication_outcome: 'stale',
      posted_findings: noPostedFindings,
      published_findings: null,
    });
    assert.deepEqual(posted, []);
  }
});

test('distinguishes unanchored findings from an empty review', async (t) => {
  const { parameters, posted } = mockRun(t, { findings: [{ ...finding, line: 13 }] });
  assert.partialDeepStrictEqual(await publish(parameters), {
    status: 'invalid',
    outcome: 'No findings could be anchored to changed lines in the PR diff',
  });
  assert.deepEqual(posted, []);
});

test('posts a PR-wide finding alone with links to unchanged and pre-change code', async (t) => {
  const { parameters, posted } = mockRun(t, {
    findings: [],
    summaryFindings: [summaryFinding],
    sourceFiles: {
      'head:src/consumer.ts': 'first line\nreturn previousShape;\n',
      'merge-base:api/old response [fixture].ts': 'const previousShape = {};',
    },
  });

  assert.partialDeepStrictEqual(await publish(parameters), {
    status: 'covered',
    confirmedAt,
    outcome: '1 PR-wide finding posted',
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].event, 'COMMENT');
  assert.equal(posted[0].commit_id, 'head');
  assert.equal(posted[0].comments, undefined);
  assert.ok(posted[0].body.includes('### PR-wide findings'));
  assert.ok(posted[0].body.includes(`**[P2] ${summaryFinding.title}**`));
  assert.ok(posted[0].body.includes('[src/consumer.ts:2](<https://github.com/owner/repo/blob/head/src/consumer.ts#L2>)'));
  assert.ok(posted[0].body.includes('https://github.com/owner/repo/blob/merge-base/api/old%20response%20%5Bfixture%5D.ts#L1'));
  assert.ok(posted[0].body.includes('<!-- codex-review:merge-base:head:71-1 -->'));
});

test('posts both kinds of findings together and uses only verified source lines in the summary', async (t) => {
  const missing = { path: 'src/missing.ts', line: 1, revision: 'head' };
  const invalidLine = { ...summaryFinding.locations[0], line: 3 };
  const anchored = { ...summaryFinding, locations: [missing, invalidLine, summaryFinding.locations[0]] };
  const { parameters, posted, sourceReads } = mockRun(t, {
    summaryFindings: [anchored, anchored, { ...summaryFinding, priority: 0, locations: [missing] }],
    sourceFiles: { 'head:src/consumer.ts': 'first line\nsecond line\n' },
  });

  assert.partialDeepStrictEqual(await publish(parameters), {
    status: 'covered',
    confirmedAt,
    outcome: '1 inline finding and 1 PR-wide finding posted',
    publication_outcome: 'posted',
    posted_findings: { inline: { ...zeroCounts, P1: 1 }, pr_wide: { ...zeroCounts, P2: 1 } },
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].comments.length, 1);
  assert.ok(posted[0].body.includes('src/consumer.ts#L2'));
  assert.ok(!posted[0].body.includes('src/consumer.ts#L3'));
  assert.ok(!posted[0].body.includes('src/missing.ts'));
  assert.deepEqual(sourceReads, ['head:src/missing.ts', 'head:src/consumer.ts']);
});

test('skips a PR-wide finding when its file or line cannot be verified', async (t) => {
  const { parameters, posted } = mockRun(t, {
    findings: [],
    summaryFindings: [summaryFinding],
    sourceFiles: { 'head:src/consumer.ts': 'only one line\n' },
  });
  assert.partialDeepStrictEqual(await publish(parameters), {
    status: 'invalid',
    outcome: 'No findings had verifiable code locations',
  });
  assert.deepEqual(posted, []);
});

test('skips a summary-only review when the head changes during source verification', async (t) => {
  const { parameters, posted } = mockRun(t, {
    findings: [],
    summaryFindings: [summaryFinding],
    heads: ['head', 'another-head'],
    sourceFiles: { 'head:src/consumer.ts': 'first line\nsecond line\n' },
  });
  assert.partialDeepStrictEqual(await publish(parameters), {
    status: 'stale',
    outcome: 'The PR changed or closed before the review could be posted',
  });
  assert.deepEqual(posted, []);
});

test('rejects malformed findings before publication', async (t) => {
  const { parameters, posted } = mockRun(t, { findings: [{ ...finding, line: '12' }] });
  assert.equal((await publish(parameters)).status, 'invalid');
  assert.deepEqual(posted, []);
});

test('rejects missing or malformed publication files before calling GitHub', async (t) => {
  const { parameters } = mockRun(t, { publicationId: 'invalid' });
  parameters.github.rest.pulls.get = () => assert.fail('invalid artifacts should not query the PR');
  assert.equal((await publish(parameters)).status, 'invalid');

  rmSync(parameters.env.REVIEW_PUBLICATION_ID_FILE);
  assert.equal((await publish(parameters)).status, 'invalid');

  writeFileSync(parameters.env.REVIEW_PUBLICATION_ID_FILE, '71-1');
  writeFileSync(parameters.env.REVIEW_OUTPUT_FILE, '{');
  assert.equal((await publish(parameters)).status, 'invalid');
});

test('accepts findings at the schema length limit with supplementary Unicode characters', async (t) => {
  const title = '🔧'.repeat(80);
  const body = '🔧'.repeat(2000);
  const { parameters, posted } = mockRun(t, { findings: [{ ...finding, title, body }] });
  assert.equal((await publish(parameters)).status, 'covered');
  assert.equal(posted[0].comments[0].body, `**[P1] ${title}**\n\n${body}`);
});

test('marks an oversized PR-wide review invalid when GitHub rejects the full payload', async (t) => {
  const body = summaryFinding.body.padEnd(2000, 'x');
  const summaryFindings = Array.from({ length: 40 }, (_, index) => ({
    ...summaryFinding,
    title: `PR-wide finding ${index}`,
    body,
    locations: [summaryFinding.locations[0]],
  }));
  const { parameters } = mockRun(t, { findings: [], summaryFindings, sourceFiles: { 'head:src/consumer.ts': 'one\ntwo\n' } });
  parameters.github.rest.pulls.createReview = async (review) => {
    for (const { title } of summaryFindings) assert.ok(review.body.includes(`**[P2] ${title}**`));
    throw Object.assign(new Error('Validation Failed'), {
      status: 422,
      response: {
        data: {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequestReview', code: 'unprocessable', field: 'body', message: 'Body is too long' }],
        },
      },
    });
  };
  assert.partialDeepStrictEqual(await publish(parameters), {
    status: 'invalid',
    outcome: 'GitHub rejected the Codex review payload',
    publication_id: '71-1',
    publication_outcome: 'invalid',
    posted_findings: noPostedFindings,
    published_findings: null,
  });
});

test('marks an HTTP 413 payload rejection invalid', async (t) => {
  const { parameters } = mockRun(t);
  parameters.github.rest.pulls.createReview = async () => {
    throw Object.assign(new Error('Payload Too Large'), { status: 413 });
  };
  assert.equal((await publish(parameters)).status, 'invalid');
});

test('keeps transient and ambiguous publication failures retryable', async (t) => {
  const retryableErrors = [
    { status: 502 },
    { status: 429 },
    { status: 422 },
    { status: 422, response: { headers: { 'retry-after': '60' } } },
    {
      status: 422,
      response: { data: { message: 'Validation Failed', errors: [{ code: 'custom', message: 'Review creation was spammed' }] } },
    },
  ];
  for (const details of retryableErrors) {
    const { parameters } = mockRun(t);
    const failure = Object.assign(new Error('Publication failed'), details);
    parameters.github.rest.pulls.createReview = async () => {
      throw failure;
    };
    await assert.rejects(publish(parameters), (error) => error === failure);
  }
});
