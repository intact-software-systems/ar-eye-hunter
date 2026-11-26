import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    RTC_BASELINE_JOB_BUDGET_COHORT_ISSUE,
    RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ISSUE
} from '../../../baseline/acceptance/rtc-baseline-job-budget-not-started.ts';
import { deriveRtcBaselineCaptureManifest, deriveRtcBaselineExternalAttempts } from '../../../baseline/catalog/rtc-baseline-workload-manifest.ts';
import { decodeRtcBaselineCaptureRequest } from '../../../baseline/contracts/rtc-baseline-decoding.ts';
import {
    computeRtcB06AttemptTimeoutMs,
    toRtcB06AttemptTestTimeoutMs
} from '../../../baseline/observation/compute-rtc-b06-attempt-timeout-ms.ts';
import { createRtcB06ObservationRunner, type RtcB06ObservationRunnerDependencies } from '../../../baseline/observation/rtc-b06-observation-runner.ts';
import type { RtcB06PerformanceObservation } from '../../../baseline/observation/rtc-b06-performance-observation.ts';
import {
    verifyRtcPerformanceObservationArchive,
    type RtcPerformanceObservationArchiveWritten
} from '../../../baseline/observation/rtc-performance-observation-archive.ts';
import {
    createVerifiedRtcPerformanceObservationArchive,
    writeRtcPerformanceObservationOutput
} from '../../../baseline/observation/rtc-performance-observation-bun-support.ts';
import { runRtcPerformanceObservationCli } from '../../../baseline/observation/rtc-performance-observation-cli.ts';
import { createRtcB06FinalizedArtifacts, createRtcB06JobBudgetIncompleteArtifacts } from './rtc-performance-observation-fixture.ts';

const artifactFixture = await createRtcB06FinalizedArtifacts('20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3');
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

function createReportArtifacts() {
    const primaryArtifacts = new Map(artifactFixture);
    const cohortPath = 'results/external-cohorts/rtc-b06-e3-memory-retention.json';
    const cohort = JSON.parse(new TextDecoder().decode(primaryArtifacts.get(cohortPath)!));
    cohort.rawEvidence = {
        retainedAttemptCount: 3,
        requiredHeapBreachCount: 2,
        heapBreachingSampleIds: [],
        stateDriftSampleIds: [],
        failedMemberSampleIds: [],
        warnings: []
    };
    primaryArtifacts.set(cohortPath, new TextEncoder().encode(JSON.stringify(cohort)));
    return primaryArtifacts;
}

function dependencies() {
    const primaryArtifacts = createReportArtifacts();
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
        recordExternalAttemptsNotStarted: vi.fn(async () => {
            return success({ notStartedSampleCount: 0 });
        }),
        finalize: vi.fn(async () => {
            return success(finalizedSummary());
        }),
        readBaselineValidation: vi.fn(async () => {
            return success({ baselineId: '', retainedArtifactPaths: [], checksumEntryCount: 0 });
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
            .mockReturnValue('2026-08-30T10:30:00.417Z'),
        monotonicNowMs: vi.fn(() => 0)
    };
    return { configured };
}

/** The capture's output written to a real directory, as the job uploads it for publication. */
function toFileOutputPort(): Parameters<typeof writeRtcPerformanceObservationOutput>[0] {
    return {
        mkdir: async (path, options) => {
            await mkdir(path, options);
        },
        readFile: async (path) => new Uint8Array(await readFile(path)),
        writeFile: async (path, bytes, options) => {
            await writeFile(path, bytes, { flag: options?.createNew ? 'wx' : 'w' });
        }
    };
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
    it.each(['E3-memory', 'E4-pg'] as const)(
        'runs the full declared %s primary without automatic acquisition',
        async (environmentId) => {
            const { configured } = dependencies();
            const produced: Array<{ baselineId: string; caseId: string; phase: string; ordinal: number; }> = [];
            const initialized: object[] = [];
            const cohorts: string[] = [];
            configured.envelope.recordExternalCohortAssertion = async (input) => {
                cohorts.push(input.cohortId);
                return success({ acceptedCohortCount: 1 });
            };
            let manifest: ReturnType<typeof deriveRtcBaselineCaptureManifest>;
            configured.envelope.initializeBaseline = async (request) => {
                const captureRequest = typeof request === 'object' && request !== null
                    ? Object.fromEntries(Object.entries(request).filter(([field]) => field !== 'repeatOf'))
                    : request;
                const decoded = decodeRtcBaselineCaptureRequest(captureRequest);
                if (!decoded.ok) {
                    throw new Error(JSON.stringify(decoded.issues));
                }
                initialized.push({
                    ...decoded.value,
                    ...(typeof request === 'object' && request !== null && 'repeatOf' in request ? { repeatOf: request.repeatOf } : {})
                });
                manifest = deriveRtcBaselineCaptureManifest(decoded.value);
                return success(undefined);
            };
            configured.envelope.readExternalAttempts = async () => success(deriveRtcBaselineExternalAttempts(manifest, 'RTC-B06'));
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
            const result = await runner.captureBaseline({ ...workflow, environmentId, sourceRef: 'codex/rtc-baseline-refresh' });
            expect(result).toMatchObject({
                ok: true,
                value: {
                    baselineId: `20260830T100000Z-c0cadb8216cf-${environmentId.toLowerCase()}-gh987654321-a3`,
                    source: { ...source, ref: 'codex/rtc-baseline-refresh' },
                    primaryOutcome: 'passed',
                    acceptedMetrics: true,
                    repeatDecision: 'not-required',
                    repeatOutcome: 'not-run'
                }
            });
            expect(initialized).toHaveLength(1);
            for (const request of initialized) {
                expect(request).toMatchObject({
                    environmentId,
                    conditionalEnvironmentDecisions: [{ environmentId: 'E4-pg', decision: environmentId === 'E4-pg' ? 'required' : 'not-required' }]
                });
            }
            expect(cohorts).toEqual(['rtc-b06-' + environmentId.toLowerCase() + '-retention']);
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
            expect(new Set(produced.map((attempt) => attempt.baselineId))).toEqual(
                new Set([
                    '20260830T100000Z-c0cadb8216cf-' + environmentId.toLowerCase() + '-gh987654321-a3'
                ])
            );
        }
    );

    it.each(['E3-memory', 'E4-pg'] as const)('keeps failed %s primary evidence unaccepted and never selects a repeat or publishes', async (environmentId) => {
        const { configured } = dependencies();
        const produced: string[] = [];
        let manifest: ReturnType<typeof deriveRtcBaselineCaptureManifest>;
        configured.envelope.initializeBaseline = async (request) => {
            const decoded = decodeRtcBaselineCaptureRequest(request);
            if (!decoded.ok) {
                throw new Error(JSON.stringify(decoded.issues));
            }
            manifest = deriveRtcBaselineCaptureManifest(decoded.value);
            return success(undefined);
        };
        configured.envelope.readExternalAttempts = async () => success(deriveRtcBaselineExternalAttempts(manifest, 'RTC-B06'));
        configured.runLiveRtcProducer = async ({ attempt }) => {
            produced.push(attempt.rawResultRelativePath);
            return { exitStatus: 9 };
        };
        configured.envelope.finalize = async () => success(finalizedSummary('failed'));
        configured.createArchive = async () => {
            throw new Error('Branch capture must never publish');
        };
        const runner = createRtcB06ObservationRunner(configured);
        expect(await runner.captureBaseline({ ...workflow, environmentId, sourceRef: 'codex/rtc-baseline-refresh' })).toMatchObject({
            ok: true,
            value: { primaryOutcome: 'failed', acceptedMetrics: false, repeatDecision: 'not-required', repeatOutcome: 'not-run' }
        });
        expect(produced).toHaveLength(14);
        expect(new Set(produced).size).toBe(14);
        expect(produced.every((path) => path.includes(environmentId.toLowerCase()))).toBe(true);
    });
});

describe('RTC-B06 observation runner', () => {
    it('keeps finalized primary integrity validation blocking publication', async () => {
        const { configured } = dependencies();
        const issues = [{ path: '$.SHA256SUMS', code: 'raw-sha256-mismatch', message: 'Retained evidence hash differs.' }];
        configured.envelope.readBaselineValidation = async () => ({ ok: false, issues });
        configured.createArchive = async () => {
            throw new Error('Invalid retained evidence must never be archived');
        };
        expect(await createRtcB06ObservationRunner(configured).run(workflow)).toEqual({ ok: false, issues });
    });

    it('exposes noisy timing disposition and retained warnings in operator output without a repeat', async () => {
        const { configured } = dependencies();
        const summary = finalizedSummary();
        summary.metricSummaries[0]!.coefficientOfVariation = 0.4;
        configured.envelope.finalize = async () => success(summary);
        const result = await createRtcB06ObservationRunner(configured).run(workflow);
        expect(result).toMatchObject({
            ok: true,
            value: {
                evidenceReport: { metricOutcome: 'inconclusive', warnings: [] },
                observation: { primary: { outcome: 'passed', acceptedMetrics: true }, repeat: { decision: 'not-required', outcome: 'not-run' } }
            }
        });
    });
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

describe('RTC-B06 job budget', () => {
    /** Each produced attempt advances the fake monotonic clock by this much. */
    const ATTEMPT_DURATION_MS = 100_000;

    function budgetedDependencies() {
        const { configured } = dependencies();
        const produced: string[] = [];
        /** What the capture recorded, in order, besides each produced attempt. */
        const recorded: string[] = [];
        const notStarted: Parameters<RtcB06ObservationRunnerDependencies['envelope']['recordExternalAttemptsNotStarted']>[0][] = [];
        let nowMs = 0;
        let manifest: ReturnType<typeof deriveRtcBaselineCaptureManifest>;
        configured.monotonicNowMs = () => nowMs;
        configured.envelope.initializeBaseline = async (request) => {
            const decoded = decodeRtcBaselineCaptureRequest(request);
            if (!decoded.ok) {
                throw new Error(JSON.stringify(decoded.issues));
            }
            manifest = deriveRtcBaselineCaptureManifest(decoded.value);
            return success(undefined);
        };
        configured.envelope.readExternalAttempts = async () => success(deriveRtcBaselineExternalAttempts(manifest, 'RTC-B06'));
        configured.runLiveRtcProducer = async ({ attempt }) => {
            produced.push(`${attempt.caseId}/${attempt.intendedPhase}/${attempt.outerOrdinal}`);
            nowMs += ATTEMPT_DURATION_MS;
            return { exitStatus: 0 };
        };
        configured.envelope.recordExternalAttemptsNotStarted = async (input) => {
            recorded.push('not-started');
            notStarted.push(input);
            return success({ notStartedSampleCount: 1 });
        };
        configured.envelope.recordExternalCohortAssertion = async () => {
            recorded.push('cohort');
            return success({ acceptedCohortCount: 1 });
        };
        configured.envelope.finalize = async () => {
            recorded.push('finalize');
            return success(finalizedSummary());
        };
        return { configured, produced, recorded, notStarted };
    }

    it('starts every attempt whose build, web server start and derived test timeout the job budget still covers', async () => {
        const { configured, produced, recorded } = budgetedDependencies();
        const everyAttemptMs = 6 * computeRtcB06AttemptTimeoutMs('default') +
            4 * computeRtcB06AttemptTimeoutMs('all-scenarios') + 4 * computeRtcB06AttemptTimeoutMs('retention-100');

        await createRtcB06ObservationRunner(configured).captureBaseline({
            ...workflow,
            environmentId: 'E3-memory',
            sourceRef: 'codex/rtc-baseline-refresh',
            jobBudgetSeconds: everyAttemptMs / 1_000
        });

        expect(produced).toHaveLength(14);
        expect(recorded).toEqual(['cohort', 'finalize']);
    });

    // Six default attempts take 600 s, leaving one second less than an every-scenario attempt's timeout.
    it('records the first attempt the budget cannot cover as not started and starts no later attempt', async () => {
        const { configured, produced, recorded, notStarted } = budgetedDependencies();
        const budgetMs = 6 * ATTEMPT_DURATION_MS + computeRtcB06AttemptTimeoutMs('all-scenarios') - 1_000;

        await createRtcB06ObservationRunner(configured).captureBaseline({
            ...workflow,
            environmentId: 'E3-memory',
            sourceRef: 'codex/rtc-baseline-refresh',
            jobBudgetSeconds: budgetMs / 1_000
        });

        expect(produced).toEqual([
            'default/warmup/1',
            'default/retained/1',
            'default/retained/2',
            'default/retained/3',
            'default/retained/4',
            'default/retained/5'
        ]);
        expect(recorded).toEqual(['not-started', 'finalize']);
        expect(notStarted).toEqual([{
            baselineId: '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3',
            locator: {
                workloadId: 'RTC-B06',
                caseId: 'all-scenarios',
                inputKey: 'e3-memory-all-scenarios',
                intendedPhase: 'warmup',
                outerOrdinal: 1
            }
        }]);
    });

    // The deadline check left out the production build and the web servers' start that run before every attempt's test.
    it('does not start an attempt whose test the budget covers but whose build and web server start it does not', async () => {
        const { configured, produced, recorded } = budgetedDependencies();
        const budgetMs = 6 * ATTEMPT_DURATION_MS + toRtcB06AttemptTestTimeoutMs('all-scenarios');

        await createRtcB06ObservationRunner(configured).captureBaseline({
            ...workflow,
            environmentId: 'E3-memory',
            sourceRef: 'codex/rtc-baseline-refresh',
            jobBudgetSeconds: budgetMs / 1_000
        });

        expect(produced.at(-1)).toBe('default/retained/5');
        expect(recorded).toEqual(['not-started', 'finalize']);
    });

    /** An attempt that ran failed, and the job budget left a later one unstarted. */
    function failedBudgetSummary() {
        const summary = finalizedSummary('failed');
        return {
            ...summary,
            sampleOutcomes: [
                ...summary.sampleOutcomes,
                {
                    identity: { ...sampleIdentity, sampleId: 'rtc-b06-default-e3-memory-default-retained-002-001', outerOrdinal: 2 },
                    outcome: 'not-run' as const,
                    issues: [RTC_BASELINE_JOB_BUDGET_NOT_STARTED_ISSUE]
                }
            ],
            cohortOutcomes: [{ identity: cohortIdentity, outcome: 'failed' as const, issues: [RTC_BASELINE_JOB_BUDGET_COHORT_ISSUE] }]
        };
    }

    // A fake archive hid that the archive's evidence check refused `incomplete`, so publish mode wrote no archive.
    it('archives an incomplete capture as incomplete, and the publication verifies the files the job uploads', async () => {
        const { configured } = dependencies();
        const evidence = await createRtcB06JobBudgetIncompleteArtifacts(
            '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3'
        );
        const outputDirectory = await mkdtemp(join(tmpdir(), 'rtc-b06-incomplete-'));
        configured.envelope.finalize = async () => success(JSON.parse(new TextDecoder().decode(evidence.get('summary.json')!)));
        configured.envelope.readBaselineValidation = async () => {
            throw new Error('An incomplete capture must not be validated as accepted evidence.');
        };
        configured.readFinalizedArtifacts = async () => success(evidence);
        configured.createArchive = createVerifiedRtcPerformanceObservationArchive;
        configured.writeOutput = ({ archive }) => writeRtcPerformanceObservationOutput(toFileOutputPort(), outputDirectory, archive);
        try {
            const run = await createRtcB06ObservationRunner(configured).run({ ...workflow, outputDirectory });
            const uploaded = await readdir(outputDirectory);
            const stdout: string[] = [];
            const exitStatus = await runRtcPerformanceObservationCli({
                args: [
                    'verify-observation',
                    `--archive=${join(outputDirectory, uploaded.find((name) => name.endsWith('.zip'))!)}`,
                    `--index-entry=${join(outputDirectory, 'index-entry.jsonl')}`
                ],
                browserRunner: { run: vi.fn() },
                liveRtcRunner: { run: vi.fn(), captureBaseline: vi.fn() },
                readFile: async (path) => new Uint8Array(await readFile(path)),
                verifyArchive: verifyRtcPerformanceObservationArchive,
                writeStdout: (value) => stdout.push(value),
                writeStderr: (value) => stdout.push(value)
            });

            expect(run).toMatchObject({ ok: true, value: { observation: { primary: { outcome: 'incomplete' } } } });
            expect(uploaded.toSorted()).toEqual([
                'index-entry.jsonl',
                '20260830T100000Z-c0cadb8216cf-e3-memory-gh987654321-a3.zip'
            ].toSorted());
            expect(exitStatus).toBe(0);
            expect(JSON.parse(stdout.join('')).primary).toEqual({ outcome: 'incomplete', acceptedMetrics: false });
            expect(JSON.parse(await readFile(join(outputDirectory, 'index-entry.jsonl'), 'utf8')).observation.primary)
                .toEqual({ outcome: 'incomplete', acceptedMetrics: false });
        }
        finally {
            await rm(outputDirectory, { recursive: true, force: true });
        }
    });

    it('keeps a capture failed when an attempt it ran failed before the budget ran out', async () => {
        const { configured } = dependencies();
        configured.envelope.finalize = async () => success(failedBudgetSummary());

        expect(
            await createRtcB06ObservationRunner(configured).captureBaseline({
                ...workflow,
                environmentId: 'E3-memory',
                sourceRef: 'codex/rtc-baseline-refresh'
            })
        ).toMatchObject({ ok: true, value: { primaryOutcome: 'failed', acceptedMetrics: false } });
    });
});
