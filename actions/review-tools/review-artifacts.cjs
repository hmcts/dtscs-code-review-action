const findingsArtifactPrefix = 'codex-review-findings-';

function findingsArtifactName(reviewKey) {
  return findingsArtifactPrefix + reviewKey;
}

function isAvailableFindingsArtifact({ name, expired }) {
  return !expired && name.startsWith(findingsArtifactPrefix);
}

function publicationReceiptPrefix(artifactId) {
  return `codex-review-publication-${artifactId}-`;
}

function publicationReceiptName(artifactId, runAttempt, { status, confirmedAt }) {
  return `${publicationReceiptPrefix(artifactId)}${runAttempt}-${status}-${confirmedAt ?? 0}`;
}

function readPublicationOutcome(receipts, artifactId) {
  const prefix = publicationReceiptPrefix(artifactId);
  let confirmedAt = Infinity;
  let status;
  for (const { name, expired } of receipts) {
    if (expired || !name.startsWith(prefix)) continue;
    const [, outcome, timestamp] = /^\d+-(covered|invalid)-(\d+)$/.exec(name.slice(prefix.length)) ?? [];
    if (outcome === 'covered' && Number(timestamp) > 0) confirmedAt = Math.min(confirmedAt, Number(timestamp));
    if (outcome === 'invalid') status = outcome;
  }

  // Keep the first confirmation even if a publisher-only rerun adds a receipt.
  return Number.isFinite(confirmedAt) ? { status: 'covered', confirmedAt } : { status };
}

module.exports = { findingsArtifactName, isAvailableFindingsArtifact, publicationReceiptName, readPublicationOutcome };
