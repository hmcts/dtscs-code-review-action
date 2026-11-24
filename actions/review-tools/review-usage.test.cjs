const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { test } = require('node:test');
const recordReviewUsage = require('./review-usage.cjs');
const { markReviewStatsCancelled } = recordReviewUsage;

const zeroCounts = { P0: 0, P1: 0, P2: 0, P3: 0 };
const noGeneratedFindings = { inline: zeroCounts, pr_wide: zeroCounts };
const inlineFinding = {
  path: 'src/example.ts',
  side: 'RIGHT',
  line: 1,
  priority: 0,
  title: 'Finding title stays in the findings artifact',
  body: 'Finding body stays in the findings artifact.',
};

function fixture(t, overrides = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'codex-review-stats-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return {
    RUNNER_TEMP: temp,
    GITHUB_STEP_SUMMARY: join(temp, 'summary.md'),
    REVIEW_CODEX_HOME: join(temp, 'codex-review-home'),
    REVIEW_PR_NUMBER: '7',
    HEAD_SHA: 'head',
    MERGE_BASE_SHA: 'merge-base',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '2',
    REVIEW_TRIGGER: 'focused',
    REVIEW_MODE: 'generate',
    CODEX_OUTCOME: 'success',
    REVIEW_CODEX_MODEL: 'test-model',
    REVIEW_CODEX_EFFORT: 'medium',
    REVIEW_CODEX_STARTED_AT_MS: '10000',
    REVIEW_CODEX_FINISHED_AT_MS: '12345',
    REVIEW_OUTPUT_FILE: join(temp, 'codex-review-findings.json'),
    REVIEW_PUBLICATION_ID_FILE: join(temp, 'codex-review-publication-id.txt'),
    ...overrides,
  };
}

function response(id, input, cached, output) {
  return {
    type: 'token_usage_record',
    payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
  };
}

function writeRollout(env, name, entries) {
  const path = join(env.REVIEW_CODEX_HOME, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function usageJson(env) {
  return JSON.parse(readFileSync(join(env.RUNNER_TEMP, 'review-stats.json'), 'utf8'));
}

test('records each response once and writes only counts and review identifiers', async (t) => {
  const env = fixture(t);
  const first = response('resp-first', 1000, 300, 30);
  writeRollout(env, 'sessions/2026/11/21/rollout-first.jsonl', [
    first,
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9999 } } } },
    { type: 'response_item', payload: { text: 'review source stays on the runner' } },
  ]);
  writeRollout(env, 'archived_sessions/rollout-second.jsonl', [first, response('resp-second', 500, 100, 12)]);
  writeFileSync(
    env.REVIEW_OUTPUT_FILE,
    JSON.stringify({
      findings: [inlineFinding, { ...inlineFinding, priority: 2 }],
      summaryFindings: [
        {
          priority: 3,
          title: inlineFinding.title,
          body: inlineFinding.body,
          locations: [{ path: inlineFinding.path, line: 10, revision: 'head' }],
        },
      ],
    })
  );
  writeFileSync(env.REVIEW_PUBLICATION_ID_FILE, '12345-2\n');

  await recordReviewUsage(env);

  assert.deepEqual(usageJson(env), {
    pr_number: 7,
    head_sha: 'head',
    merge_base_sha: 'merge-base',
    run_id: '12345',
    run_attempt: 2,
    trigger: 'focused',
    review_mode: 'generate',
    codex_outcome: 'success',
    model: 'test-model',
    effort: 'medium',
    codex_duration_ms: 2345,
    publication_id: '12345-2',
    generated_findings: { inline: { ...zeroCounts, P0: 1, P2: 1 }, pr_wide: { ...zeroCounts, P3: 1 } },
    status: 'recorded',
    input_tokens: 1500,
    cached_input_tokens: 400,
    output_tokens: 42,
  });
  const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /\| Trigger \| Model \| Effort \| Codex duration \|/);
  assert.match(summary, /\| focused \| test-model \| medium \| 2\.345 s \|/);
  assert.match(summary, /\| Input tokens \| Cached input tokens \| Output tokens \|/);
  assert.match(summary, /\| 1,500 \| 400 \| 42 \|/);
  assert.doesNotMatch(summary, /review source stays on the runner/);
});

test('reused, retried, and stale requests record zero new tokens', async (t) => {
  for (const [mode, status] of [
    ['covered', 'reused'],
    ['retry', 'retried'],
    ['stale', 'stale'],
  ]) {
    await t.test(status, async (t) => {
      const env = fixture(t, { REVIEW_TRIGGER: 'automatic', REVIEW_MODE: mode, CODEX_OUTCOME: 'skipped' });
      writeRollout(env, 'sessions/rollout-old.jsonl', [response('resp-old', 1000, 300, 30)]);
      writeFileSync(env.REVIEW_OUTPUT_FILE, JSON.stringify({ findings: [inlineFinding], summaryFindings: [] }));
      writeFileSync(env.REVIEW_PUBLICATION_ID_FILE, '12300-1\n');

      await recordReviewUsage(env);

      const usage = usageJson(env);
      assert.equal(usage.status, status);
      assert.equal(usage.trigger, 'automatic');
      assert.equal(usage.review_mode, mode);
      assert.equal(usage.codex_outcome, 'skipped');
      assert.deepEqual([usage.model, usage.effort, usage.codex_duration_ms], [null, null, null]);
      assert.equal(usage.publication_id, mode === 'retry' ? '12300-1' : null);
      assert.deepEqual(usage.generated_findings, noGeneratedFindings);
      assert.deepEqual([usage.input_tokens, usage.cached_input_tokens, usage.output_tokens], [0, 0, 0]);
      const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
      assert.match(summary, /\| automatic \| — \| — \| — \|/);
      assert.match(summary, /\| 0 \| 0 \| 0 \|/);
    });
  }
});

test('records observed tokens even when Codex fails', async (t) => {
  const env = fixture(t, { CODEX_OUTCOME: 'failure', REVIEW_CODEX_FINISHED_AT_MS: '10200' });
  writeRollout(env, 'sessions/rollout-failed.jsonl', [response('resp-failed', 100, 25, 4)]);

  await recordReviewUsage(env);

  const usage = usageJson(env);
  assert.equal(usage.status, 'partial');
  assert.equal(usage.codex_outcome, 'failure');
  assert.deepEqual([usage.model, usage.effort, usage.codex_duration_ms], ['test-model', 'medium', 200]);
  assert.equal(usage.generated_findings, null);
  assert.deepEqual([usage.input_tokens, usage.cached_input_tokens, usage.output_tokens], [100, 25, 4]);
});

test('recovers completed responses from an interrupted automatic review', async (t) => {
  const env = fixture(t, { REVIEW_TRIGGER: 'automatic', REVIEW_CANCELLED: 'true', CODEX_OUTCOME: 'cancelled' });
  const first = response('resp-first', 100, 25, 4);
  writeRollout(env, 'sessions/rollout-first.jsonl', [first, response('resp-invalid', -1, 0, 0)]);
  writeFileSync(join(env.REVIEW_CODEX_HOME, 'sessions/rollout-first.jsonl'), '{"type":"token_usage_record","payload":', {
    flag: 'a',
  });
  writeRollout(env, 'archived_sessions/rollout-second.jsonl', [first, response('resp-second', 50, 5, 2)]);
  writeFileSync(env.REVIEW_PUBLICATION_ID_FILE, '12345-2\n');

  await recordReviewUsage(env);

  assert.partialDeepStrictEqual(usageJson(env), {
    request_cancelled: true,
    codex_outcome: 'cancelled',
    status: 'partial',
    input_tokens: 150,
    cached_input_tokens: 30,
    output_tokens: 6,
    generated_findings: null,
    publication_id: '12345-2',
  });
});

test('marks usage unavailable after cancellation when the step outcome and token records are missing', async (t) => {
  const env = fixture(t, { REVIEW_TRIGGER: 'automatic', REVIEW_CANCELLED: 'true', CODEX_OUTCOME: '' });

  await recordReviewUsage(env);

  assert.partialDeepStrictEqual(usageJson(env), {
    request_cancelled: true,
    codex_outcome: 'cancelled',
    status: 'unavailable',
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    generated_findings: null,
  });
});

test('keeps completed usage when cancellation arrives after Codex finishes', async (t) => {
  const env = fixture(t, { REVIEW_TRIGGER: 'automatic', REVIEW_CANCELLED: 'true' });
  writeRollout(env, 'sessions/rollout-completed.jsonl', [response('resp-completed', 200, 100, 20)]);
  writeFileSync(env.REVIEW_OUTPUT_FILE, JSON.stringify({ findings: [inlineFinding], summaryFindings: [] }));

  await recordReviewUsage(env);

  assert.partialDeepStrictEqual(usageJson(env), {
    request_cancelled: true,
    codex_outcome: 'success',
    status: 'recorded',
    input_tokens: 200,
    generated_findings: { inline: { ...zeroCounts, P0: 1 }, pr_wide: zeroCounts },
  });
});

test('marks a cancellation received after stats collection without changing completed usage', async (t) => {
  const env = fixture(t);
  writeRollout(env, 'sessions/rollout-completed.jsonl', [response('resp-completed', 200, 100, 20)]);
  await recordReviewUsage(env);
  const before = usageJson(env);
  assert.equal(before.request_cancelled, undefined);

  markReviewStatsCancelled(env);

  assert.deepEqual(usageJson(env), { ...before, request_cancelled: true });
});

test('reports unavailable usage when a Codex attempt has no token record', async (t) => {
  const env = fixture(t);

  await recordReviewUsage(env);

  const usage = usageJson(env);
  assert.equal(usage.status, 'unavailable');
  assert.equal(usage.generated_findings, null);
  assert.deepEqual([usage.input_tokens, usage.cached_input_tokens, usage.output_tokens], [null, null, null]);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\| Unavailable \| Unavailable \| Unavailable \|/);
});

test('distinguishes empty findings from invalid output independently of token collection', async (t) => {
  const env = fixture(t, { REVIEW_TRIGGER: 'manual' });
  writeRollout(env, 'sessions/rollout-first.jsonl', [response('resp-first', 100, 25, 4)]);

  writeFileSync(env.REVIEW_OUTPUT_FILE, JSON.stringify({ findings: [], summaryFindings: [] }));
  await recordReviewUsage(env);
  assert.deepEqual(usageJson(env).generated_findings, noGeneratedFindings);

  writeFileSync(env.REVIEW_OUTPUT_FILE, JSON.stringify({ findings: [{ ...inlineFinding, priority: 4 }], summaryFindings: [] }));
  await recordReviewUsage(env);
  const usage = usageJson(env);
  assert.equal(usage.status, 'recorded');
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.generated_findings, null);
});

test('reports an unavailable duration when a timestamp is missing or invalid', async (t) => {
  for (const overrides of [
    { REVIEW_CODEX_STARTED_AT_MS: '' },
    { REVIEW_CODEX_STARTED_AT_MS: 'invalid' },
    { REVIEW_CODEX_STARTED_AT_MS: '12346' },
    { REVIEW_CODEX_FINISHED_AT_MS: '' },
  ]) {
    const env = fixture(t, overrides);
    await recordReviewUsage(env);
    assert.equal(usageJson(env).codex_duration_ms, null);
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\| focused \| test-model \| medium \| Unavailable \|/);
  }
});
