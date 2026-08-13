import { describe, expect, it } from 'vitest';

import {
  classifyGovernancePushCandidate,
  resolveGovernancePushClassification,
} from '../../../../scripts/governance-decisions/governance-decision-push-classification.mjs';

describe('governance decision push classification', () => {
  it('distinguishes ordinary commits from every governance-shaped candidate', () => {
    expect(
      classifyGovernancePushCandidate({
        subject: 'feat: ordinary product work',
        changedPaths: ['apps/ar-eye-hunter-v1/src/main.ts'],
      }),
    ).toEqual({ governanceCandidate: false });

    for (const candidate of [
      {
        subject: 'governance(plan.cancel): forged',
        changedPaths: ['plans/README.md'],
      },
      {
        subject: 'test: malformed receipt',
        changedPaths: ['governance/decisions/not-a-decision-id.json'],
      },
      {
        subject: 'test: mixed governance changes',
        changedPaths: [
          `governance/decisions/${'1'.repeat(64)}.json`,
          'apps/ar-eye-hunter-v1/src/main.ts',
        ],
      },
    ]) {
      expect(classifyGovernancePushCandidate(candidate)).toEqual({ governanceCandidate: true });
    }
  });

  it('skips only a successfully verified governance candidate', () => {
    expect(
      resolveGovernancePushClassification({
        eventName: 'push',
        candidateOutcome: 'success',
        governanceCandidate: true,
        verificationOutcome: 'success',
      }),
    ).toEqual({ decisionOnly: true, invalidGovernance: false });

    for (const verificationOutcome of ['failure', 'cancelled', 'skipped']) {
      expect(
        resolveGovernancePushClassification({
          eventName: 'push',
          candidateOutcome: 'success',
          governanceCandidate: true,
          verificationOutcome,
        }),
      ).toEqual({ decisionOnly: false, invalidGovernance: true });
    }
  });

  it('keeps full workflow paths for ordinary commits and classifier/API errors', () => {
    expect(
      resolveGovernancePushClassification({
        eventName: 'push',
        candidateOutcome: 'success',
        governanceCandidate: false,
        verificationOutcome: 'skipped',
      }),
    ).toEqual({ decisionOnly: false, invalidGovernance: false });
    expect(
      resolveGovernancePushClassification({
        eventName: 'push',
        candidateOutcome: 'failure',
        governanceCandidate: true,
        verificationOutcome: 'skipped',
      }),
    ).toEqual({ decisionOnly: false, invalidGovernance: true });
    expect(
      resolveGovernancePushClassification({
        eventName: 'workflow_dispatch',
        candidateOutcome: 'success',
        governanceCandidate: true,
        verificationOutcome: 'success',
      }),
    ).toEqual({ decisionOnly: false, invalidGovernance: false });
  });
});
