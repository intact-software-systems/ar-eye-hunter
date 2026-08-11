import { createHash } from 'node:crypto';

export function candidate(input) {
  const identity = JSON.stringify({
    kind: input.kind,
    path: input.path,
    line: input.line,
    symbol: input.symbol,
    detail: input.detail,
  });
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return { id: `production-legacy-candidate-${hash}`, ...input };
}

export function deduplicateAndSort(candidates) {
  const byId = new Map(candidates.map((item) => [item.id, item]));
  return [...byId.values()].toSorted((left, right) =>
    [left.path, left.line, left.reason, left.id]
      .join('\0')
      .localeCompare([right.path, right.line, right.reason, right.id].join('\0')),
  );
}

export function toCanonicalReport(input) {
  return {
    version: 1,
    mergeBase: input.mergeBase,
    head: input.head,
    candidateCount: input.candidates.length,
    candidates: input.candidates.map((item) => ({
      id: item.id,
      kind: item.kind,
      path: item.path,
      line: item.line,
      symbol: item.symbol,
      reason: item.reason,
      detail: item.detail,
    })),
  };
}

export function toCanonicalReportText(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function computeReportSha256(reportText) {
  return createHash('sha256').update(reportText).digest('hex');
}

export function printReport(result) {
  console.log(`Legacy candidate review: ${result.mergeBase} -> ${result.head}`);
  console.log(
    'WARN: legacy candidate review is heuristic evidence. ' +
      'It does not approve retained legacy or judge legitimacy.',
  );
  console.log(
    'WARN: a clean scan does not prove the absence of production legacy; ' +
      'final review traces changed production call paths.',
  );
  if (result.exempt)
    return console.log('PASS: explicit PR-review exemption skips legacy candidate scanning');
  console.log(`REPORT-SHA256: ${result.reportSha256}`);
  if (result.candidates.length === 0)
    return console.log('PASS: no changed production legacy candidates');
  console.log(
    `WARN: ${result.candidates.length} changed production legacy candidate(s) ` +
      'require human disposition:',
  );
  for (const item of result.candidates)
    console.log(
      `CANDIDATE ${item.id} | ${item.path}:${item.line} | ${item.symbol} | ${item.reason}`,
    );
  console.log(
    'WARN: copy every candidate into the final PR Human Review Record v1 ledger ' +
      'with exactly one disposition.',
  );
}
