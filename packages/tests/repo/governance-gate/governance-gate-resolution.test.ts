import { describe, expect, it } from 'vitest';

import { resolveGovernanceGateStatus } from '../../../../scripts/governance-gate/governance-gate-resolution.mjs';

const candidateSha = 'a'.repeat(40);
const decisionId = 'd'.repeat(64);

describe('governance gate resolution', () => {
  it('preserves an ordinary passed gate without consulting deviations', () => {
    expect(
      resolveGovernanceGateStatus({
        localStatus: 'passed',
        candidateSha,
        currentRunId: 81,
        currentRunAttempt: 2,
        gateName: 'Governance Gate / Governance Gate',
        deviations: 'not-read',
      }),
    ).toEqual({ status: 'passed', underlyingStatus: 'passed', decisionId: '' });
  });

  it('accepts one exact verified prior failed attempt while retaining failure', () => {
    expect(
      resolveGovernanceGateStatus({
        localStatus: 'failed',
        candidateSha,
        currentRunId: 81,
        currentRunAttempt: 3,
        gateName: 'Governance Gate / Governance Gate',
        deviations: [deviation()],
      }),
    ).toEqual({ status: 'accepted-deviation', underlyingStatus: 'failed', decisionId });
  });

  it.each([
    ['same attempt', { runAttempt: 3 }],
    ['different run', { workflowRunId: 82 }],
    ['different gate', { gateName: 'Release Gate' }],
    ['different candidate', { candidateSha: 'b'.repeat(40) }],
    ['wrong status', { status: 'passed' }],
    ['wrong underlying status', { underlyingStatus: 'cancelled' }],
  ])('keeps a failed gate ineligible for %s receipt evidence', (_label, patch) => {
    expect(() =>
      resolveGovernanceGateStatus({
        localStatus: 'failed',
        candidateSha,
        currentRunId: 81,
        currentRunAttempt: 3,
        gateName: 'Governance Gate / Governance Gate',
        deviations: [{ ...deviation(), ...patch }],
      }),
    ).toThrow('failed governance gate has no exact accepted deviation');
  });

  it('fails closed for absent, malformed, or ambiguous receipt evidence', () => {
    for (const deviations of [
      [],
      null,
      [deviation(), { ...deviation(), decisionId: 'e'.repeat(64) }],
    ]) {
      expect(() =>
        resolveGovernanceGateStatus({
          localStatus: 'failed',
          candidateSha,
          currentRunId: 81,
          currentRunAttempt: 3,
          gateName: 'Governance Gate / Governance Gate',
          deviations,
        }),
      ).toThrow();
    }
  });
});

function deviation() {
  return {
    decisionId,
    workflowRunId: 81,
    runAttempt: 2,
    gateName: 'Governance Gate / Governance Gate',
    candidateSha,
    status: 'accepted-deviation',
    underlyingStatus: 'failed',
  };
}
