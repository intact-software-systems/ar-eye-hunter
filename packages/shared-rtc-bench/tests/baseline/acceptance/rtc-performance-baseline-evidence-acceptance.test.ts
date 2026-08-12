import { describe, expect, it, vi } from 'vitest';

import { createRtcBaselineEvidenceAcceptance } from '../../../baseline/acceptance/rtc-baseline-evidence-acceptance.ts';
import type { RtcBaselineSampleIdentityDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';

const firstIdentity = {
  sampleId: 'rtc-b01-case-input-retained-001-001',
  workloadId: 'RTC-B01',
  caseId: 'case',
  inputKey: 'input',
  intendedPhase: 'retained',
  outerOrdinal: 1,
  innerOrdinal: 1,
} as const;
const secondIdentity = {
  ...firstIdentity,
  sampleId: 'rtc-b01-case-input-retained-001-002',
  innerOrdinal: 2,
} as const;
function passedSample(
  identity: RtcBaselineSampleIdentityDto,
  evidenceClass: 'synthetic-path' | 'native-browser' | 'local-full-stack' = 'synthetic-path',
) {
  return {
    schema: 'rallar.rtc-baseline.sample.v1' as const,
    identity,
    outcome: 'passed' as const,
    evidenceClass,
    metrics: [{ metric: 'durationMs', unit: 'ms', value: 1 }],
    rawEvidence: { durationMs: 1 },
    rawReferences: [],
    issues: [],
    runtimeObservation: null,
  };
}
const passedFirst = passedSample(firstIdentity);
const passedSecond = passedSample(secondIdentity);
const thirdIdentity = {
  ...firstIdentity,
  sampleId: 'rtc-b01-case-input-retained-002-001',
  outerOrdinal: 2,
} as const;
const passedThird = passedSample(thirdIdentity);
const attempt = {
  workloadId: 'RTC-B01' as const,
  caseId: 'case',
  inputKey: 'input',
  environmentId: 'E1-local' as const,
  intendedPhase: 'retained' as const,
  outerOrdinal: 1,
  sampleIds: ['rtc-b01-case-input-retained-001-001', 'rtc-b01-case-input-retained-001-002'],
};
const secondAttempt = {
  ...attempt,
  outerOrdinal: 2,
  sampleIds: ['rtc-b01-case-input-retained-002-001'],
};
const manifest = {
  schema: 'rallar.rtc-baseline.manifest.v1' as const,
  request: {
    schema: 'rallar.rtc-baseline.capture-request.v1' as const,
    baselineId: '20260807-0123456789ab-e1-local',
    workloadIds: ['RTC-B01'] as const,
    environmentId: 'E1-local' as const,
    retainedSampleMultiplier: 1 as const,
    repeatLink: null,
    conditionalEnvironmentDecisions: [],
  },
  workloadIds: ['RTC-B01'] as const,
  cases: [],
  outerAttempts: [attempt],
  expectedCohorts: [],
  repeatLink: null,
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    initializeStore: async () => ({ ok: true as const, value: undefined }),
    readManifest: async () => ({ ok: true as const, value: manifest }),
    writeAcceptedArtifact: async () => ({ ok: true as const, value: undefined }),
    readStagedJson: async () => ({ ok: false as const, issues: [] }),
    runFreshWorker: async () => ({ outcomes: [] }),
    reconcileAcceptedOperation: async () => [],
    ...overrides,
  };
}

const captureRequest = { baselineId: manifest.request.baselineId, workloadId: 'RTC-B01' as const };
const producerIssue = {
  path: '$.producerExitStatus',
  code: 'producer-exit-status',
  message: 'Producer exited with status 9.',
};
const syntheticOwnership = 'Synthetic workloads must enter through capture.';
const browserOwnership = 'Native-browser workloads must enter through record-browser.';
const externalOwnership = 'Local-full-stack workloads must enter through external ingestion.';

function collectWrites(writes: unknown[]) {
  return async (_baselineId: string, artifact: unknown) => {
    writes.push(artifact);
    return { ok: true as const, value: undefined };
  };
}

function rejected(path: string, code: string, message: string) {
  return { ok: false, issues: [{ path, code, message }] };
}

function manifestFor(workloadId: 'RTC-B05' | 'RTC-B06') {
  const browser = workloadId === 'RTC-B05';
  const baselineId = browser
    ? '20260807-0123456789ab-e2-browser'
    : '20260807-0123456789ab-e3-memory';
  return {
    ...manifest,
    request: {
      ...manifest.request,
      baselineId,
      workloadIds: [workloadId],
      environmentId: browser ? 'E2-browser' : 'E3-memory',
    },
    workloadIds: [workloadId],
    outerAttempts: [
      {
        ...attempt,
        workloadId,
        caseId: browser ? 'browser-data-channel-lifecycle' : 'case',
        inputKey: browser ? 'iterations-25' : 'input',
        environmentId: browser ? 'E2-browser' : 'E3-memory',
        sampleIds: [
          browser
            ? 'rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001-001'
            : 'rtc-b06-case-input-retained-001-001',
        ],
      },
    ],
  };
}

function externalInput(workloadId: 'RTC-B01' | 'RTC-B05' | 'RTC-B06') {
  const browser = workloadId === 'RTC-B05';
  return {
    baselineId: browser
      ? '20260807-0123456789ab-e2-browser'
      : workloadId === 'RTC-B06'
        ? '20260807-0123456789ab-e3-memory'
        : manifest.request.baselineId,
    locator: {
      workloadId,
      caseId: browser ? 'browser-data-channel-lifecycle' : 'case',
      inputKey: browser ? 'iterations-25' : 'input',
      intendedPhase: 'retained' as const,
      outerOrdinal: 1,
    },
    producerExitStatus: 0,
    rawResultRelativePath: 'artifacts/staging/result.json',
  };
}

function stagedAttempt(workloadId: 'RTC-B05' | 'RTC-B06') {
  const input = externalInput(workloadId);
  const manifest = manifestFor(workloadId);
  const outer = manifest.outerAttempts[0]!;
  const identity = {
    sampleId: outer.sampleIds[0],
    workloadId,
    caseId: outer.caseId,
    inputKey: outer.inputKey,
    intendedPhase: 'retained' as const,
    outerOrdinal: 1,
    innerOrdinal: 1,
  };
  return {
    schema: 'rallar.rtc-baseline.external-attempt.v1',
    locator: {
      ...input.locator,
      environmentId: outer.environmentId,
      rawResultRelativePath: input.rawResultRelativePath,
    },
    producerExitStatus: 0,
    producerFacts: {
      databaseUrl: 'absent',
      allScenariosPresent: false,
      allScenariosRaw: null,
      retentionSoakPresent: false,
      retentionSoakRaw: null,
      retentionCyclesPresent: false,
      retentionCyclesRaw: null,
      iceModePresent: false,
      iceModeRaw: null,
    },
    sampleOutcomes: [
      {
        identity,
        outcome: 'passed',
        issues: [],
      },
    ],
    samples: [
      passedSample(identity, workloadId === 'RTC-B05' ? 'native-browser' : 'local-full-stack'),
    ],
    issues: [],
  };
}

describe('RTC baseline evidence acceptance', () => {
  it('starts one fresh child per outer attempt and persists every exact inner outcome', async () => {
    const writes: unknown[] = [];
    const runFreshWorker = vi
      .fn()
      .mockResolvedValueOnce({ outcomes: [passedFirst, passedSecond] })
      .mockResolvedValueOnce({ outcomes: [passedThird] });
    const acceptance = createRtcBaselineEvidenceAcceptance(
      dependencies({
        runFreshWorker,
        readManifest: async () => ({
          ok: true,
          value: { ...manifest, outerAttempts: [attempt, secondAttempt] },
        }),
        writeAcceptedArtifact: collectWrites(writes),
      }),
    );
    expect(await acceptance.captureWorkload(captureRequest)).toEqual({
      ok: true,
      value: { acceptedSampleCount: 3 },
    });
    expect(runFreshWorker).toHaveBeenCalledTimes(2);
    expect(runFreshWorker).toHaveBeenNthCalledWith(1, {
      baselineId: manifest.request.baselineId,
      outerAttempt: attempt,
    });
    expect(runFreshWorker).toHaveBeenNthCalledWith(2, {
      baselineId: manifest.request.baselineId,
      outerAttempt: secondAttempt,
    });
    expect(writes).toEqual([passedFirst, passedSecond, passedThird]);
  });

  it('gives producer status precedence over valid-looking staged browser evidence', async () => {
    const writes: unknown[] = [];
    const readStagedJson = vi.fn(async () => ({ ok: true as const, value: {} }));
    const browserManifest = {
      ...manifestFor('RTC-B05'),
      outerAttempts: [
        {
          ...manifestFor('RTC-B05').outerAttempts[0],
          sampleIds: ['sample-1'],
        },
      ],
    };
    const acceptance = createRtcBaselineEvidenceAcceptance(
      dependencies({
        readManifest: async () => ({ ok: true, value: browserManifest }),
        readStagedJson,
        writeAcceptedArtifact: collectWrites(writes),
      }),
    );
    const result = await acceptance.recordBrowser({
      baselineId: '20260807-0123456789ab-e2-browser',
      locator: {
        workloadId: 'RTC-B05',
        caseId: 'browser-data-channel-lifecycle',
        inputKey: 'iterations-25',
        intendedPhase: 'retained',
        outerOrdinal: 1,
      },
      producerExitStatus: 9,
      rawResultRelativePath:
        'artifacts/staging/rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001.json',
    });
    expect(result).toEqual({ ok: false, issues: [producerIssue] });
    expect(readStagedJson).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
  });

  it.each([
    ['external', 'RTC-B01', '$.locator.workloadId', syntheticOwnership],
    ['capture', 'RTC-B05', '$.workloadId', browserOwnership],
    ['browser', 'RTC-B06', '$.locator.workloadId', externalOwnership],
  ] as const)('rejects %s entry ownership for %s', async (entry, workloadId, path, message) => {
    const service = createRtcBaselineEvidenceAcceptance(
      dependencies({
        readManifest: async () => ({
          ok: true,
          value: workloadId === 'RTC-B01' ? manifest : manifestFor(workloadId),
        }),
      }),
    );
    const result =
      entry === 'capture'
        ? service.captureWorkload({ baselineId: manifest.request.baselineId, workloadId })
        : entry === 'browser'
          ? service.recordBrowser(externalInput(workloadId))
          : service.recordExternalAttempt(externalInput(workloadId));
    expect(await result).toEqual(rejected(path, 'entry-ownership', message));
  });

  it('accepts valid browser and external samples and writes every normalized field', async () => {
    const writes: unknown[] = [];
    const browserAttempt = stagedAttempt('RTC-B05');
    const browser = createRtcBaselineEvidenceAcceptance(
      dependencies({
        readManifest: async () => ({ ok: true, value: manifestFor('RTC-B05') }),
        readStagedJson: async () => ({ ok: true, value: browserAttempt }),
        writeAcceptedArtifact: collectWrites(writes),
      }),
    );
    expect(await browser.recordBrowser(externalInput('RTC-B05'))).toEqual({
      ok: true,
      value: { acceptedSampleCount: 1 },
    });
    const externalAttempt = stagedAttempt('RTC-B06');
    const external = createRtcBaselineEvidenceAcceptance(
      dependencies({
        readManifest: async () => ({ ok: true, value: manifestFor('RTC-B06') }),
        readStagedJson: async () => ({ ok: true, value: externalAttempt }),
        writeAcceptedArtifact: collectWrites(writes),
      }),
    );
    expect(await external.recordExternalAttempt(externalInput('RTC-B06'))).toEqual({
      ok: true,
      value: { acceptedSampleCount: 1 },
    });
    expect(writes).toEqual([browserAttempt, externalAttempt]);
    Object.assign(externalAttempt.samples[0]!, { outcome: 'failed', issues: [producerIssue] });
    Object.assign(externalAttempt.sampleOutcomes[0]!, {
      outcome: 'failed',
      issues: [producerIssue],
    });
    expect(await external.recordExternalAttempt(externalInput('RTC-B06'))).toEqual({
      ok: false,
      issues: [producerIssue],
    });
    expect(Reflect.get(writes.at(-1)!, 'artifactKind')).toBe('failure');
  });

  it('binds an external cohort to its exact locator, members, raw path, and producer facts', async () => {
    const writes: unknown[] = [];
    const b06Manifest = {
      ...manifestFor('RTC-B06'),
      expectedCohorts: [
        {
          cohortId: 'rtc-b06-e3-memory-retention',
          workloadId: 'RTC-B06',
          memberSampleIds: ['member-a', 'member-b'],
        },
      ],
    };
    const stagedCohort = {
      schema: 'rallar.rtc-baseline.external-cohort.v1',
      identity: {
        cohortId: 'rtc-b06-e3-memory-retention',
        workloadId: 'RTC-B06',
        memberSampleIds: ['member-a', 'member-b'],
      },
      outcome: 'passed',
      rawEvidence: { breaches: 0 },
      issues: [],
      samples: [
        passedSample(
          { ...firstIdentity, sampleId: 'member-a', workloadId: 'RTC-B06' },
          'local-full-stack',
        ),
        passedSample(
          { ...firstIdentity, sampleId: 'member-b', workloadId: 'RTC-B06' },
          'local-full-stack',
        ),
      ],
    };
    const acceptance = createRtcBaselineEvidenceAcceptance(
      dependencies({
        readManifest: async () => ({ ok: true, value: b06Manifest }),
        readStagedJson: async () => ({ ok: true, value: stagedCohort }),
        writeAcceptedArtifact: collectWrites(writes),
      }),
    );
    const cohortInput = {
      baselineId: '20260807-0123456789ab-e3-memory',
      workloadId: 'RTC-B06' as const,
      cohortId: 'rtc-b06-e3-memory-retention',
      producerExitStatus: 0,
      rawResultRelativePath: 'artifacts/staging/rtc-b06-e3-memory-retention.json',
    };
    expect(await acceptance.recordExternalCohortAssertion(cohortInput)).toEqual({
      ok: true,
      value: { acceptedCohortCount: 1 },
    });
    expect(writes).toEqual([stagedCohort]);
    Object.assign(stagedCohort, { outcome: 'failed', issues: [producerIssue] });
    expect(await acceptance.recordExternalCohortAssertion(cohortInput)).toEqual({
      ok: false,
      issues: [producerIssue],
    });
    expect(Reflect.get(writes.at(-1)!, 'artifactKind')).toBe('failure');
  });
});
