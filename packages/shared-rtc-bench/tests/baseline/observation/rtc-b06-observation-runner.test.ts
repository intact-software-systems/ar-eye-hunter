import { describe, expect, it, vi } from 'vitest';

import { createRtcB06ObservationRunner, type RtcB06ObservationRunnerDependencies } from '../../../baseline/observation/rtc-b06-observation-runner.ts';

const source = {
    commit: 'c0cadb8216cf27d82a3143755e6965f3831ea164',
    tree: 'd45ae178384826f49fa31ab1e52c0f66d8ff069a'
};
const workflow = {
    sourceRef: 'main' as const,
    githubRunId: 987654321,
    githubRunAttempt: 3,
    githubRunUrl: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/987654321',
    outputDirectory: 'tmp/rtc-b06-observation'
};
const attempts = [
    {
        workloadId: 'RTC-B06' as const,
        caseId: 'default',
        inputKey: 'e3-memory-default',
        intendedPhase: 'warmup' as const,
        outerOrdinal: 1,
        environmentId: 'E3-memory' as const,
        rawResultRelativePath: 'artifacts/staging/rtc-b06-default-e3-memory-default-warmup-001.json'
    },
    {
        workloadId: 'RTC-B06' as const,
        caseId: 'all-scenarios',
        inputKey: 'e3-memory-all-scenarios',
        intendedPhase: 'retained' as const,
        outerOrdinal: 1,
        environmentId: 'E3-memory' as const,
        rawResultRelativePath: 'artifacts/staging/rtc-b06-all-scenarios-e3-memory-all-scenarios-retained-001.json'
    },
    {
        workloadId: 'RTC-B06' as const,
        caseId: 'retention-100',
        inputKey: 'e3-memory-retention-100',
        intendedPhase: 'retained' as const,
        outerOrdinal: 3,
        environmentId: 'E3-memory' as const,
        rawResultRelativePath: 'artifacts/staging/rtc-b06-retention-100-e3-memory-retention-100-retained-003.json'
    }
];

function success<Value>(value: Value) {
    return { ok: true as const, value };
}

function finalizedSummary(outcome: 'passed' | 'failed' = 'passed') {
    return {
        schema: 'rallar.rtc-baseline.summary.v1' as const,
        baselineId: '',
        workloadIds: ['RTC-B06'] as const,
        environmentId: 'E3-memory' as const,
        repeatLink: null,
        conditionalEnvironmentDecisions: [
            {
                environmentId: 'E4-pg' as const,
                decision: 'not-required' as const,
                reason: 'E3-memory observation only; no database-backed candidate is being selected.'
            }
        ],
        sampleOutcomes: [
            {
                identity: {
                    sampleId: 'rtc-b06-default-e3-memory-default-retained-001-001',
                    workloadId: 'RTC-B06' as const,
                    caseId: 'default',
                    inputKey: 'e3-memory-default',
                    intendedPhase: 'retained' as const,
                    outerOrdinal: 1,
                    innerOrdinal: 1
                },
                outcome,
                issues: outcome === 'passed'
                    ? []
                    : [{ path: '$.producer', code: 'producer-failed', message: 'failed' }]
            }
        ],
        cohortOutcomes: [
            {
                identity: {
                    cohortId: 'rtc-b06-e3-memory-retention',
                    workloadId: 'RTC-B06' as const,
                    memberSampleIds: [
                        'rtc-b06-retention-100-e3-memory-retention-100-retained-001-001'
                    ]
                },
                outcome,
                issues: outcome === 'passed'
                    ? []
                    : [{ path: '$.producer', code: 'producer-failed', message: 'failed' }]
            }
        ],
        metricSummaries: outcome === 'passed'
            ? [
                {
                    workloadId: 'RTC-B06' as const,
                    caseId: 'default',
                    inputKey: 'e3-memory-default',
                    metric: 'durationMs',
                    unit: 'ms',
                    count: 1,
                    minimum: 1,
                    median: 1,
                    maximum: 1,
                    mad: 0,
                    coefficientOfVariation: 0
                }
            ]
            : [],
        rawReferences: []
    };
}

function dependencies() {
    const calls: string[] = [];
    const primaryArtifacts = new Map([['summary.json', new Uint8Array([1])]]);
    const envelope: RtcB06ObservationRunnerDependencies['envelope'] = {
        initializeBaseline: vi.fn(async () => {
            calls.push('initialize');
            return success(undefined);
        }),
        readExternalAttempts: vi.fn(async () => {
            calls.push('list-external-attempts');
            return success(attempts);
        }),
        recordExternalAttempt: vi.fn(async () => {
            calls.push('record-external');
            return success({ acceptedSampleCount: 1 });
        }),
        recordExternalCohortAssertion: vi.fn(async () => {
            calls.push('record-external-cohort');
            return success({ acceptedCohortCount: 1 });
        }),
        finalize: vi.fn(async () => {
            calls.push('finalize');
            return success(finalizedSummary());
        }),
        readBaselineValidation: vi.fn(async () => {
            calls.push('validate');
            return success({ baselineId: '', retainedArtifactPaths: [], checksumEntryCount: 0 });
        }),
        readRepeatRequirement: vi.fn(async () => {
            calls.push('repeat-required');
            return success({ workloadIds: [] });
        })
    };
    const configured: RtcB06ObservationRunnerDependencies = {
        envelope,
        preflight: vi.fn(async () => {
            calls.push('preflight');
            return success(undefined);
        }),
        readSource: vi.fn(async () => {
            calls.push('read-source');
            return success(source);
        }),
        runLiveRtcProducer: vi.fn(async ({ attempt }) => {
            calls.push(`producer:${attempt.caseId}`);
            return { exitStatus: 0 };
        }),
        readFinalizedArtifacts: vi.fn(async () => {
            calls.push('read-finalized-artifacts');
            return success(primaryArtifacts);
        }),
        createArchive: vi.fn(async ({ observation }) => {
            calls.push('archive');
            return success({
                bytes: new Uint8Array([1, 2, 3]),
                indexEntry: {
                    schema: 'rallar.rtc-b06-performance-observation.index-entry.v1' as const,
                    observation,
                    archive: {
                        path: `performance-observations/rtc-b06/2026/08/30/${observation.observationId}.zip`,
                        byteLength: 3,
                        sha256: 'a'.repeat(64)
                    }
                }
            });
        }),
        writeOutput: vi.fn(async () => {
            calls.push('write-output');
            return success({
                archivePath: 'rtc-b06-observation.zip',
                indexEntryPath: 'index-entry.jsonl'
            });
        }),
        nowUtc: vi.fn()
            .mockReturnValueOnce('2026-08-30T10:00:00.417Z')
            .mockReturnValue('2026-08-30T10:30:00.417Z')
    };
    return { calls, configured };
}

describe('RTC-B06 observation runner', () => {
    it('captures the predeclared E3 attempts and retention cohort before publishing accepted evidence', async () => {
        const { calls, configured } = dependencies();

        const result = await createRtcB06ObservationRunner(configured).run(workflow);

        expect(result).toMatchObject({
            ok: true,
            value: {
                observation: {
                    schema: 'rallar.rtc-b06-performance-observation.v1',
                    observationId: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3',
                    source: { ...source, ref: 'main' },
                    primary: { outcome: 'passed', acceptedMetrics: true },
                    repeat: { decision: 'not-required', outcome: 'not-run' }
                }
            }
        });
        expect(configured.envelope.initializeBaseline).toHaveBeenCalledWith({
            schema: 'rallar.rtc-baseline.capture-request.v1',
            baselineId: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3',
            workloadIds: ['RTC-B06'],
            environmentId: 'E3-memory',
            retainedSampleMultiplier: 1,
            repeatLink: null,
            conditionalEnvironmentDecisions: [
                {
                    environmentId: 'E4-pg',
                    decision: 'not-required',
                    reason: 'E3-memory observation only; no database-backed candidate is being selected.'
                }
            ]
        });
        expect(configured.runLiveRtcProducer).toHaveBeenCalledTimes(3);
        expect(configured.envelope.recordExternalAttempt).toHaveBeenCalledTimes(3);
        expect(configured.envelope.recordExternalCohortAssertion).toHaveBeenCalledWith({
            baselineId: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3',
            workloadId: 'RTC-B06',
            cohortId: 'rtc-b06-e3-memory-retention',
            producerExitStatus: 0,
            rawResultRelativePath: 'artifacts/staging/rtc-b06-e3-memory-retention.json'
        });
        expect(calls).toEqual([
            'preflight',
            'read-source',
            'initialize',
            'list-external-attempts',
            'producer:default',
            'record-external',
            'producer:all-scenarios',
            'record-external',
            'producer:retention-100',
            'record-external',
            'record-external-cohort',
            'finalize',
            'validate',
            'repeat-required',
            'read-finalized-artifacts',
            'archive',
            'write-output'
        ]);
    });

    it('captures one controlled double-sample repeat when E3 requires it', async () => {
        const { calls, configured } = dependencies();
        vi.mocked(configured.envelope.readRepeatRequirement).mockImplementation(async () => {
            calls.push('repeat-required');
            return success({ workloadIds: ['RTC-B06'] });
        });

        const result = await createRtcB06ObservationRunner(configured).run(workflow);

        expect(result).toMatchObject({
            ok: true,
            value: {
                observation: {
                    repeat: { decision: 'required', outcome: 'passed' }
                }
            }
        });
        expect(configured.envelope.initializeBaseline).toHaveBeenLastCalledWith({
            schema: 'rallar.rtc-baseline.capture-request.v1',
            baselineId: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3-repeat-01',
            workloadIds: ['RTC-B06'],
            environmentId: 'E3-memory',
            retainedSampleMultiplier: 2,
            repeatLink: null,
            conditionalEnvironmentDecisions: [
                {
                    environmentId: 'E4-pg',
                    decision: 'not-required',
                    reason: 'E3-memory observation only; no database-backed candidate is being selected.'
                }
            ],
            repeatOf: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3'
        });
        expect(configured.createArchive).toHaveBeenCalledWith(
            expect.objectContaining({ repeatArtifacts: expect.any(Map) })
        );
        expect(calls.filter((call) => call.startsWith('producer:'))).toHaveLength(6);
        expect(calls.filter((call) => call === 'record-external-cohort')).toHaveLength(2);
        expect(calls).toEqual([
            'preflight',
            'read-source',
            'initialize',
            'list-external-attempts',
            'producer:default',
            'record-external',
            'producer:all-scenarios',
            'record-external',
            'producer:retention-100',
            'record-external',
            'record-external-cohort',
            'finalize',
            'validate',
            'repeat-required',
            'initialize',
            'list-external-attempts',
            'producer:default',
            'record-external',
            'producer:all-scenarios',
            'record-external',
            'producer:retention-100',
            'record-external',
            'record-external-cohort',
            'finalize',
            'read-finalized-artifacts',
            'read-finalized-artifacts',
            'archive',
            'write-output'
        ]);
    });

    it('archives a producer failure without accepting metrics or selecting a repeat', async () => {
        const { calls, configured } = dependencies();
        vi.mocked(configured.runLiveRtcProducer).mockImplementation(async ({ attempt }) => {
            calls.push(`producer:${attempt.caseId}`);
            return { exitStatus: 9 };
        });
        vi.mocked(configured.envelope.recordExternalAttempt).mockImplementation(async () => {
            calls.push('record-external');
            return {
                ok: false,
                issues: [{ path: '$.producer', code: 'producer-failed', message: 'failed' }]
            };
        });
        vi.mocked(configured.envelope.finalize).mockImplementation(async () => {
            calls.push('finalize');
            return success(finalizedSummary('failed'));
        });

        const result = await createRtcB06ObservationRunner(configured).run(workflow);

        expect(result).toMatchObject({
            ok: true,
            value: {
                observation: {
                    primary: { outcome: 'failed', acceptedMetrics: false },
                    repeat: { decision: 'not-required', outcome: 'not-run' }
                }
            }
        });
        expect(calls).toEqual([
            'preflight',
            'read-source',
            'initialize',
            'list-external-attempts',
            'producer:default',
            'record-external',
            'finalize',
            'read-finalized-artifacts',
            'archive',
            'write-output'
        ]);
    });
});
