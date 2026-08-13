import path from 'node:path';

import {
  readOriginMainGovernanceDecisionIndex,
  resolveGovernanceExceptionDecisions,
} from '../governance-decisions/governance-decision-receipt-index.mjs';
import { findingMagnitude } from './finding-magnitude.mjs';

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
    path: 'packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts',
    rule: 'boundary.unknown',
    symbol: 'normalizeRtcBaselineJson',
  }),
  Object.freeze({
    path: 'packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts',
    rule: 'layout.primary-export-name',
    symbol: 'parseRtcBaselineCommand',
  }),
]);

export function readReviewedDispositionContext(repoRoot, candidateHead, dependencies = {}) {
  const index =
    dependencies.readGovernanceDecisionIndex?.(repoRoot) ??
    readOriginMainGovernanceDecisionIndex(repoRoot);
  const resolved = resolveGovernanceExceptionDecisions(index, {
    exceptionKind: 'repository-code-style',
    candidateHead,
  });
  const decisions = resolved.filter(isCodeStyleDecision);
  const malformed = resolved.length - decisions.length;
  return {
    candidateHead,
    decisions,
    issues: [
      ...index.issues,
      ...(malformed === 0
        ? []
        : ['governance exception resolver returned malformed repository code style evidence']),
    ],
  };
}

export function isReviewedDisposition(repoRoot, finding, context = {}) {
  const findingPath = path.relative(repoRoot, finding.file).split(path.sep).join('/');
  const staticallyReviewed = reviewedDispositions.some(
    (disposition) =>
      disposition.path === findingPath &&
      disposition.rule === finding.ruleId &&
      disposition.symbol === finding.symbol,
  );
  if (staticallyReviewed) {
    return true;
  }
  if (!Array.isArray(context.decisions) || typeof context.candidateHead !== 'string') {
    return false;
  }
  return context.decisions.some(
    (decision) =>
      decision?.projection?.path === findingPath &&
      decision.projection.rule === finding.ruleId &&
      (decision.projection.symbol ?? undefined) === finding.symbol &&
      decision.projection.magnitude === findingMagnitude(finding) &&
      decision.projection.candidateHead === context.candidateHead,
  );
}

function isCodeStyleDecision(decision) {
  const projection = decision?.projection;
  return (
    projection !== null &&
    typeof projection === 'object' &&
    !Array.isArray(projection) &&
    typeof projection.rule === 'string' &&
    typeof projection.path === 'string' &&
    (projection.symbol === null || typeof projection.symbol === 'string') &&
    Number.isSafeInteger(projection.magnitude) &&
    typeof projection.candidateHead === 'string'
  );
}
