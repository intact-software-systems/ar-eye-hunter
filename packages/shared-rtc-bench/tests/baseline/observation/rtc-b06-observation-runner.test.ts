import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { deriveRtcBaselineCaptureManifest, deriveRtcBaselineExternalAttempts } from '../../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import { decodeRtcBaselineCaptureRequest } from '../../../baseline/contracts/rtc-baseline-decoding.ts';
import { createRtcB06ObservationRunner, type RtcB06ObservationRunnerDependencies } from '../../../baseline/observation/rtc-b06-observation-runner.ts';
import type { RtcB06PerformanceObservation } from '../../../baseline/observation/rtc-b06-performance-observation.ts';
import type { RtcPerformanceObservationArchiveWritten } from '../../../baseline/observation/rtc-performance-observation-archive.ts';

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

const sampleIdentity = {
    sampleId: 'rtc-b06-default-e3-memory-default-retained-001-001',
    workloadId: 'RTC-B06' as const,
    caseId: 'default',
    inputKey: 'e3-memory-default',
    intendedPhase: 'retained' as const,
    outerOrdinal: 1,
    innerOrdinal: 1
};

const cohortIdentity = {
    cohortId: 'rtc-b06-e3-memory-retention',
    workloadId: 'RTC-B06' as const,
    memberSampleIds: [
        'rtc-b06-retention-100-e3-memory-retention-100-retained-001-001'
    ]
};

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
                identity: sampleIdentity,
                outcome,
                issues: outcome === 'passed'
                    ? []
                    : [{ path: '$.producer', code: 'producer-failed', message: 'failed' }]
            }
        ],
        cohortOutcomes: [
            {
                identity: cohortIdentity,
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
    const primaryArtifacts = new Map([['summary.json', new Uint8Array([1])]]);
    const envelope: RtcB06ObservationRunnerDependencies['envelope'] = {
        initializeBaseline: vi.fn(async () => {
            return success(undefined);
        }),
        readExternalAttempts: vi.fn(async () => {
            return success(attempts);
        }),
        recordExternalAttempt: vi.fn(async () => {
            return success({ acceptedSampleCount: 1 });
        }),
        recordExternalCohortAssertion: vi.fn(async () => {
            return success({ acceptedCohortCount: 1 });
        }),
        finalize: vi.fn(async () => {
            return success(finalizedSummary());
        }),
        readBaselineValidation: vi.fn(async () => {
            return success({ baselineId: '', retainedArtifactPaths: [], checksumEntryCount: 0 });
        }),
        readRepeatRequirement: vi.fn(async () => {
            return success({ workloadIds: [] });
        })
    };
    const configured: RtcB06ObservationRunnerDependencies = {
        envelope,
        preflight: vi.fn(async () => {
            return success(undefined);
        }),
        readSource: vi.fn(async () => {
            return success(source);
        }),
        runLiveRtcProducer: vi.fn(async () => {
            return { exitStatus: 0 };
        }),
        readFinalizedArtifacts: vi.fn(async () => {
            return success(primaryArtifacts);
        }),
        createArchive: vi.fn(async ({ observation }) => success(createArchiveFixture(observation))),
        writeOutput: vi.fn(async () => {
            return success({
                archivePath: 'rtc-b06-observation.zip',
                indexEntryPath: 'index-entry.jsonl'
            });
        }),
        nowUtc: vi.fn()
            .mockReturnValueOnce('2026-08-30T10:00:00.417Z')
            .mockReturnValue('2026-08-30T10:30:00.417Z')
    };
    return { configured };
}

function createArchiveFixture(observation: RtcB06PerformanceObservation): RtcPerformanceObservationArchiveWritten {
    return {
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
    };
}

describe('RTC-B06 governed branch baseline', () => {
    it.each([false, true])('runs the full declared primary and only the canonically required repeat (%s)', async (requiredRepeat) => {
        const { configured } = dependencies();
        const produced: Array<{ baselineId: string; caseId: string; phase: string; ordinal: number; }> = [];
        let manifest: ReturnType<typeof deriveRtcBaselineCaptureManifest>;
        configured.envelope.initializeBaseline = async (request) => {
            const captureRequest = typeof request === 'object' && request !== null
                ? Object.fromEntries(Object.entries(request).filter(([field]) => field !== 'repeatOf'))
                : request;
            const decoded = decodeRtcBaselineCaptureRequest(captureRequest);
            if (!decoded.ok) {
                throw new Error(JSON.stringify(decoded.issues));
            }
            manifest = deriveRtcBaselineCaptureManifest(decoded.value);
            return success(undefined);
        };
        configured.envelope.readExternalAttempts = async () => success(deriveRtcBaselineExternalAttempts(manifest, 'RTC-B06'));
        configured.envelope.readRepeatRequirement = async () => success({ workloadIds: requiredRepeat ? ['RTC-B06'] : [] });
        configured.runLiveRtcProducer = async ({ baselineId, attempt }) => {
            produced.push({ baselineId, caseId: attempt.caseId, phase: attempt.intendedPhase, ordinal: attempt.outerOrdinal });
            return { exitStatus: 0 };
        };
        configured.createArchive = async () => {
            throw new Error('Branch capture must never create a permanent archive');
        };
        configured.writeOutput = async () => {
            throw new Error('Branch capture must never write a publication index');
        };
        const runner = createRtcB06ObservationRunner(configured);
        const result = await runner.captureBaseline({ ...workflow, sourceRef: 'codex/rtc-baseline-refresh' });
        expect(result).toMatchObject({
            ok: true,
            value: {
                baselineId: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3',
                source: { ...source, ref: 'codex/rtc-baseline-refresh' },
                primaryOutcome: 'passed',
                acceptedMetrics: true,
                repeatDecision: requiredRepeat ? 'required' : 'not-required',
                repeatOutcome: requiredRepeat ? 'passed' : 'not-run'
            }
        });
        const primary = produced.filter((attempt) => !attempt.baselineId.endsWith('-repeat-01'));
        expect(primary.map(({ caseId, phase, ordinal }) => `${caseId}/${phase}/${ordinal}`)).toEqual([
            'default/warmup/1',
            'default/retained/1',
            'default/retained/2',
            'default/retained/3',
            'default/retained/4',
            'default/retained/5',
            'all-scenarios/warmup/1',
            'all-scenarios/retained/1',
            'all-scenarios/retained/2',
            'all-scenarios/retained/3',
            'retention-100/warmup/1',
            'retention-100/retained/1',
            'retention-100/retained/2',
            'retention-100/retained/3'
        ]);
        const repeat = produced.filter((attempt) => attempt.baselineId.endsWith('-repeat-01'));
        expect(repeat.length).toBe(requiredRepeat ? 25 : 0);
        if (requiredRepeat) {
            expect(repeat.filter(({ phase }) => phase === 'warmup').length).toBe(3);
            expect(repeat.filter(({ caseId, phase }) => caseId === 'default' && phase === 'retained').length).toBe(10);
            expect(repeat.filter(({ caseId, phase }) => caseId === 'all-scenarios' && phase === 'retained').length).toBe(6);
            expect(repeat.filter(({ caseId, phase }) => caseId === 'retention-100' && phase === 'retained').length).toBe(6);
        }
    });

    it('keeps failed primary evidence unaccepted and never selects a repeat or publishes', async () => {
        const { configured } = dependencies();
        configured.runLiveRtcProducer = async () => ({ exitStatus: 9 });
        configured.envelope.recordExternalAttempt = async () => ({ ok: false, issues: [{ path: '$.producer', code: 'producer-failed', message: 'failed' }] });
        configured.envelope.finalize = async () => success(finalizedSummary('failed'));
        configured.envelope.readRepeatRequirement = async () => {
            throw new Error('Failed primary must not select a repeat');
        };
        configured.createArchive = async () => {
            throw new Error('Branch capture must never publish');
        };
        const runner = createRtcB06ObservationRunner(configured);
        expect(await runner.captureBaseline({ ...workflow, sourceRef: 'codex/rtc-baseline-refresh' })).toMatchObject({
            ok: true,
            value: { primaryOutcome: 'failed', acceptedMetrics: false, repeatDecision: 'not-required', repeatOutcome: 'not-run' }
        });
    });
});

describe('RTC-B06 observation runner', () => {
    it('captures the predeclared E3 attempts and retention cohort before publishing accepted evidence', async () => {
        const { configured } = dependencies();

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
        expect(configured.envelope.recordExternalCohortAssertion).toHaveBeenCalledWith({
            baselineId: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3',
            workloadId: 'RTC-B06',
            cohortId: 'rtc-b06-e3-memory-retention',
            producerExitStatus: 0,
            rawResultRelativePath: 'artifacts/staging/rtc-b06-e3-memory-retention.json'
        });
    });

    it('captures one controlled double-sample repeat when E3 requires it', async () => {
        const { configured } = dependencies();
        vi.mocked(configured.envelope.readRepeatRequirement).mockImplementation(async () => {
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
        expect(configured.envelope.initializeBaseline).toHaveBeenCalledWith({
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
    });

    it('archives a producer failure without accepting metrics or selecting a repeat', async () => {
        const { configured } = dependencies();
        vi.mocked(configured.runLiveRtcProducer).mockImplementation(async () => {
            return { exitStatus: 9 };
        });
        vi.mocked(configured.envelope.recordExternalAttempt).mockImplementation(async () => {
            return {
                ok: false,
                issues: [{ path: '$.producer', code: 'producer-failed', message: 'failed' }]
            };
        });
        vi.mocked(configured.envelope.finalize).mockImplementation(async () => {
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
    });
});
