import { describe, expect, it, vi } from 'vitest';
import {
  createRtcBaselineFinalizedEvidence,
  type RtcBaselineCollectedArtifacts,
  type RtcBaselineFinalizationLockedWriter,
} from '../../../baseline/evidence/rtc-baseline-finalized-evidence.ts';
import { computeRtcBaselineMetricObservations } from '../../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import type { RtcBaselineSampleDto } from '../../../baseline/contracts/rtc-baseline-contracts.ts';
import {
  computeRtcBaselineMetricSummary,
  partitionRtcBaselineMetricObservations,
} from '../../../baseline/evidence/rtc-baseline-statistics.ts';
const emptyCollectedJson =
  '{"environment":{"schema":"rallar.rtc-baseline.environment.v1","baselineId":"20260807-0123456789ab-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":null,"conditionalEnvironmentDecisions":[],"observation":{"git":{"headCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headTree":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ref":"codex/rtc","clean":true},"runtime":{"node":"24","npm":"11","deno":"2","playwright":"1","chromium":"139"},"host":{"os":"darwin","kernel":"24.6.0","architecture":"arm64","logicalCpuCount":10,"cpuModel":"Apple M4","totalMemoryBytes":1,"executionContext":"local"},"timing":{"startedAtUtc":"2026-08-07T10:00:00.000Z","endedAtUtc":"2026-08-07T10:00:01.000Z","monotonicDurationMs":1000,"monotonicSource":"performance.now"},"deviations":[],"sourceHashes":[],"configurationInputs":[],"resolvedConfiguration":[],"controllerInputs":[],"workerCommand":{"redactedArgv":{"executable":"deno","arguments":[]},"projection":{"fixedWorkerFlags":[],"configurationFlags":[]}},"allowlistedEnvironment":{}}},"manifest":{"schema":"rallar.rtc-baseline.manifest.v1","request":{"schema":"rallar.rtc-baseline.capture-request.v1","baselineId":"20260807-0123456789ab-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","retainedSampleMultiplier":1,"repeatLink":null,"conditionalEnvironmentDecisions":[]},"workloadIds":["RTC-B01"],"cases":[],"outerAttempts":[],"expectedCohorts":[{"cohortId":"cohort-failed","workloadId":"RTC-B01","memberSampleIds":[]}],"repeatLink":null},"workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":null,"conditionalEnvironmentDecisions":[],"sampleOutcomes":[],"cohortOutcomes":[],"failures":[{"artifactKind":"failure","failureId":"failure-cohort-cohort-failed","identity":{"cohortId":"cohort-failed","workloadId":"RTC-B01","memberSampleIds":[]},"outcome":"failed","causalFailureId":null,"issues":[{"path":"$.cohort","code":"producer-failed","message":"producer failed"}],"rawEvidence":null}],"samples":[],"retainedArtifacts":[],"rawReferences":[{"relativePath":"raw.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":0}]}';
const decodedCollected = JSON.parse(emptyCollectedJson);
const emptyCollected: RtcBaselineCollectedArtifacts = {
  environment: decodedCollected.environment,
  manifest: {
    ...decodedCollected.manifest,
    expectedCohorts: [],
  },
  workloadIds: decodedCollected.workloadIds,
  environmentId: decodedCollected.environmentId,
  repeatLink: decodedCollected.repeatLink,
  conditionalEnvironmentDecisions: decodedCollected.conditionalEnvironmentDecisions,
  sampleOutcomes: [],
  cohortOutcomes: [],
  failures: [],
  metricObservations: [],
  rawReferences: [],
  artifactIssues: [],
  retainedArtifactPaths: [],
};
const retainedSample: RtcBaselineSampleDto = {
  schema: 'rallar.rtc-baseline.sample.v1',
  identity: {
    sampleId: 'rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001',
    workloadId: 'RTC-B01',
    caseId: 'peer-connection-diagnostics-burst',
    inputKey: 'pairs-500',
    intendedPhase: 'retained',
    outerOrdinal: 1,
    innerOrdinal: 1,
  },
  outcome: 'passed',
  evidenceClass: 'synthetic-path',
  metrics: [{ metric: 'durationMs', unit: 'ms', value: 10 }],
  rawEvidence: {},
  rawReferences: [{ relativePath: 'artifacts/raw.bin', sha256: 'a'.repeat(64), bytes: 3 }],
  issues: [],
  runtimeObservation: emptyCollected.environment.observation,
};
const collectedWithRawSample = {
  ...emptyCollected,
  rawReferences: retainedSample.rawReferences,
};
function finalizationDependencies(overrides: Record<string, unknown> = {}) {
  const configured = {
    collectArtifacts: async () => ({ ok: true as const, value: emptyCollected }),
    partitionMetricObservations: () => ({ ok: true as const, value: [] }),
    summarizeMetricValues: () => {
      throw new Error('not called');
    },
    readBytes: async () => ({ ok: true as const, value: new Uint8Array() }),
    sha256: async () => 'a'.repeat(64),
    publishSummary: async () => ({ ok: true as const, value: undefined }),
    writeFinalizationFailure: async () => ({ ok: true as const, value: undefined }),
    ...overrides,
  };
  const withFinalizationLock = Reflect.get(overrides, 'withFinalizationLock') as
    Parameters<typeof createRtcBaselineFinalizedEvidence>[0]['withFinalizationLock'] | undefined;
  return {
    ...configured,
    withFinalizationLock:
      withFinalizationLock ??
      (async (_baselineId: string, operation: (writer: object) => Promise<unknown>) =>
        operation({
          publishSummary: configured.publishSummary,
          writeFinalizationFailure: configured.writeFinalizationFailure,
        })),
  } as unknown as Parameters<typeof createRtcBaselineFinalizedEvidence>[0];
}
describe('RTC baseline finalization', () => {
  it('publishes a deterministic summary and checksums from compact projections', async () => {
    const calls: string[] = [];
    const publishSummary = vi.fn(async (_baselineId, summaryBytes, checksumBytes) => {
      calls.push(
        `publish:${new TextDecoder().decode(summaryBytes)}:${new TextDecoder().decode(
          checksumBytes,
        )}`,
      );
      return { ok: true as const, value: undefined };
    });
    const finalizer = createRtcBaselineFinalizedEvidence({
      withFinalizationLock: async (_baselineId, operation) => {
        calls.push('lock:start');
        const result = await operation({
          publishSummary,
          writeFinalizationFailure: async () => ({ ok: true, value: undefined }),
        });
        calls.push('lock:end');
        return result;
      },
      collectArtifacts: async () => {
        calls.push('collect');
        const samples = [
          retainedSample,
          {
            ...retainedSample,
            identity: {
              ...retainedSample.identity,
              sampleId: 'rtc-b01-heap-case-heap-1-retained-001-001',
              caseId: 'heap-case',
              inputKey: 'heap-1',
            },
            metrics: [{ metric: 'heapBytes', unit: 'bytes', value: 1024 }],
            rawReferences: [],
          },
        ];
        return {
          ok: true,
          value: {
            ...emptyCollected,
            manifest: {
              ...emptyCollected.manifest,
              outerAttempts: samples.map((sample) => ({
                workloadId: sample.identity.workloadId,
                caseId: sample.identity.caseId,
                inputKey: sample.identity.inputKey,
                environmentId: emptyCollected.environmentId,
                intendedPhase: sample.identity.intendedPhase,
                outerOrdinal: sample.identity.outerOrdinal,
                sampleIds: [sample.identity.sampleId],
              })),
            },
            sampleOutcomes: samples.map((sample) => ({
              identity: sample.identity,
              outcome: sample.outcome,
              issues: sample.issues,
            })),
            metricObservations: computeRtcBaselineMetricObservations(
              samples,
              emptyCollected.environmentId,
            ),
            rawReferences: samples.flatMap((sample) => sample.rawReferences),
            retainedArtifactPaths: [
              'environment.json',
              'manifest.json',
              'results/samples/sample.json',
            ],
          },
        };
      },
      partitionMetricObservations: (observations) => {
        calls.push('partition');
        return partitionRtcBaselineMetricObservations(observations);
      },
      summarizeMetricValues: (values) => {
        calls.push('summarize');
        return computeRtcBaselineMetricSummary(values);
      },
      readBytes: async () => ({ ok: true, value: new TextEncoder().encode('raw') }),
      sha256: async () => 'a'.repeat(64),
    });
    const summaryText =
      '{"schema":"rallar.rtc-baseline.summary.v1","baselineId":"20260807-0123456789ab-e1-local","workloadIds":["RTC-B01"],"environmentId":"E1-local","repeatLink":null,"conditionalEnvironmentDecisions":[],"sampleOutcomes":[{"identity":{"sampleId":"rtc-b01-heap-case-heap-1-retained-001-001","workloadId":"RTC-B01","caseId":"heap-case","inputKey":"heap-1","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","issues":[]},{"identity":{"sampleId":"rtc-b01-peer-connection-diagnostics-burst-pairs-500-retained-001-001","workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","intendedPhase":"retained","outerOrdinal":1,"innerOrdinal":1},"outcome":"passed","issues":[]}],"cohortOutcomes":[],"metricSummaries":[{"workloadId":"RTC-B01","caseId":"heap-case","inputKey":"heap-1","metric":"heapBytes","unit":"bytes","count":1,"minimum":1024,"median":1024,"maximum":1024,"mad":0,"coefficientOfVariation":0},{"workloadId":"RTC-B01","caseId":"peer-connection-diagnostics-burst","inputKey":"pairs-500","metric":"durationMs","unit":"ms","count":1,"minimum":10,"median":10,"maximum":10,"mad":0,"coefficientOfVariation":0}],"rawReferences":[{"relativePath":"artifacts/raw.bin","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bytes":3}]}';
    expect(await finalizer.finalize({ baselineId: '20260807-0123456789ab-e1-local' })).toEqual({
      ok: true,
      value: JSON.parse(summaryText),
    });
    expect(calls.slice(0, 4)).toEqual(['lock:start', 'collect', 'partition', 'summarize']);
    expect([publishSummary.mock.calls.length, calls.at(-1)]).toEqual([1, 'lock:end']);
    expect(publishSummary).toHaveBeenCalledWith(
      '20260807-0123456789ab-e1-local',
      new TextEncoder().encode(summaryText),
      new TextEncoder().encode(
        `${'a'.repeat(64)}  artifacts/raw.bin\n` +
          `${'a'.repeat(64)}  environment.json\n` +
          `${'a'.repeat(64)}  manifest.json\n` +
          `${'a'.repeat(64)}  results/samples/sample.json\n` +
          `${'a'.repeat(64)}  summary.json\n`,
      ),
    );
  });
  it('verifies confined raw-reference bytes and hashes before publication', async () => {
    const publishSummary = vi.fn();
    const writeFailure = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const rawBytes = new TextEncoder().encode('x');
    const readBytes = vi.fn(async () => ({ ok: true as const, value: rawBytes }));
    const finalizer = createRtcBaselineFinalizedEvidence({
      withFinalizationLock: async (_baselineId, operation) =>
        operation({ publishSummary, writeFinalizationFailure: writeFailure }),
      collectArtifacts: async () => ({
        ok: true,
        value: {
          ...emptyCollected,
          rawReferences: [
            { relativePath: 'artifacts/raw.json', sha256: 'b'.repeat(64), bytes: 2 },
            { relativePath: 'artifacts/raw.json', sha256: 'b'.repeat(64), bytes: 2 },
          ],
        },
      }),
      partitionMetricObservations: () => ({ ok: true, value: [] }),
      summarizeMetricValues: () => {
        throw new Error('not called');
      },
      readBytes,
      sha256: async () => 'c'.repeat(64),
    });
    const result = await finalizer.finalize({ baselineId: '20260807-0123456789ab-e1-local' });
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: '$.rawReferences[0].bytes',
          code: 'raw-byte-length-mismatch',
          message: 'Raw reference byte length differs from stored bytes.',
        },
        {
          path: '$.rawReferences[0].sha256',
          code: 'raw-sha256-mismatch',
          message: 'Raw reference SHA-256 differs from stored bytes.',
        },
      ],
    });
    expect(publishSummary).not.toHaveBeenCalled();
    expect(readBytes).toHaveBeenCalledTimes(1);
    expect(writeFailure).toHaveBeenCalledWith('20260807-0123456789ab-e1-local', {
      schema: 'rallar.rtc-baseline.finalization-failure.v1',
      baselineId: '20260807-0123456789ab-e1-local',
      failureId: 'finalization-raw-reference',
      issues: [
        {
          path: '$.rawReferences[0].bytes',
          code: 'raw-byte-length-mismatch',
          message: 'Raw reference byte length differs from stored bytes.',
        },
        {
          path: '$.rawReferences[0].sha256',
          code: 'raw-sha256-mismatch',
          message: 'Raw reference SHA-256 differs from stored bytes.',
        },
      ],
      rawEvidence: null,
    });
  });
  it('publishes success and persists failure through one exclusive outer lock', async () => {
    for (const publication of ['success', 'failure'] as const) {
      let active = false;
      let lockCount = 0;
      const lockedWrites: string[] = [];
      const finalizer = createRtcBaselineFinalizedEvidence(
        finalizationDependencies({
          withFinalizationLock: async (
            _baselineId: string,
            operation: (writer: RtcBaselineFinalizationLockedWriter) => Promise<unknown>,
          ) => {
            expect(active).toBe(false);
            active = true;
            lockCount += 1;
            try {
              return await operation({
                publishSummary: async () => {
                  expect(active).toBe(true);
                  lockedWrites.push('summary');
                  return publication === 'success'
                    ? { ok: true as const, value: undefined }
                    : {
                        ok: false as const,
                        issues: [{ path: '$.summary', code: 'write-failed', message: 'disk full' }],
                      };
                },
                writeFinalizationFailure: async () => {
                  expect(active).toBe(true);
                  lockedWrites.push('failure');
                  return { ok: true as const, value: undefined };
                },
              });
            } finally {
              active = false;
            }
          },
          publishSummary: async () => {
            throw new Error('outer publish must not be used');
          },
          writeFinalizationFailure: async () => {
            throw new Error('outer failure write must not be used');
          },
        }),
      );
      const result = await finalizer.finalize({
        baselineId: '20260807-0123456789ab-e1-local',
      });
      expect({ publication, lockCount, active, lockedWrites, ok: result.ok }).toEqual({
        publication,
        lockCount: 1,
        active: false,
        lockedWrites: publication === 'success' ? ['summary'] : ['summary', 'failure'],
        ok: publication === 'success',
      });
    }
  });
  it.each([
    [
      {
        collectArtifacts: async () => ({
          ok: false,
          issues: [{ path: '$.collect', code: 'read-failed', message: 'read failed' }],
        }),
      },
      { path: '$.collect', code: 'read-failed', message: 'read failed' },
      'finalization-artifact-collection',
    ],
    [
      {
        collectArtifacts: async () => ({ ok: true, value: collectedWithRawSample }),
        readBytes: async () => ({
          ok: false,
          issues: [{ path: '$.raw', code: 'read-failed', message: 'raw failed' }],
        }),
      },
      { path: '$.raw', code: 'read-failed', message: 'raw failed' },
      'finalization-raw-reference',
    ],
    [
      {
        collectArtifacts: async () => ({
          ok: true,
          value: {
            ...emptyCollected,
            artifactIssues: [
              {
                path: '$.samples[0].runtimeObservation',
                code: 'missing-runtime-observation',
                message: 'Metric samples require observation.',
              },
            ],
          },
        }),
      },
      {
        path: '$.samples[0].runtimeObservation',
        code: 'missing-runtime-observation',
        message: 'Metric samples require observation.',
      },
      'finalization-artifact-validation',
    ],
    [
      {
        partitionMetricObservations: () => ({
          ok: false,
          issues: [{ path: '$.groups', code: 'mixed-group', message: 'group changed' }],
        }),
      },
      { path: '$.groups', code: 'mixed-group', message: 'group changed' },
      'finalization-statistics',
    ],
    [
      {
        publishSummary: async () => ({
          ok: false,
          issues: [{ path: '$.summary', code: 'write-failed', message: 'summary failed' }],
        }),
      },
      { path: '$.summary', code: 'write-failed', message: 'summary failed' },
      'finalization-summary-publication',
    ],
    [
      {
        collectArtifacts: async () => ({ ok: true, value: collectedWithRawSample }),
        sha256: async () => {
          throw new Error('hash failed');
        },
      },
      { path: '$.rawReferences[0].sha256', code: 'hash-failed', message: 'hash failed' },
      'finalization-raw-reference',
    ],
  ] as const)('persists exact finalization failure %#', async (overrides, issue, failureId) => {
    const writeFailure = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const finalizer = createRtcBaselineFinalizedEvidence(
      finalizationDependencies({ ...overrides, writeFinalizationFailure: writeFailure }),
    );
    expect(await finalizer.finalize({ baselineId: '20260807-0123456789ab-e1-local' })).toEqual({
      ok: false,
      issues: [issue],
    });
    expect(writeFailure).toHaveBeenCalledWith('20260807-0123456789ab-e1-local', {
      schema: 'rallar.rtc-baseline.finalization-failure.v1',
      baselineId: '20260807-0123456789ab-e1-local',
      failureId,
      issues: [issue],
      rawEvidence: null,
    });
  });
  it('returns both publication and failure-artifact persistence issues', async () => {
    const finalizer = createRtcBaselineFinalizedEvidence(
      finalizationDependencies({
        publishSummary: async () => ({
          ok: false,
          issues: [{ path: '$.summary', code: 'write-failed', message: 'summary failed' }],
        }),
        writeFinalizationFailure: async () => ({
          ok: false,
          issues: [{ path: '$.failure', code: 'write-failed', message: 'failure failed' }],
        }),
      }),
    );
    expect(await finalizer.finalize({ baselineId: '20260807-0123456789ab-e1-local' })).toEqual({
      ok: false,
      issues: [
        { path: '$.summary', code: 'write-failed', message: 'summary failed' },
        { path: '$.failure', code: 'write-failed', message: 'failure failed' },
      ],
    });
  });
});
