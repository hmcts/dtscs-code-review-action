const { appendFileSync, createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const { parseFindings, readPublicationId, countFindings } = require('./review-findings.cjs');

const emptyCounts = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
const tokenFields = Object.keys(emptyCounts);
const skippedStatuses = new Map([
  ['covered', 'reused'],
  ['retry', 'retried'],
  ['stale', 'stale'],
]);
const statusLabels = {
  recorded: 'Tokens recorded from Codex responses.',
  partial: 'Tokens recorded before Codex stopped.',
  unavailable: 'Token usage is unavailable for this Codex attempt.',
  reused: 'Reused an existing review.',
  retried: 'Retried publication from existing findings.',
  stale: 'Skipped a stale review request before calling Codex.',
  not_run: 'Codex did not run.',
};

async function readTokenCounts(codexHome, interrupted) {
  const counts = { ...emptyCounts };
  const responses = new Set();

  for (const directory of ['sessions', 'archived_sessions']) {
    const path = join(codexHome, directory);
    if (!existsSync(path)) continue;

    for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      const input = createReadStream(join(entry.parentPath, entry.name));
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (!line.includes('"token_usage_record"')) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          if (interrupted && error instanceof SyntaxError) continue;
          throw error;
        }
        if (record?.type !== 'token_usage_record') continue;

        // Count each response ID once, including records copied across threads.
        const { response_id: responseId, usage } = record.payload ?? {};
        if (
          typeof responseId !== 'string' ||
          !responseId ||
          !tokenFields.every((field) => Number.isSafeInteger(usage?.[field]) && usage[field] >= 0)
        ) {
          if (interrupted) continue;
          throw new Error('Invalid Codex token usage record.');
        }
        if (responses.has(responseId)) continue;

        responses.add(responseId);
        for (const field of tokenFields) counts[field] += usage[field];
      }
    }
  }

  return responses.size > 0 ? counts : null;
}

function readGeneratedCounts(file) {
  try {
    const { findings, summaryFindings } = parseFindings(readFileSync(file, 'utf8'));
    return countFindings(
      findings.map(({ priority }) => priority),
      summaryFindings.map(({ priority }) => priority)
    );
  } catch {
    return null;
  }
}

function readUsagePublicationId(file) {
  try {
    return readPublicationId(file);
  } catch {
    return null;
  }
}

async function recordReviewUsage(env = process.env) {
  const finishedAt = Number(env.REVIEW_CODEX_FINISHED_AT_MS);
  const startedAt = Number(env.REVIEW_CODEX_STARTED_AT_MS);
  const cancelled = env.REVIEW_CANCELLED === 'true';
  const codexOutcome = env.CODEX_OUTCOME || (cancelled && startedAt > 0 ? 'cancelled' : 'skipped');
  const interrupted = codexOutcome === 'cancelled' || (cancelled && codexOutcome !== 'success');
  let status = skippedStatuses.get(env.REVIEW_MODE) ?? 'not_run';
  let counts = emptyCounts;
  let generatedFindings = countFindings();
  const codexRan = codexOutcome !== 'skipped';

  if (codexRan) {
    generatedFindings = codexOutcome === 'success' ? readGeneratedCounts(env.REVIEW_OUTPUT_FILE) : null;
    try {
      counts = await readTokenCounts(env.REVIEW_CODEX_HOME, interrupted);
    } catch {
      // Keep the review outcome independent of telemetry and leave log contents on the runner.
      counts = null;
    }
    if (counts) {
      status = codexOutcome === 'success' ? 'recorded' : 'partial';
    } else {
      status = 'unavailable';
      counts = { input_tokens: null, cached_input_tokens: null, output_tokens: null };
    }
  }

  const publicationId = codexRan || env.REVIEW_MODE === 'retry' ? readUsagePublicationId(env.REVIEW_PUBLICATION_ID_FILE) : null;
  const validTiming =
    Number.isSafeInteger(startedAt) && Number.isSafeInteger(finishedAt) && startedAt > 0 && startedAt <= finishedAt;
  const usage = {
    pr_number: Number(env.REVIEW_PR_NUMBER),
    head_sha: env.HEAD_SHA,
    merge_base_sha: env.MERGE_BASE_SHA,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    trigger: env.REVIEW_TRIGGER,
    review_mode: env.REVIEW_MODE || 'not_run',
    codex_outcome: codexOutcome,
    ...(cancelled ? { request_cancelled: true } : {}),
    model: codexRan ? (env.REVIEW_CODEX_MODEL ?? null) : null,
    effort: codexRan ? (env.REVIEW_CODEX_EFFORT ?? null) : null,
    codex_duration_ms: codexRan && validTiming ? finishedAt - startedAt : null,
    publication_id: publicationId,
    generated_findings: generatedFindings,
    status,
    ...counts,
  };
  writeFileSync(join(env.RUNNER_TEMP, 'review-stats.json'), JSON.stringify(usage, null, 2) + '\n');

  const missingDetail = codexRan ? 'Unavailable' : '—';
  const duration =
    usage.codex_duration_ms === null
      ? missingDetail
      : `${(usage.codex_duration_ms / 1000).toLocaleString('en-GB', { maximumFractionDigits: 3 })} s`;
  const tokenRow = tokenFields.map((field) => counts[field]?.toLocaleString('en-GB') ?? 'Unavailable').join(' | ');
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    [
      '## Codex review',
      '',
      statusLabels[status],
      '',
      '| Trigger | Model | Effort | Codex duration |',
      '| --- | --- | --- | ---: |',
      `| ${usage.trigger ?? 'Unavailable'} | ${usage.model ?? missingDetail} | ${usage.effort ?? missingDetail} | ${duration} |`,
      '',
      '| Input tokens | Cached input tokens | Output tokens |',
      '| ---: | ---: | ---: |',
      `| ${tokenRow} |`,
      '',
      'Cached input is included in input tokens.',
      '',
    ].join('\n')
  );
}

function markReviewStatsCancelled(env = process.env) {
  const path = join(env.RUNNER_TEMP, 'review-stats.json');
  const usage = JSON.parse(readFileSync(path, 'utf8'));
  usage.request_cancelled = true;
  writeFileSync(path, JSON.stringify(usage, null, 2) + '\n');
}

if (require.main === module) {
  recordReviewUsage().catch(() => {
    console.error('Could not write the Codex review stats.');
    process.exitCode = 1;
  });
}

module.exports = recordReviewUsage;
module.exports.markReviewStatsCancelled = markReviewStatsCancelled;
