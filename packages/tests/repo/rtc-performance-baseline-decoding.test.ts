import { describe, expect, it } from 'vitest';

import {
  decodeRtcBaselineCaptureRequest,
  decodeRtcBaselineConditionalEnvironmentDecision,
  decodeRtcBaselineRepeatLink,
  normalizeRtcBaselineJson,
} from '../../../scripts/perf/rtc-baseline/rtc-baseline-decoding.ts';
import { decodeRtcBaselineFailureOutcome } from '../../../scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts';

const failureIdentity = {
  sampleId: 'rtc-b01-case-input-retained-001-001',
  workloadId: 'RTC-B01',
  caseId: 'case',
  inputKey: 'input',
  intendedPhase: 'retained',
  outerOrdinal: 1,
  innerOrdinal: 1,
} as const;
const failureId = `failure-sample-${failureIdentity.sampleId}`;
const failurePath = `results/failures/${failureId}-${failureIdentity.sampleId}.json`;
const failureArtifact = {
  artifactKind: 'failure',
  failureId,
  identity: failureIdentity,
  outcome: 'failed',
  causalFailureId: null,
  issues: [
    {
      path: '$.worker',
      code: 'producer-failed',
      message: 'Worker failed.',
      details: { exitStatus: 1 },
    },
  ],
  rawEvidence: { exitStatus: 1 },
} as const;

describe('RTC baseline core decoding', () => {
  it('normalizes dense plain JSON without implicit conversions', () => {
    expect(normalizeRtcBaselineJson({ values: [1, 'two', false, null] })).toEqual({
      ok: true,
      value: { values: [1, 'two', false, null] },
    });
    const sparse = new Array(2);
    sparse[1] = 'present';
    expect(normalizeRtcBaselineJson({ values: sparse })).toEqual({
      ok: false,
      issues: [
        {
          path: '$.values[0]',
          code: 'sparse-array',
          message: 'Array entries must be dense JSON values.',
        },
      ],
    });
    expect(normalizeRtcBaselineJson({ value: Number.NaN })).toEqual({
      ok: false,
      issues: [
        {
          path: '$.value',
          code: 'non-json-number',
          message: 'Numbers must be finite.',
        },
      ],
    });
  });

  it('decodes an ordered, nonempty, duplicate-free workload request', () => {
    const decoded = decodeRtcBaselineCaptureRequest({
      schema: 'rallar.rtc-baseline.capture-request.v1',
      baselineId: '20260807-0123456789ab-e1-local',
      workloadIds: ['RTC-B03', 'RTC-B01'],
      environmentId: 'E1-local',
      retainedSampleMultiplier: 1,
      repeatLink: null,
      conditionalEnvironmentDecisions: [],
    });

    expect(decoded).toEqual({
      ok: true,
      value: {
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId: '20260807-0123456789ab-e1-local',
        workloadIds: ['RTC-B03', 'RTC-B01'],
        environmentId: 'E1-local',
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: [],
      },
    });
  });

  it('returns every structural request issue in stable path order', () => {
    expect(
      decodeRtcBaselineCaptureRequest({
        schema: 1,
        baselineId: null,
        workloadIds: [],
        environmentId: 'unknown',
        retainedSampleMultiplier: 0,
        repeatLink: {},
        conditionalEnvironmentDecisions: [null],
      }),
    ).toEqual({
      ok: false,
      issues: [
        { path: '$.schema', code: 'expected-string', message: 'Expected a string.' },
        { path: '$.baselineId', code: 'expected-string', message: 'Expected a string.' },
        { path: '$.workloadIds', code: 'empty-array', message: 'Expected a nonempty array.' },
        {
          path: '$.environmentId',
          code: 'unsupported-value',
          message: 'Expected one of E1-local, E2-browser, E3-memory, E4-pg, E5-remote.',
        },
        {
          path: '$.retainedSampleMultiplier',
          code: 'unsupported-value',
          message: 'Expected 1 or 2.',
        },
        {
          path: '$.repeatLink.primaryBaselineId',
          code: 'expected-string',
          message: 'Expected a string.',
        },
        {
          path: '$.repeatLink.primarySummarySha256',
          code: 'expected-string',
          message: 'Expected a string.',
        },
        {
          path: '$.conditionalEnvironmentDecisions[0]',
          code: 'expected-object',
          message: 'Expected a plain object.',
        },
      ],
    });
  });

  it('decodes exact conditional decisions and repeat links', () => {
    expect(
      decodeRtcBaselineConditionalEnvironmentDecision({
        environmentId: 'E4-pg',
        decision: 'not-required',
        reason: 'No persistent path is selected.',
      }),
    ).toEqual({
      ok: true,
      value: {
        environmentId: 'E4-pg',
        decision: 'not-required',
        reason: 'No persistent path is selected.',
      },
    });
    expect(
      decodeRtcBaselineRepeatLink({
        primaryBaselineId: '20260807-0123456789ab-e1-local',
        primarySummarySha256: 'b'.repeat(64),
      }),
    ).toEqual({
      ok: true,
      value: {
        primaryBaselineId: '20260807-0123456789ab-e1-local',
        primarySummarySha256: 'b'.repeat(64),
      },
    });
  });

  it('rejects duplicate and holey workload lists before semantic use', () => {
    const holey = ['RTC-B01', 'RTC-B03'] as unknown[];
    delete holey[0];
    const common = {
      schema: 'rallar.rtc-baseline.capture-request.v1',
      baselineId: '20260807-0123456789ab-e1-local',
      environmentId: 'E1-local',
      retainedSampleMultiplier: 1,
      repeatLink: null,
      conditionalEnvironmentDecisions: [],
    };
    expect(decodeRtcBaselineCaptureRequest({ ...common, workloadIds: holey })).toEqual({
      ok: false,
      issues: [
        {
          path: '$.workloadIds[0]',
          code: 'sparse-array',
          message: 'Array entries must be dense JSON values.',
        },
      ],
    });
    expect(
      decodeRtcBaselineCaptureRequest({ ...common, workloadIds: ['RTC-B01', 'RTC-B01'] }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.workloadIds[1]',
          code: 'duplicate-workload',
          message: 'Workload RTC-B01 appears more than once.',
        },
      ],
    });
  });

  it('returns complete closed-discriminant issues for decisions and repeat links', () => {
    expect(
      decodeRtcBaselineConditionalEnvironmentDecision({
        environmentId: 'E9',
        decision: 'maybe',
        reason: 7,
        extra: true,
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.environmentId',
          code: 'unsupported-value',
          message: 'Expected one of E1-local, E2-browser, E3-memory, E4-pg, E5-remote.',
        },
        {
          path: '$.decision',
          code: 'unsupported-value',
          message: 'Expected required or not-required.',
        },
        { path: '$.reason', code: 'expected-string', message: 'Expected a string.' },
        { path: '$.extra', code: 'unexpected-field', message: 'Field extra is not allowed.' },
      ],
    });
    expect(
      decodeRtcBaselineRepeatLink({ primaryBaselineId: 4, primarySummarySha256: null, extra: [] }),
    ).toEqual({
      ok: false,
      issues: [
        { path: '$.primaryBaselineId', code: 'expected-string', message: 'Expected a string.' },
        { path: '$.primarySummarySha256', code: 'expected-string', message: 'Expected a string.' },
        { path: '$.extra', code: 'unexpected-field', message: 'Field extra is not allowed.' },
      ],
    });
  });

  it('rejects a wrong request schema and every unknown top-level field', () => {
    expect(
      decodeRtcBaselineCaptureRequest({
        schema: 'rallar.rtc-baseline.environment.v1',
        baselineId: '20260807-0123456789ab-e1-local',
        workloadIds: ['RTC-B01'],
        environmentId: 'E1-local',
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: [],
        workloadId: 'RTC-B01',
        rawResult: 'result.json',
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: '$.schema',
          code: 'unsupported-value',
          message: 'Expected rallar.rtc-baseline.capture-request.v1.',
        },
        {
          path: '$.workloadId',
          code: 'unexpected-field',
          message: 'Field workloadId is not allowed.',
        },
        {
          path: '$.rawResult',
          code: 'unexpected-field',
          message: 'Field rawResult is not allowed.',
        },
      ],
    });
  });

  it('closed-decodes persisted failure outcomes and their owned paths', () => {
    expect(decodeRtcBaselineFailureOutcome(failureArtifact, failurePath)).toEqual({
      ok: true,
      value: failureArtifact,
    });
    const notRun = {
      artifactKind: 'not-run',
      failureId,
      identity: { ...failureIdentity, sampleId: 'rtc-b01-case-input-retained-001-002' },
      outcome: 'not-run',
      causalFailureId: failureId,
      issues: [
        {
          path: '$',
          code: 'causal-not-run',
          message: 'Not run after the first workload correctness failure.',
        },
      ],
      rawEvidence: null,
    } as const;
    expect(
      decodeRtcBaselineFailureOutcome(
        notRun,
        `results/failures/${failureId}-rtc-b01-case-input-retained-001-002.json`,
      ),
    ).toEqual({ ok: true, value: notRun });
  });

  it('rejects sparse, forged, unowned, and open failure records', () => {
    expect(decodeRtcBaselineFailureOutcome({ artifactKind: 'failure' }, failurePath)).toEqual({
      ok: false,
      issues: [
        { path: '$.failureId', code: 'expected-string', message: 'Expected a string.' },
        { path: '$.identity', code: 'expected-object', message: 'Expected an identity object.' },
        {
          path: '$.outcome',
          code: 'unsupported-value',
          message: 'Expected failed for a failure artifact.',
        },
        {
          path: '$.causalFailureId',
          code: 'invalid-causal-failure-id',
          message: 'Failure artifacts require a null causal failure ID.',
        },
        { path: '$.issues', code: 'expected-array', message: 'Expected an issue array.' },
        {
          path: '$.rawEvidence',
          code: 'expected-json-value',
          message: 'Expected a JSON value.',
        },
      ],
    });
    const cases = [
      [
        { ...failureArtifact, artifactKind: 'sample' },
        failurePath,
        '$.artifactKind\tunsupported-value\tExpected failure or not-run.',
      ],
      [
        { ...failureArtifact, outcome: 'passed' },
        failurePath,
        '$.outcome\tunsupported-value\tExpected failed for a failure artifact.',
      ],
      [
        { ...failureArtifact, extra: true },
        failurePath,
        '$.extra\tunexpected-field\tField extra is not allowed.',
      ],
      [
        failureArtifact,
        'results/failures/forged.json',
        '$.path\tfailure-path-mismatch\tFailure artifact path does not match its identity.',
      ],
    ] as const;
    for (const [artifact, path, expected] of cases) {
      const result = decodeRtcBaselineFailureOutcome(artifact, path);
      expect(
        result.ok ? '' : result.issues.map((issue) => Object.values(issue).join('\t')).join('\n'),
      ).toBe(expected);
    }
  });
});
