import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { runRtcBaselineCli } from '../../../baseline/command/run-rtc-baseline-cli.ts';
import { writeRtcBaselineCliOutput } from '../../../baseline/command/write-rtc-baseline-cli-output.ts';
import type { RtcPerformanceObservationCliDependencies } from '../../../baseline/observation/rtc-performance-observation-cli.ts';
import type { RtcBaselineEnvelope } from '../../../baseline/runtime/rtc-baseline-envelope.ts';

const conclusiveComparison = {
    outcome: 'conclusive',
    primary: {
        primaryBaselineId: '20260807-0123456789ab-e1-local',
        comparisonBaselineId: '20260807-0123456789ab-e1-local',
        repeatRequired: false
    },
    candidate: {
        primaryBaselineId: '20260808-fedcba987654-e1-local',
        comparisonBaselineId: '20260808-fedcba987654-e1-local',
        repeatRequired: false
    },
    comparisons: []
} as const;
const emptyFinalizedSummary = {
    schema: 'rallar.rtc-baseline.summary.v1' as const,
    baselineId: '20260807-0123456789ab-e1-local',
    workloadIds: ['RTC-B01'] as const,
    environmentId: 'E1-local' as const,
    repeatLink: null,
    conditionalEnvironmentDecisions: [],
    sampleOutcomes: [],
    cohortOutcomes: [],
    metricSummaries: [],
    rawReferences: []
};

function createEnvelope() {
    return {
        initializeBaseline: vi.fn<RtcBaselineEnvelope['initializeBaseline']>(async () => ({ ok: true, value: undefined })),
        captureWorkload: vi.fn<RtcBaselineEnvelope['captureWorkload']>(async () => ({ ok: true, value: { acceptedSampleCount: 0 } })),
        readExternalAttempts: vi.fn<RtcBaselineEnvelope['readExternalAttempts']>(async () => ({ ok: true, value: [] })),
        recordBrowser: vi.fn<RtcBaselineEnvelope['recordBrowser']>(async () => ({ ok: true, value: { acceptedSampleCount: 0 } })),
        recordExternalAttempt: vi.fn<RtcBaselineEnvelope['recordExternalAttempt']>(async () => ({ ok: true, value: { acceptedSampleCount: 0 } })),
        recordExternalCohortAssertion: vi.fn<RtcBaselineEnvelope['recordExternalCohortAssertion']>(async () => ({
            ok: true,
            value: { acceptedCohortCount: 0 }
        })),
        readRepeatRequirement: vi.fn<RtcBaselineEnvelope['readRepeatRequirement']>(async () => ({ ok: true, value: { workloadIds: [] } })),
        readPairedComparison: vi.fn<RtcBaselineEnvelope['readPairedComparison']>(async () => ({ ok: true, value: conclusiveComparison })),
        readBaselineValidation: vi.fn<RtcBaselineEnvelope['readBaselineValidation']>(async () => ({
            ok: true,
            value: { baselineId: '', retainedArtifactPaths: [], checksumEntryCount: 0 }
        })),
        readVerifiedRepeatPrimary: vi.fn<RtcBaselineEnvelope['readVerifiedRepeatPrimary']>(async () => {
            throw new Error('CLI does not directly read verified repeat primaries');
        }),
        finalize: vi.fn<RtcBaselineEnvelope['finalize']>(async () => ({ ok: true, value: emptyFinalizedSummary }))
    };
}

async function run(
    args: readonly string[],
    envelope = createEnvelope(),
    observation?: RtcPerformanceObservationCliDependencies
) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runRtcBaselineCli({
        args,
        envelope,
        observation,
        writeStdout: (value) => stdout.push(value),
        writeStderr: (value) => stderr.push(value)
    });
    return { exitCode, stdout, stderr, envelope };
}

describe('RTC baseline CLI application', () => {
    it('routes observation commands through the package observation CLI', async () => {
        const runObservation = vi.fn(async () => ({
            ok: true as const,
            value: {
                observation: { observationId: 'observation-id' },
                output: { archivePath: 'archive.zip', indexEntryPath: 'index-entry.jsonl' }
            }
        }));
        const observation: RtcPerformanceObservationCliDependencies = {
            browserRunner: { run: runObservation },
            liveRtcRunner: { run: vi.fn(), captureBaseline: vi.fn() },
            readFile: vi.fn(),
            verifyArchive: vi.fn()
        };

        const result = await run(
            [
                'observe-browser',
                '--source-ref=main',
                '--github-run-id=123',
                '--github-run-attempt=1',
                '--github-run-url=https://github.com/example/repository/actions/runs/123',
                '--output=tmp/observation'
            ],
            createEnvelope(),
            observation
        );

        expect(result).toMatchObject({
            exitCode: 0,
            stdout: [
                '{"observationId":"observation-id","archivePath":"archive.zip","indexEntryPath":"index-entry.jsonl"}\n'
            ],
            stderr: []
        });
    });

    it('writes the complete encoded value across partial synchronous writes', () => {
        const chunks: string[] = [];
        const decoder = new TextDecoder();

        writeRtcBaselineCliOutput(
            {
                writeSync(bytes) {
                    const written = Math.min(2, bytes.byteLength);
                    chunks.push(decoder.decode(bytes.subarray(0, written)));
                    return written;
                }
            },
            'complete'
        );

        expect(chunks.join('')).toBe('complete');
    });

    it('rejects a synchronous writer that makes no progress', () => {
        expect(() => writeRtcBaselineCliOutput({ writeSync: () => 0 }, 'blocked')).toThrow(
            'Synchronous output writer made no progress.'
        );
    });

    it('emits exactly four external-attempt TSV columns without inputKey', async () => {
        const envelope = createEnvelope();
        envelope.readExternalAttempts.mockResolvedValueOnce({
            ok: true,
            value: [
                {
                    workloadId: 'RTC-B05',
                    caseId: 'browser-data-channel-lifecycle',
                    inputKey: 'iterations-25',
                    intendedPhase: 'retained',
                    outerOrdinal: 3,
                    environmentId: 'E2-browser',
                    rawResultRelativePath: 'artifacts/staging/result.json'
                }
            ]
        });
        const result = await run(
            [
                'list-external-attempts',
                '--baseline-id=20260807-0123456789ab-e2-browser',
                '--workload=RTC-B05',
                '--format=tsv'
            ],
            envelope
        );
        expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
            exitCode: 0,
            stdout: ['browser-data-channel-lifecycle\tretained\t3\tE2-browser\n'],
            stderr: []
        });
        expect(result.stdout[0]?.split('\t')).toHaveLength(4);
        expect(result.stdout[0]).not.toContain('iterations-25');
    });

    it('maps repeat required, no-repeat, evidence failure, and usage exits', async () => {
        const triggered = createEnvelope();
        triggered.readRepeatRequirement.mockResolvedValueOnce({ ok: true, value: { workloadIds: ['RTC-B03', 'RTC-B01'] } });
        const triggeredResult = await run(
            ['repeat-required', '--baseline-id=20260807-0123456789ab-e1-local', '--format=workload-csv'],
            triggered
        );
        expect({
            exitCode: triggeredResult.exitCode,
            stdout: triggeredResult.stdout,
            stderr: triggeredResult.stderr
        }).toEqual({ exitCode: 0, stdout: ['RTC-B01,RTC-B03\n'], stderr: [] });
        const quiet = createEnvelope();
        quiet.readRepeatRequirement.mockResolvedValueOnce({ ok: true, value: { workloadIds: [] } });
        const quietResult = await run(
            ['repeat-required', '--baseline-id=20260807-0123456789ab-e1-local', '--format=workload-csv'],
            quiet
        );
        expect({
            exitCode: quietResult.exitCode,
            stdout: quietResult.stdout,
            stderr: quietResult.stderr
        }).toEqual({ exitCode: 3, stdout: [], stderr: [] });
        const failed = createEnvelope();
        failed.readBaselineValidation.mockResolvedValueOnce({
            ok: false,
            issues: [{ path: '$', code: 'invalid-evidence', message: 'Incomplete.' }]
        });
        const failedResult = await run(
            ['validate', '--baseline-id=20260807-0123456789ab-e1-local'],
            failed
        );
        expect({
            exitCode: failedResult.exitCode,
            stdout: failedResult.stdout,
            stderr: failedResult.stderr
        }).toEqual({
            exitCode: 1,
            stdout: [],
            stderr: ['[{"path":"$","code":"invalid-evidence","message":"Incomplete."}]\n']
        });
        const usageResult = await run(['unknown']);
        expect({
            exitCode: usageResult.exitCode,
            stdout: usageResult.stdout,
            stderr: usageResult.stderr
        }).toEqual({
            exitCode: 64,
            stdout: [],
            stderr: [
                '[{"path":"$.args[0]","code":"unknown-subcommand","message":"Unknown RTC baseline subcommand unknown."}]\n'
            ]
        });
    });

    it('writes only paired comparison JSON to stdout on success', async () => {
        const envelope = createEnvelope();
        envelope.readPairedComparison.mockResolvedValueOnce({
            ok: true,
            value: conclusiveComparison
        });
        const result = await run(
            [
                'compare-paired',
                '--baseline-id=20260807-0123456789ab-e1-local',
                '--comparison-baseline-id=20260808-fedcba987654-e1-local',
                '--primary-cohort-id=20260807-0123456789ab-e1-local',
                '--comparison-cohort-id=20260808-fedcba987654-e1-local',
                '--workload=RTC-B01'
            ],
            envelope
        );
        expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
            exitCode: 0,
            stdout: [
                '{"outcome":"conclusive","primary":{"primaryBaselineId":"20260807-0123456789ab-e1-local","comparisonBaselineId":"20260807-0123456789ab-e1-local","repeatRequired":false},"candidate":{"primaryBaselineId":"20260808-fedcba987654-e1-local","comparisonBaselineId":"20260808-fedcba987654-e1-local","repeatRequired":false},"comparisons":[]}\n'
            ],
            stderr: []
        });
    });

    it('emits a still-noisy comparison with its anchors and exits nonzero', async () => {
        const value = {
            outcome: 'inconclusive-still-noisy',
            primary: {
                primaryBaselineId: '20260807-0123456789ab-e1-local',
                comparisonBaselineId: '20260807-0123456789ab-e1-local-repeat-01',
                repeatRequired: true
            },
            candidate: {
                primaryBaselineId: '20260808-fedcba987654-e1-local',
                comparisonBaselineId: '20260808-fedcba987654-e1-local',
                repeatRequired: false
            },
            comparisons: [],
            issues: [
                {
                    path: '$.metricSummaries',
                    code: 'repeat-still-noisy',
                    message: 'Controlled repeat remains above its coefficient-of-variation threshold.'
                }
            ]
        } as const;
        const envelope = createEnvelope();
        envelope.readPairedComparison.mockResolvedValueOnce({ ok: true, value });
        const result = await run(
            [
                'compare-paired',
                '--baseline-id=20260807-0123456789ab-e1-local',
                '--comparison-baseline-id=20260808-fedcba987654-e1-local',
                '--primary-cohort-id=20260807-0123456789ab-e1-local-repeat-01',
                '--comparison-cohort-id=20260808-fedcba987654-e1-local',
                '--workload=RTC-B01'
            ],
            envelope
        );
        expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
            exitCode: 2,
            stdout: [`${JSON.stringify(value)}\n`],
            stderr: []
        });
    });

    it('dispatches all ten commands with exact typed envelope arguments', async () => {
        const envelope = createEnvelope();
        const outputs: Array<{ exitCode: number; stdout: string[]; stderr: string[]; }> = [];
        const dispatch = async (args: readonly string[]) => {
            const { exitCode, stdout, stderr } = await run(args, envelope);
            outputs.push({ exitCode, stdout, stderr });
        };
        await dispatch([
            'initialize',
            '--baseline-id=20260807-0123456789ab-e1-local',
            '--workloads=RTC-B01',
            '--environment=E1-local'
        ]);
        await dispatch([
            'capture',
            '--baseline-id=20260807-0123456789ab-e1-local',
            '--workload=RTC-B01'
        ]);
        envelope.readExternalAttempts.mockResolvedValueOnce({ ok: true, value: [] });
        await dispatch([
            'list-external-attempts',
            '--baseline-id=20260807-0123456789ab-e2-browser',
            '--workload=RTC-B05',
            '--format=tsv'
        ]);
        await dispatch([
            'record-browser',
            '--baseline-id=20260807-0123456789ab-e2-browser',
            '--workload=RTC-B05',
            '--case-id=browser-data-channel-lifecycle',
            '--input-key=iterations-25',
            '--intended-phase=retained',
            '--outer-ordinal=1',
            '--producer-exit-status=0',
            '--raw-result=artifacts/staging/browser.json'
        ]);
        await dispatch([
            'record-external',
            '--baseline-id=20260807-0123456789ab-e3-memory',
            '--workload=RTC-B06',
            '--case-id=default',
            '--input-key=e3-memory-default',
            '--intended-phase=retained',
            '--outer-ordinal=1',
            '--producer-exit-status=0',
            '--raw-result=artifacts/staging/external.json'
        ]);
        await dispatch([
            'record-external-cohort',
            '--baseline-id=20260807-0123456789ab-e3-memory',
            '--workload=RTC-B06',
            '--cohort-id=rtc-b06-e3-default',
            '--producer-exit-status=0',
            '--raw-result=artifacts/staging/cohort.json'
        ]);
        envelope.readRepeatRequirement.mockResolvedValueOnce({
            ok: true,
            value: { workloadIds: ['RTC-B01'] }
        });
        await dispatch([
            'repeat-required',
            '--baseline-id=20260807-0123456789ab-e1-local',
            '--format=workload-csv'
        ]);
        envelope.readPairedComparison.mockResolvedValueOnce({
            ok: true,
            value: conclusiveComparison
        });
        await dispatch([
            'compare-paired',
            '--baseline-id=20260807-0123456789ab-e1-local',
            '--comparison-baseline-id=20260808-fedcba987654-e1-local',
            '--primary-cohort-id=20260807-0123456789ab-e1-local',
            '--comparison-cohort-id=20260808-fedcba987654-e1-local',
            '--workload=RTC-B01'
        ]);
        await dispatch(['validate', '--baseline-id=20260807-0123456789ab-e1-local']);
        await dispatch(['finalize', '--baseline-id=20260807-0123456789ab-e1-local']);

        expect(outputs).toEqual([
            { exitCode: 0, stdout: [], stderr: [] },
            { exitCode: 0, stdout: [], stderr: [] },
            { exitCode: 0, stdout: [], stderr: [] },
            { exitCode: 0, stdout: [], stderr: [] },
            { exitCode: 0, stdout: [], stderr: [] },
            { exitCode: 0, stdout: [], stderr: [] },
            { exitCode: 0, stdout: ['RTC-B01\n'], stderr: [] },
            {
                exitCode: 0,
                stdout: [
                    '{"outcome":"conclusive","primary":{"primaryBaselineId":"20260807-0123456789ab-e1-local","comparisonBaselineId":"20260807-0123456789ab-e1-local","repeatRequired":false},"candidate":{"primaryBaselineId":"20260808-fedcba987654-e1-local","comparisonBaselineId":"20260808-fedcba987654-e1-local","repeatRequired":false},"comparisons":[]}\n'
                ],
                stderr: []
            },
            { exitCode: 0, stdout: [], stderr: [] },
            { exitCode: 0, stdout: [], stderr: [] }
        ]);

        expect(envelope.initializeBaseline).toHaveBeenCalledWith({
            schema: 'rallar.rtc-baseline.capture-request.v1',
            baselineId: '20260807-0123456789ab-e1-local',
            workloadIds: ['RTC-B01'],
            environmentId: 'E1-local',
            retainedSampleMultiplier: 1,
            repeatLink: null,
            conditionalEnvironmentDecisions: []
        });
        expect(envelope.captureWorkload).toHaveBeenCalledWith({
            baselineId: '20260807-0123456789ab-e1-local',
            workloadId: 'RTC-B01'
        });
        expect(envelope.readExternalAttempts).toHaveBeenCalledWith({
            baselineId: '20260807-0123456789ab-e2-browser',
            workloadId: 'RTC-B05'
        });
        expect(envelope.recordBrowser).toHaveBeenCalledWith({
            baselineId: '20260807-0123456789ab-e2-browser',
            locator: {
                workloadId: 'RTC-B05',
                caseId: 'browser-data-channel-lifecycle',
                inputKey: 'iterations-25',
                intendedPhase: 'retained',
                outerOrdinal: 1
            },
            producerExitStatus: 0,
            rawResultRelativePath: 'artifacts/staging/browser.json'
        });
        expect(envelope.recordExternalAttempt).toHaveBeenCalledWith({
            baselineId: '20260807-0123456789ab-e3-memory',
            locator: {
                workloadId: 'RTC-B06',
                caseId: 'default',
                inputKey: 'e3-memory-default',
                intendedPhase: 'retained',
                outerOrdinal: 1
            },
            producerExitStatus: 0,
            rawResultRelativePath: 'artifacts/staging/external.json'
        });
        expect(envelope.recordExternalCohortAssertion).toHaveBeenCalledWith({
            baselineId: '20260807-0123456789ab-e3-memory',
            workloadId: 'RTC-B06',
            cohortId: 'rtc-b06-e3-default',
            producerExitStatus: 0,
            rawResultRelativePath: 'artifacts/staging/cohort.json'
        });
        expect(envelope.readRepeatRequirement).toHaveBeenCalledWith({
            baselineId: '20260807-0123456789ab-e1-local'
        });
        expect(envelope.readPairedComparison).toHaveBeenCalledWith({
            primaryBaselineId: '20260807-0123456789ab-e1-local',
            candidateBaselineId: '20260808-fedcba987654-e1-local',
            primaryComparisonCohortId: '20260807-0123456789ab-e1-local',
            candidateComparisonCohortId: '20260808-fedcba987654-e1-local',
            workloadId: 'RTC-B01'
        });
        expect(envelope.readBaselineValidation).toHaveBeenCalledWith({
            baselineId: '20260807-0123456789ab-e1-local'
        });
        expect(envelope.finalize).toHaveBeenCalledWith({
            baselineId: '20260807-0123456789ab-e1-local'
        });
    });

    it('keeps imports side-effect free when import.meta.main is false', async () => {
        const writes: string[] = [];
        vi.stubGlobal('Deno', {
            args: ['validate', '--baseline-id=20260807-0123456789ab-e1-local'],
            stdout: {
                write: () => {
                    writes.push('stdout');
                }
            },
            stderr: {
                write: () => {
                    writes.push('stderr');
                }
            },
            exit: () => {
                writes.push('exit');
            }
        });
        try {
            // @ts-expect-error Vitest resolves the import-only query while TypeScript checks the base module.
            await import('../../../baseline/command/run-rtc-baseline-cli.ts?import-only');
            expect(writes).toEqual([]);
        }
        finally {
            vi.unstubAllGlobals();
        }
    });
});
