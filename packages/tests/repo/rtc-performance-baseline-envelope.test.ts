import { describe, expect, it, vi } from 'vitest';

import { createRtcBaselineEnvelope } from '../../../scripts/perf/rtc-baseline/rtc-baseline-envelope.ts';

const request = {
  schema: 'rallar.rtc-baseline.capture-request.v1' as const,
  baselineId: '20260807-0123456789ab-e1-local',
  workloadIds: ['RTC-B01'] as const,
  environmentId: 'E1-local' as const,
  retainedSampleMultiplier: 1 as const,
  repeatLink: null,
  conditionalEnvironmentDecisions: [],
};

describe('RTC baseline public envelope', () => {
  it('delegates every accepted mutation and propagates typed left values', async () => {
    const failure = {
      ok: false as const,
      issues: [{ path: '$', code: 'failed', message: 'failed' }],
    };
    const acceptance = {
      initializeBaseline: vi.fn(async () => failure),
      captureWorkload: vi.fn(async () => failure),
      recordBrowser: vi.fn(async () => failure),
      recordExternalAttempt: vi.fn(async () => failure),
      recordExternalCohortAssertion: vi.fn(async () => failure),
    };
    const envelope = createRtcBaselineEnvelope({
      acceptance,
      finalizedEvidence: { finalize: vi.fn(async () => failure) },
      finalizedReader: {
        readExternalAttempts: vi.fn(async () => failure),
        readRepeatRequirement: vi.fn(async () => failure),
        readPairedComparison: vi.fn(async () => failure),
        readBaselineValidation: vi.fn(async () => failure),
        readVerifiedRepeatPrimary: vi.fn(async () => failure),
      },
      observeRuntime: vi.fn(async () => ({ ok: true as const, value: { observed: true } })),
    });
    const initialize = request;
    const capture = { baselineId: request.baselineId, workloadId: 'RTC-B01' as const };
    const browser = {
      baselineId: '20260807-0123456789ab-e2-browser',
      locator: {
        workloadId: 'RTC-B05' as const,
        caseId: 'browser-data-channel-lifecycle',
        inputKey: 'iterations-25',
        intendedPhase: 'retained' as const,
        outerOrdinal: 1,
      },
      producerExitStatus: 0,
      rawResultRelativePath: 'artifacts/browser.json',
    };
    const external = {
      ...browser,
      baselineId: '20260807-0123456789ab-e3-memory',
      locator: { ...browser.locator, workloadId: 'RTC-B06' as const },
    };
    const cohort = {
      baselineId: '20260807-0123456789ab-e3-memory',
      workloadId: 'RTC-B06' as const,
      cohortId: 'rtc-b06-e3-memory-retention',
      producerExitStatus: 0,
      rawResultRelativePath: 'artifacts/cohort.json',
    };
    expect(await envelope.initializeBaseline(initialize)).toEqual(failure);
    expect(await envelope.captureWorkload(capture)).toEqual(failure);
    expect(await envelope.recordBrowser(browser)).toEqual(failure);
    expect(await envelope.recordExternalAttempt(external)).toEqual(failure);
    expect(await envelope.recordExternalCohortAssertion(cohort)).toEqual(failure);
    expect(acceptance.initializeBaseline).toHaveBeenCalledWith({
      request: initialize,
      runtimeObservation: { observed: true },
    });
    expect(acceptance.captureWorkload).toHaveBeenCalledWith(capture);
    expect(acceptance.recordBrowser).toHaveBeenCalledWith(browser);
    expect(acceptance.recordExternalAttempt).toHaveBeenCalledWith(external);
    expect(acceptance.recordExternalCohortAssertion).toHaveBeenCalledWith(cohort);
  });

  it('delegates finalization and all five finalized-reader operations exactly once', async () => {
    const success = { ok: true as const, value: { value: true } };
    const finalizedEvidence = { finalize: vi.fn(async () => success) };
    const finalizedReader = {
      readExternalAttempts: vi.fn(async () => success),
      readRepeatRequirement: vi.fn(async () => success),
      readPairedComparison: vi.fn(async () => success),
      readBaselineValidation: vi.fn(async () => success),
      readVerifiedRepeatPrimary: vi.fn(async () => success),
    };
    const envelope = createRtcBaselineEnvelope({
      acceptance: {
        initializeBaseline: vi.fn(async () => success),
        captureWorkload: vi.fn(async () => success),
        recordBrowser: vi.fn(async () => success),
        recordExternalAttempt: vi.fn(async () => success),
        recordExternalCohortAssertion: vi.fn(async () => success),
      },
      finalizedEvidence,
      finalizedReader,
      observeRuntime: vi.fn(async () => success),
    });
    const value = { baselineId: '20260807-0123456789ab-e1-local' };
    const externalInput = { ...value, workloadId: 'RTC-B06' as const };
    const pairedInput = {
      primaryBaselineId: value.baselineId,
      comparisonBaselineId: '20260807-ffffffffffff-e1-local',
      primaryComparisonCohortId: value.baselineId,
      comparisonCohortId: '20260807-ffffffffffff-e1-local',
      workloadId: 'RTC-B01' as const,
    };
    expect(await envelope.finalize(value)).toEqual(success);
    expect(await envelope.readExternalAttempts(externalInput)).toEqual(success);
    expect(await envelope.readRepeatRequirement(value)).toEqual(success);
    expect(await envelope.readPairedComparison(pairedInput)).toEqual(success);
    expect(await envelope.readBaselineValidation(value)).toEqual(success);
    expect(await envelope.readVerifiedRepeatPrimary(value)).toEqual(success);
    expect(finalizedEvidence.finalize).toHaveBeenCalledWith(value);
    expect(finalizedReader.readExternalAttempts).toHaveBeenCalledWith(externalInput);
    expect(finalizedReader.readRepeatRequirement).toHaveBeenCalledWith(value);
    expect(finalizedReader.readPairedComparison).toHaveBeenCalledWith(pairedInput);
    expect(finalizedReader.readBaselineValidation).toHaveBeenCalledWith(value);
    expect(finalizedReader.readVerifiedRepeatPrimary).toHaveBeenCalledWith(value);
  });

  it('obtains runtime observation before public initialization including repeats', async () => {
    const calls: string[] = [];
    const observeRuntime = vi.fn(async () => {
      calls.push('observe');
      return { ok: true as const, value: { git: { clean: true } } };
    });
    const initializeBaseline = vi.fn(async () => {
      calls.push('initialize');
      return { ok: true as const, value: undefined };
    });
    const envelope = createRtcBaselineEnvelope({
      acceptance: {
        initializeBaseline,
        captureWorkload: vi.fn(),
        recordBrowser: vi.fn(),
        recordExternalAttempt: vi.fn(),
        recordExternalCohortAssertion: vi.fn(),
      },
      finalizedEvidence: { finalize: vi.fn() },
      finalizedReader: {
        readExternalAttempts: vi.fn(),
        readRepeatRequirement: vi.fn(),
        readPairedComparison: vi.fn(),
        readBaselineValidation: vi.fn(),
        readVerifiedRepeatPrimary: vi.fn(),
      },
      observeRuntime,
    });
    const repeatRequest = {
      ...request,
      baselineId: '20260807-0123456789ab-e1-local-repeat-01',
      retainedSampleMultiplier: 2 as const,
      repeatLink: {
        primaryBaselineId: '20260807-0123456789ab-e1-local',
        primarySummarySha256: 'a'.repeat(64),
      },
    };
    await envelope.initializeBaseline(repeatRequest);
    expect(calls).toEqual(['observe', 'initialize']);
    expect(observeRuntime).toHaveBeenCalledWith(repeatRequest);
    expect(initializeBaseline).toHaveBeenCalledWith({
      request: repeatRequest,
      runtimeObservation: { git: { clean: true } },
    });
  });

  it('returns runtime-observation failures without invoking acceptance', async () => {
    const observationFailure = {
      ok: false as const,
      issues: [{ path: '$.git', code: 'git-failed', message: 'git unavailable' }],
    };
    const initializeBaseline = vi.fn();
    const envelope = createRtcBaselineEnvelope({
      acceptance: {
        initializeBaseline,
        captureWorkload: vi.fn(),
        recordBrowser: vi.fn(),
        recordExternalAttempt: vi.fn(),
        recordExternalCohortAssertion: vi.fn(),
      },
      finalizedEvidence: { finalize: vi.fn() },
      finalizedReader: {
        readExternalAttempts: vi.fn(),
        readRepeatRequirement: vi.fn(),
        readPairedComparison: vi.fn(),
        readBaselineValidation: vi.fn(),
        readVerifiedRepeatPrimary: vi.fn(),
      },
      observeRuntime: vi.fn(async () => observationFailure),
    });

    expect(await envelope.initializeBaseline(request)).toEqual(observationFailure);
    expect(initializeBaseline).not.toHaveBeenCalled();
  });

  it('rejects invalid initialization before observing or mutating', async () => {
    const observeRuntime = vi.fn();
    const initializeBaseline = vi.fn();
    const envelope = createRtcBaselineEnvelope({
      acceptance: {
        initializeBaseline,
        captureWorkload: vi.fn(),
        recordBrowser: vi.fn(),
        recordExternalAttempt: vi.fn(),
        recordExternalCohortAssertion: vi.fn(),
      },
      finalizedEvidence: { finalize: vi.fn() },
      finalizedReader: {
        readExternalAttempts: vi.fn(),
        readRepeatRequirement: vi.fn(),
        readPairedComparison: vi.fn(),
        readBaselineValidation: vi.fn(),
        readVerifiedRepeatPrimary: vi.fn(),
      },
      observeRuntime,
    });
    expect(await envelope.initializeBaseline({ ...request, baselineId: '../escape' })).toEqual({
      ok: false,
      issues: [
        {
          path: '$.baselineId',
          code: 'invalid-baseline-id',
          message: 'Baseline ID does not match the canonical grammar.',
        },
      ],
    });
    expect(
      await envelope.initializeBaseline({
        ...request,
        retainedSampleMultiplier: 2,
        repeatLink: {
          primaryBaselineId: request.baselineId,
          primarySummarySha256: 'a'.repeat(64),
        },
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.retainedSampleMultiplier',
          code: 'unexpected-repeat-multiplier',
          message: 'A primary baseline requires retained sample multiplier 1.',
        },
        {
          path: '$.repeatLink',
          code: 'unexpected-repeat-link',
          message: 'A primary baseline cannot carry a repeat link.',
        },
      ],
    });
    expect(observeRuntime).not.toHaveBeenCalled();
    expect(initializeBaseline).not.toHaveBeenCalled();
  });
});
