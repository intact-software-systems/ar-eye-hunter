export function candidate(input) {
  return input;
}

const maximumGitHubCandidateWarnings = 20;

export function deduplicateAndSort(candidates) {
  const byLocationAndReason = new Map(
    candidates.map((item) => [
      [item.path, item.line, item.symbol, item.reason, item.detail].join('\0'),
      item,
    ]),
  );
  return [...byLocationAndReason.values()].toSorted((left, right) =>
    [left.path, left.line, left.symbol, left.reason]
      .join('\0')
      .localeCompare([right.path, right.line, right.symbol, right.reason].join('\0')),
  );
}

export function printReport(result, { githubActions }) {
  console.log('Changed production legacy review');
  console.log(
    'INFO: this scan reports heuristic review facts; it does not approve retained legacy.',
  );
  console.log('INFO: review changed production call paths even when the heuristic scan is clean.');
  if (result.candidates.length === 0) {
    return console.log('PASS: no changed production legacy candidates');
  }
  console.log(`REVIEW: changed production legacy candidate(s): ${result.candidates.length}`);
  if (githubActions) {
    printGitHubWarnings(result.candidates);
  }
  for (const item of result.candidates) {
    console.log(
      `CANDIDATE ${toPlainReportValue(item.path)}:${item.line} | ` +
        `${toPlainReportValue(item.symbol)} | ${toPlainReportValue(item.reason)}`,
    );
  }
}

function printGitHubWarnings(candidates) {
  for (const item of candidates.slice(0, maximumGitHubCandidateWarnings)) {
    const properties = [
      `file=${escapeWorkflowCommandValue(item.path)}`,
      `line=${escapeWorkflowCommandValue(item.line)}`,
      'title=Changed production legacy heuristic candidate',
    ].join(',');
    const message = escapeWorkflowCommandValue(
      `${item.symbol} — ${item.reason}. ` +
        'Heuristic candidate; inspect the changed production call path.',
    );
    console.log(`::warning ${properties}::${message}`);
  }

  const overflow = candidates.length - maximumGitHubCandidateWarnings;
  if (overflow > 0) {
    const message = escapeWorkflowCommandValue(
      `${overflow} additional heuristic candidates were not annotated. ` +
        'Run npm run check:retained-legacy for the complete report.',
    );
    console.log(`::warning title=Changed production legacy heuristic candidates::${message}`);
  }
}

function escapeWorkflowCommandValue(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C');
}

function toPlainReportValue(value) {
  return String(value).replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}
