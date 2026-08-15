export function candidate(input) {
  return input;
}

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

export function printReport(result) {
  console.log('Changed production legacy review');
  console.log(
    'INFO: this scan reports heuristic review facts; it does not approve retained legacy.',
  );
  console.log('INFO: review changed production call paths even when the heuristic scan is clean.');
  if (result.candidates.length === 0) {
    return console.log('PASS: no changed production legacy candidates');
  }
  console.log(`REVIEW: changed production legacy candidate(s): ${result.candidates.length}`);
  for (const item of result.candidates) {
    console.log(`CANDIDATE ${item.path}:${item.line} | ${item.symbol} | ${item.reason}`);
  }
}
