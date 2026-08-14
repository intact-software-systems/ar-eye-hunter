import { describe, expect, it } from 'vitest';

import { validateBranchReleaseConclusion } from '../../../../scripts/validation-evidence/branch-release-result.mjs';

describe('Branch Release Gate governance eligibility', () => {
  it.each([
    ['passed', 'passed', ''],
    ['accepted-deviation', 'failed', 'd'.repeat(64)],
  ])('accepts exact %s governance resolution', (governanceStatus, underlyingStatus, decisionId) => {
    expect(
      validateBranchReleaseConclusion({
        ...successfulConclusion(),
        governanceStatus,
        governanceUnderlyingStatus: underlyingStatus,
        governanceDecisionId: decisionId,
      }),
    ).toEqual([]);
  });

  it.each([
    ['failed', 'failed', ''],
    ['accepted-deviation', 'passed', 'd'.repeat(64)],
    ['accepted-deviation', 'failed', ''],
    ['passed', 'failed', ''],
  ])('rejects ambiguous governance resolution %s/%s', (status, underlying, decisionId) => {
    expect(
      validateBranchReleaseConclusion({
        ...successfulConclusion(),
        governanceStatus: status,
        governanceUnderlyingStatus: underlying,
        governanceDecisionId: decisionId,
      }),
    ).toContain('Governance Gate resolution is not merge eligible');
  });
});

function successfulConclusion() {
  return {
    governanceResult: 'success',
    governanceStatus: 'passed',
    governanceUnderlyingStatus: 'passed',
    governanceDecisionId: '',
    selectionResult: 'success',
    reuse: 'false',
    releaseResult: 'success',
    publicationResult: 'success',
  };
}
