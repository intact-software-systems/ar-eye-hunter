import path from 'node:path';

export const reviewedDispositions = Object.freeze([
  Object.freeze({
    path: 'scripts/perf/rtc-baseline/rtc-baseline-decoding.ts',
    rule: 'boundary.unknown',
    symbol: 'normalizeRtcBaselineJson',
  }),
  Object.freeze({
    path: 'scripts/perf/rtc-baseline',
    rule: 'layout.directory-density',
    symbol: 'rtc-baseline',
  }),
  Object.freeze({
    path: 'scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts',
    rule: 'layout.primary-export-name',
    symbol: 'parseRtcBaselineCommand',
  }),
]);

export function isReviewedDisposition(repoRoot, finding) {
  const findingPath = path.relative(repoRoot, finding.file).split(path.sep).join('/');
  return reviewedDispositions.some(
    (disposition) =>
      disposition.path === findingPath &&
      disposition.rule === finding.ruleId &&
      disposition.symbol === finding.symbol,
  );
}
