import path from 'node:path';

export const reviewedDispositions = Object.freeze([
  // erasableSyntaxOnly migration: converting parameter properties to explicit
  // fields duplicates each `unknown`-typed parameter annotation into a field
  // declaration (+1 textual occurrence per file, no new unknown values). These
  // four module-owner entries accept exactly that; remove them when the
  // affected classes gain precise persisted-value types or the boundary rule
  // moves to the metric-based checker.
  Object.freeze({
    path: 'packages/shared-web/browser/rallar-data.ts',
    rule: 'boundary.unknown',
    symbol: undefined,
  }),
  Object.freeze({
    path: 'packages/shared/alm/ALInboundAdmissionStore.ts',
    rule: 'boundary.unknown',
    symbol: undefined,
  }),
  Object.freeze({
    path: 'packages/shared/alm/ALOutboundAdmissionStore.ts',
    rule: 'boundary.unknown',
    symbol: undefined,
  }),
  Object.freeze({
    path: 'packages/shared/rallar-ai/rallar-ai-types.ts',
    rule: 'boundary.unknown',
    symbol: undefined,
  }),
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
