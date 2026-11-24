const { readFileSync } = require('node:fs');

function isLineNumber(line) {
  return Number.isSafeInteger(line) && line > 0;
}

function hasFindingText(finding) {
  return (
    finding &&
    [0, 1, 2, 3].includes(finding.priority) &&
    typeof finding.title === 'string' &&
    finding.title.trim() &&
    [...finding.title].length <= 80 &&
    typeof finding.body === 'string' &&
    finding.body.trim() &&
    [...finding.body].length <= 2000
  );
}

function isCodeLocation(location) {
  return (
    location &&
    typeof location.path === 'string' &&
    location.path.isWellFormed() &&
    !/[\\\x00-\x1f\x7f]/.test(location.path) &&
    location.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
    isLineNumber(location.line) &&
    ['head', 'merge_base'].includes(location.revision)
  );
}

function parseFindings(output) {
  if (!output) throw new Error('Codex did not return review JSON.');
  const { findings, summaryFindings } = JSON.parse(output) ?? {};
  if (!Array.isArray(findings) || !Array.isArray(summaryFindings)) {
    throw new Error('Expected arrays of inline and PR-wide review findings.');
  }

  for (const finding of findings) {
    if (
      !hasFindingText(finding) ||
      typeof finding.path !== 'string' ||
      !['LEFT', 'RIGHT'].includes(finding.side) ||
      !isLineNumber(finding.line)
    ) {
      throw new Error('Codex returned a finding that does not match the review schema.');
    }
  }
  for (const finding of summaryFindings) {
    if (
      !hasFindingText(finding) ||
      !Array.isArray(finding.locations) ||
      !finding.locations.length ||
      !finding.locations.every(isCodeLocation)
    ) {
      throw new Error('Codex returned a PR-wide finding that does not match the review schema.');
    }
  }

  return { findings, summaryFindings };
}

function readPublicationId(file) {
  const id = readFileSync(file, 'utf8').trim();
  return /^\d+-\d+$/.test(id) ? id : null;
}

function countPriorities(priorities) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const priority of priorities) counts[`P${priority}`]++;
  return counts;
}

function countFindings(inline = [], prWide = []) {
  return { inline: countPriorities(inline), pr_wide: countPriorities(prWide) };
}

module.exports = { parseFindings, readPublicationId, countFindings };
