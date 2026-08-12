import { describe, expect, it, vi } from 'vitest';

import { createRtcBaselineEvidenceAcceptance } from '../../../baseline/acceptance/rtc-baseline-evidence-acceptance.ts';
import type { RtcBaselineRuntimeObservationDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';

const firstIdentity = {
  sampleId: 'rtc-b01-case-input-retained-001-001',
  workloadId: 'RTC-B01' as const,
  caseId: 'case',
  inputKey: 'input',
  intendedPhase: 'retained' as const,
  outerOrdinal: 1,
  innerOrdinal: 1,
};
const identities = [
  firstIdentity,
  { ...firstIdentity, sampleId: 'rtc-b01-case-input-retained-001-002', innerOrdinal: 2 },
  { ...firstIdentity, sampleId: 'rtc-b01-case-input-retained-002-001', outerOrdinal: 2 },
];
const baselineId = '20260807-0123456789ab-e1-local';
const request = {
  schema: 'rallar.rtc-baseline.capture-request.v1' as const,
  baselineId,
  workloadIds: ['RTC-B01'] as const,
  environmentId: 'E1-local' as const,
  retainedSampleMultiplier: 1 as const,
  repeatLink: null,
  conditionalEnvironmentDecisions: [],
};
const manifest = {
  schema: 'rallar.rtc-baseline.manifest.v1' as const,
  request,
  workloadIds: ['RTC-B01'] as const,
  cases: [],
  outerAttempts: [
    {
      workloadId: 'RTC-B01' as const,
      caseId: 'case',
      inputKey: 'input',
      environmentId: 'E1-local' as const,
      intendedPhase: 'retained' as const,
      outerOrdinal: 1,
      sampleIds: [identities[0]!.sampleId],
    },
  ],
  expectedCohorts: [],
  repeatLink: null,
};
const externalManifest = {
  ...manifest,
  request: { ...request, workloadIds: ['RTC-B05', 'RTC-B06'] as const },
  workloadIds: ['RTC-B05', 'RTC-B06'] as const,
  outerAttempts: [
    {
      ...manifest.outerAttempts[0],
      workloadId: 'RTC-B05' as const,
      caseId: 'browser-data-channel-lifecycle',
      inputKey: 'iterations-25',
      environmentId: 'E2-browser' as const,
      sampleIds: ['browser-sample'],
    },
    {
      ...manifest.outerAttempts[0],
      workloadId: 'RTC-B06' as const,
      caseId: 'default',
      inputKey: 'e3-memory-default',
      environmentId: 'E3-memory' as const,
      sampleIds: ['external-sample'],
    },
  ],
  expectedCohorts: [
    { cohortId: 'cohort', workloadId: 'RTC-B06' as const, memberSampleIds: ['external-sample'] },
  ],
};
const browserOwner = {
  sampleId: 'browser-sample',
  workloadId: 'RTC-B05',
  caseId: 'browser-data-channel-lifecycle',
  inputKey: 'iterations-25',
  intendedPhase: 'retained',
  outerOrdinal: 1,
  innerOrdinal: 1,
} as const;
const externalOwner = {
  sampleId: 'external-sample',
  workloadId: 'RTC-B06',
  caseId: 'default',
  inputKey: 'e3-memory-default',
  intendedPhase: 'retained',
  outerOrdinal: 1,
  innerOrdinal: 1,
} as const;
const cohortOwner = {
  cohortId: 'cohort',
  workloadId: 'RTC-B06',
  memberSampleIds: ['external-sample'],
} as const;
const causalIssue = {
  path: '$',
  code: 'causal-not-run',
  message: 'Not run after the first workload correctness failure.',
};
const malformedIssue = {
  path: '$.raw-result',
  code: 'invalid-json',
  message: 'Malformed staged JSON.',
};
const reconciliationIssue = { path: '$.git', code: 'git-mismatch', message: 'changed' };
const invalidWorkerIssue = {
  path: '$.worker.outcomes[1]',
  code: 'invalid-worker-outcome',
  message: 'Worker outcome does not match the expected inner identity.',
};
function workerSample(identity: (typeof identities)[number], evidenceClass = 'synthetic-path') {
  return {
    schema: 'rallar.rtc-baseline.sample.v1',
    identity,
    outcome: 'passed',
    evidenceClass,
    metrics: [],
    rawEvidence: { durationMs: 1 },
    rawReferences: [],
    issues: [],
    runtimeObservation: null,
  };
}
function acceptance(overrides: Record<string, unknown>) {
  return createRtcBaselineEvidenceAcceptance({
    initializeStore: async () => ({ ok: true as const, value: undefined }),
    readManifest: async () => ({ ok: true as const, value: manifest }),
    writeAcceptedArtifact: async () => ({ ok: true as const, value: undefined }),
    readStagedJson: async () => ({ ok: true as const, value: {} }),
    runFreshWorker: async () => ({ outcomes: [] }),
    reconcileAcceptedOperation: async () => [],
    ...overrides,
  });
}
function recordingAcceptance(overrides: Record<string, unknown>) {
  const writes: unknown[] = [];
  const service = acceptance({
    ...overrides,
    writeAcceptedArtifact: async (_baselineId: string, artifact: unknown) => {
      writes.push(artifact);
      return { ok: true, value: undefined };
    },
  });
  return { service, writes };
}
const browserInput = {
  baselineId,
  locator: {
    workloadId: 'RTC-B05' as const,
    caseId: 'browser-data-channel-lifecycle',
    inputKey: 'iterations-25',
    intendedPhase: 'retained' as const,
    outerOrdinal: 1,
  },
  producerExitStatus: 0,
  rawResultRelativePath: 'artifacts/staging/browser.json',
};
const externalInput = {
  ...browserInput,
  locator: {
    ...browserInput.locator,
    workloadId: 'RTC-B06' as const,
    caseId: 'default',
    inputKey: 'e3-memory-default',
  },
};
const cohortInput = {
  baselineId,
  workloadId: 'RTC-B06' as const,
  cohortId: 'cohort',
  producerExitStatus: 0,
  rawResultRelativePath: 'artifacts/staging/cohort.json',
};
async function invokeOwnedOperation(
  service: ReturnType<typeof createRtcBaselineEvidenceAcceptance>,
  kind: 'capture' | 'browser' | 'external' | 'cohort',
) {
  if (kind === 'capture') return service.captureWorkload({ baselineId, workloadId: 'RTC-B01' });
  if (kind === 'browser') return service.recordBrowser(browserInput);
  if (kind === 'external') return service.recordExternalAttempt(externalInput);
  return service.recordExternalCohortAssertion(cohortInput);
}
function persistedRows(writes: readonly unknown[]) {
  return writes.map((value) => {
    const artifact = value as Record<string, unknown>;
    return [
      artifact.artifactKind,
      artifact.failureId,
      artifact.identity,
      artifact.outcome,
      artifact.causalFailureId,
      artifact.issues,
      artifact.rawEvidence,
    ];
  });
}
function manifestForOperation(kind: 'capture' | 'browser' | 'external' | 'cohort') {
  if (kind === 'capture') return manifest;
  if (kind === 'browser')
    return { ...externalManifest, outerAttempts: externalManifest.outerAttempts.slice(0, 1) };
  if (kind === 'external')
    return { ...externalManifest, outerAttempts: externalManifest.outerAttempts.slice(1) };
  return { ...externalManifest, outerAttempts: [] };
}

describe('RTC baseline failure accounting', () => {
  it('rejects surplus worker outcomes before accepting any inner result', async () => {
    const issue = {
      path: '$.worker.outcomes',
      code: 'worker-outcome-cardinality',
      message: 'Worker returned 2 outcomes for 1 expected inner samples.',
    };
    const { service, writes } = recordingAcceptance({
      runFreshWorker: async () => ({
        outcomes: [
          { identity: identities[0], outcome: 'passed', issues: [], rawEvidence: {} },
          { identity: identities[1], outcome: 'passed', issues: [], rawEvidence: {} },
        ],
      }),
    });
    expect(await service.captureWorkload({ baselineId, workloadId: 'RTC-B01' })).toEqual({
      ok: false,
      issues: [issue],
    });
    expect(persistedRows(writes)).toEqual([
      [
        'failure',
        'failure-sample-rtc-b01-case-input-retained-001-001',
        identities[0],
        'failed',
        null,
        [issue],
        null,
      ],
    ]);
  });
  it('normalizes a thrown child and persists the exact current-outer remainder', async () => {
    const { service, writes } = recordingAcceptance({
      readManifest: async () => ({
        ok: true,
        value: {
          ...manifest,
          outerAttempts: [
            {
              ...manifest.outerAttempts[0],
              sampleIds: [identities[0]!.sampleId, identities[1]!.sampleId],
            },
          ],
        },
      }),
      runFreshWorker: async () => {
        throw new Error('child crashed');
      },
    });
    expect(await service.captureWorkload({ baselineId, workloadId: 'RTC-B01' })).toEqual({
      ok: false,
      issues: [{ path: '$.worker', code: 'worker-threw', message: 'child crashed' }],
    });
    expect(persistedRows(writes)).toEqual([
      [
        'failure',
        'failure-sample-rtc-b01-case-input-retained-001-001',
        identities[0],
        'failed',
        null,
        [{ path: '$.worker', code: 'worker-threw', message: 'child crashed' }],
        null,
      ],
      [
        'not-run',
        'failure-sample-rtc-b01-case-input-retained-001-001',
        identities[1],
        'not-run',
        'failure-sample-rtc-b01-case-input-retained-001-001',
        [causalIssue],
        null,
      ],
    ]);
  });
  it('persists a valid prefix, invalid worker failure, and complete later-outer remainder', async () => {
    const { service, writes } = recordingAcceptance({
      readManifest: async () => ({
        ok: true,
        value: {
          ...manifest,
          outerAttempts: [
            {
              ...manifest.outerAttempts[0],
              sampleIds: [identities[0]!.sampleId, identities[1]!.sampleId],
            },
            { ...manifest.outerAttempts[0], outerOrdinal: 2, sampleIds: [identities[2]!.sampleId] },
          ],
        },
      }),
      runFreshWorker: async () => ({
        outcomes: [workerSample(identities[0]!), workerSample(identities[1]!, 'native-browser')],
      }),
    });
    expect(await service.captureWorkload({ baselineId, workloadId: 'RTC-B01' })).toEqual({
      ok: false,
      issues: [invalidWorkerIssue],
    });
    expect(persistedRows(writes)).toEqual([
      [undefined, undefined, identities[0], 'passed', undefined, [], { durationMs: 1 }],
      [
        'failure',
        'failure-sample-rtc-b01-case-input-retained-001-002',
        identities[1],
        'failed',
        null,
        [invalidWorkerIssue],
        workerSample(identities[1]!, 'native-browser'),
      ],
      [
        'not-run',
        'failure-sample-rtc-b01-case-input-retained-001-002',
        identities[2],
        'not-run',
        'failure-sample-rtc-b01-case-input-retained-001-002',
        [causalIssue],
        null,
      ],
    ]);
  });

  it.each([
    ['browser', 'failure-sample-browser-sample', browserOwner, null],
    ['external', 'failure-sample-external-sample', externalOwner, null],
    ['cohort', 'failure-cohort-cohort', cohortOwner, null],
  ] as const)(
    'persists malformed staged %s JSON against its exact owner',
    async (kind, failureId, identity, remainder) => {
      const { service, writes } = recordingAcceptance({
        readManifest: async () => ({
          ok: true,
          value: kind === 'browser' ? externalManifest : manifestForOperation(kind),
        }),
        readStagedJson: async () => ({ ok: false, issues: [malformedIssue] }),
      });
      expect(await invokeOwnedOperation(service, kind)).toEqual({
        ok: false,
        issues: [malformedIssue],
      });
      const rows = persistedRows(writes);
      expect(rows[0]).toEqual([
        'failure',
        failureId,
        identity,
        'failed',
        null,
        [malformedIssue],
        null,
      ]);
      expect(rows.slice(1)).toEqual(remainder ? [remainder] : []);
    },
  );

  it.each([
    ['capture', 'failure-sample-rtc-b01-case-input-retained-001-001', identities[0]],
    ['browser', 'failure-sample-browser-sample', browserOwner],
    ['external', 'failure-sample-external-sample', externalOwner],
    ['cohort', 'failure-cohort-cohort', cohortOwner],
  ] as const)('persists the exact %s reconciliation owner', async (kind, failureId, identity) => {
    const { service, writes } = recordingAcceptance({
      readManifest: async () => ({ ok: true, value: manifestForOperation(kind) }),
      reconcileAcceptedOperation: async () => [reconciliationIssue],
    });
    expect(await invokeOwnedOperation(service, kind)).toEqual({
      ok: false,
      issues: [reconciliationIssue],
    });
    expect(persistedRows(writes)).toEqual([
      ['failure', failureId, identity, 'failed', null, [reconciliationIssue], null],
    ]);
  });

  it('rejects initialization reconciliation before store mutation', async () => {
    const initializeStore = vi.fn();
    const service = acceptance({
      initializeStore,
      reconcileAcceptedOperation: async () => [reconciliationIssue],
    });
    expect(
      await service.initializeBaseline({
        request,
        runtimeObservation: {} as RtcBaselineRuntimeObservationDto,
      }),
    ).toEqual({
      ok: false,
      issues: [reconciliationIssue],
    });
    expect(initializeStore).not.toHaveBeenCalled();
  });
});
