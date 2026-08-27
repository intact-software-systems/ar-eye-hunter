import { describe, expect, it, vi } from 'vitest';

import { createRtcB05ObservationRunner, type RtcB05ObservationRunnerDependencies } from '../../../baseline/observation/rtc-b05-observation-runner.ts';

const source = {
    commit: 'eaf526518c70e3b396dad91c008125a622b38b00',
    tree: '1111111111111111111111111111111111111111'
};
const workflow = {
    sourceRef: 'main' as const,
    githubRunId: 123456789,
    githubRunAttempt: 2,
    githubRunUrl: 'https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/123456789',
    outputDirectory: 'tmp/observation'
};
const attempt = {
    workloadId: 'RTC-B05' as const,
    caseId: 'browser-data-channel-lifecycle',
    inputKey: 'iterations-25',
    intendedPhase: 'retained' as const,
    outerOrdinal: 1,
    environmentId: 'E2-browser' as const,
    rawResultRelativePath: 'artifacts/staging/' +
        'rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001.json'
};
const sampleOutcome = {
    identity: {
        sampleId: 'rtc-b05-browser-data-channel-lifecycle-iterations-25-retained-001-001',
        workloadId: 'RTC-B05' as const,
        caseId: 'browser-data-channel-lifecycle',
        inputKey: 'iterations-25',
        intendedPhase: 'retained' as const,
        outerOrdinal: 1,
        innerOrdinal: 1
    },
    outcome: 'passed' as const,
    issues: []
};

function finalizedSummary(outcome: 'passed' | 'failed') {
    return {
        schema: 'rallar.rtc-baseline.summary.v1' as const,
        baselineId: '',
        workloadIds: ['RTC-B05'] as const,
        environmentId: 'E2-browser' as const,
        repeatLink: null,
        conditionalEnvironmentDecisions: [],
        sampleOutcomes: [
            outcome === 'passed'
                ? sampleOutcome
                : {
                    ...sampleOutcome,
                    outcome: 'failed' as const,
                    issues: [{ path: '$.producer', code: 'producer-failed', message: 'failed' }]
                }
        ],
        cohortOutcomes: [],
        metricSummaries: outcome === 'passed'
            ? [
                {
                    workloadId: 'RTC-B05' as const,
                    caseId: 'browser-data-channel-lifecycle',
                    inputKey: 'iterations-25',
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

function success<Value>(value: Value) {
    return { ok: true as const, value };
}

function failed() {
    return {
        ok: false as const,
        issues: [{ path: '$.producer', code: 'producer-failed', message: 'producer failed' }]
    };
}

function dependencies(overrides: Partial<RtcB05ObservationRunnerDependencies> = {}) {
    const calls: string[] = [];
    const primaryArtifacts = new Map([['summary.json', new Uint8Array([1])]]);
    const recordBrowser = vi.fn<RtcB05ObservationRunnerDependencies['envelope']['recordBrowser']>(
        async () => {
            calls.push('record-browser');
            return success({ acceptedSampleCount: 1 });
        }
    );
    const finalize = vi.fn<RtcB05ObservationRunnerDependencies['envelope']['finalize']>(
        async () => {
            calls.push('finalize');
            return success(finalizedSummary('passed'));
        }
    );
    const envelope: RtcB05ObservationRunnerDependencies['envelope'] = {
        initializeBaseline: vi.fn(async () => {
            calls.push('initialize');
            return success(undefined);
        }),
        readExternalAttempts: vi.fn(async () => {
            calls.push('list-external-attempts');
            return success([attempt]);
        }),
        recordBrowser,
        finalize,
        readBaselineValidation: vi.fn(async () => {
            calls.push('validate');
            return success({ baselineId: '', retainedArtifactPaths: [], checksumEntryCount: 0 });
        }),
        readRepeatRequirement: vi.fn(async () => {
            calls.push('repeat-required');
            return success({ workloadIds: [] });
        })
    };
    const configured: RtcB05ObservationRunnerDependencies = {
        envelope,
        preflight: vi.fn(async () => {
            calls.push('preflight');
            return success(undefined);
        }),
        readSource: vi.fn(async () => {
            calls.push('read-source');
            return success(source);
        }),
        runBrowserProducer: vi.fn(async () => {
            calls.push('browser-producer');
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
                    schema: 'rallar.rtc-performance-observation.index-entry.v1' as const,
                    observation,
                    archive: {
                        path: `performance-observations/rtc-b05/2026/08/27/${observation.observationId}.zip`,
                        byteLength: 3,
                        sha256: 'a'.repeat(64)
                    }
                }
            });
        }),
        writeOutput: vi.fn(async () => {
            calls.push('write-output');
            return success({ archivePath: 'observation.zip', indexEntryPath: 'index-entry.jsonl' });
        }),
        nowUtc: vi.fn()
            .mockReturnValueOnce('2026-08-27T03:15:00.417Z')
            .mockReturnValue('2026-08-27T03:18:00.417Z'),
        ...overrides
    };
    return { calls, configured, recordBrowser, finalize };
}

describe('RTC-B05 observation runner', () => {
    it('composes primary capture, validation, repeat policy, archive, and output owners', async () => {
        const { calls, configured } = dependencies();

        const result = await createRtcB05ObservationRunner(configured).run(workflow);

        expect(result).toMatchObject({
            ok: true,
            value: {
                observation: {
                    observationId: '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2',
                    source: { ...source, ref: 'main' },
                    primary: { outcome: 'passed', acceptedMetrics: true },
                    repeat: { decision: 'not-required', outcome: 'not-run' }
                }
            }
        });
        expect(calls).toEqual([
            'preflight',
            'read-source',
            'initialize',
            'list-external-attempts',
            'browser-producer',
            'record-browser',
            'finalize',
            'validate',
            'repeat-required',
            'read-finalized-artifacts',
            'archive',
            'write-output'
        ]);
    });

    it('does not initialize or archive when tooling preflight fails', async () => {
        const preflight = vi.fn(async () => failed());
        const { calls, configured } = dependencies({ preflight });

        expect(await createRtcB05ObservationRunner(configured).run(workflow)).toEqual(failed());
        expect(calls).toEqual([]);
        expect(configured.createArchive).not.toHaveBeenCalled();
        expect(configured.writeOutput).not.toHaveBeenCalled();
    });

    it('captures the existing controlled repeat only when repeat policy selects RTC-B05', async () => {
        const { calls, configured } = dependencies();
        configured.envelope.readRepeatRequirement = vi.fn(async () => {
            calls.push('repeat-required');
            return success({ workloadIds: ['RTC-B05' as const] });
        });
        const result = await createRtcB05ObservationRunner(configured).run(workflow);

        expect(result).toMatchObject({
            ok: true,
            value: {
                observation: { repeat: { decision: 'required', outcome: 'passed' } }
            }
        });
        expect(configured.envelope.initializeBaseline).toHaveBeenLastCalledWith(
            expect.objectContaining({
                baselineId: '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2-repeat-01',
                retainedSampleMultiplier: 2,
                repeatOf: '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2'
            })
        );
        expect(configured.createArchive).toHaveBeenCalledWith(
            expect.objectContaining({ repeatArtifacts: expect.any(Map) })
        );
        expect(calls).toEqual([
            'preflight',
            'read-source',
            'initialize',
            'list-external-attempts',
            'browser-producer',
            'record-browser',
            'finalize',
            'validate',
            'repeat-required',
            'initialize',
            'list-external-attempts',
            'browser-producer',
            'record-browser',
            'finalize',
            'read-finalized-artifacts',
            'read-finalized-artifacts',
            'archive',
            'write-output'
        ]);
    });

    it('finalizes and archives a producer failure without accepting metrics or selecting a repeat', async () => {
        const { calls, configured, recordBrowser, finalize } = dependencies();
        configured.runBrowserProducer = vi.fn(async () => {
            calls.push('browser-producer');
            return { exitStatus: 9 };
        });
        recordBrowser.mockImplementation(async () => {
            calls.push('record-browser');
            return failed();
        });
        finalize.mockImplementation(async () => {
            calls.push('finalize');
            return success(finalizedSummary('failed'));
        });

        const result = await createRtcB05ObservationRunner(configured).run(workflow);

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
            'browser-producer',
            'record-browser',
            'finalize',
            'read-finalized-artifacts',
            'archive',
            'write-output'
        ]);
    });
});
