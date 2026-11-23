import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import type {
    RtcBaselineAttemptInputLocatorDto,
    RtcBaselineAttemptLocatorDto,
    RtcBaselineConditionalEnvironmentDecisionDto,
    RtcBaselineResult
} from '../contracts/rtc-baseline-contracts.ts';
import { createRtcBaselineObservationId } from '../contracts/rtc-baseline-id.ts';
import type { RtcBaselineFinalizedSummary } from '../evidence/rtc-baseline-finalized-evidence.ts';
import type { RtcBaselineEnvelope } from '../runtime/rtc-baseline-envelope.ts';
import { computeRtcPerformanceObservationOutcome } from './compute-rtc-performance-observation-outcome.ts';
import { readRtcB06EvidenceReport, type RtcB06EvidenceReport } from './read-rtc-b06-evidence-report.ts';
import type { RtcB06PerformanceObservation } from './rtc-b06-performance-observation.ts';
import type { RtcPerformanceObservationArchiveWritten } from './rtc-performance-observation-archive.ts';
import type { RtcPerformanceObservationOutcome } from './rtc-performance-observation.ts';
import { computeRtcB06AttemptTimeoutMs } from './to-rtc-b06-attempt-test-timeout-ms.ts';

export interface RtcB06ObservationRunInput {
    readonly sourceRef: 'main';
    readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
    readonly githubRunId: number;
    readonly githubRunAttempt: number;
    readonly githubRunUrl: string;
    readonly outputDirectory: string;
    /**
     * How long, from the capture's start, it may keep starting attempts before its job must upload and report; absent,
     * it runs every declared attempt.
     */
    readonly jobBudgetSeconds?: number;
}

export interface RtcB06BaselineCaptureInput extends Omit<RtcB06ObservationRunInput, 'sourceRef'> {
    readonly sourceRef: string;
    readonly environmentId: 'E3-memory' | 'E4-pg';
}

export interface RtcB06BaselineCapture {
    readonly baselineId: string;
    readonly startedAt: string;
    readonly source: { readonly commit: string; readonly tree: string; readonly ref: string; };
    readonly primaryOutcome: RtcPerformanceObservationOutcome;
    readonly acceptedMetrics: boolean;
    readonly evidenceReport: RtcB06EvidenceReport;
    readonly repeatDecision: RtcB06PerformanceObservation['repeat']['decision'];
    readonly repeatOutcome: RtcB06PerformanceObservation['repeat']['outcome'];
}

export interface RtcB06ObservationOutput {
    readonly archivePath: string;
    readonly indexEntryPath: string;
}

export interface RtcB06ObservationRunnerDependencies {
    readonly envelope: RtcB06ObservationEnvelope;
    preflight(environmentId: RtcB06BaselineCaptureInput['environmentId']): Promise<RtcBaselineResult<void>>;
    readSource(): Promise<RtcBaselineResult<{ commit: string; tree: string; }>>;
    runLiveRtcProducer(input: {
        baselineId: string;
        attempt: RtcBaselineAttemptLocatorDto;
    }): Promise<{ exitStatus: number; }>;
    readFinalizedArtifacts(
        baselineId: string
    ): Promise<RtcBaselineResult<ReadonlyMap<string, Uint8Array>>>;
    createArchive(input: {
        observation: RtcB06PerformanceObservation;
        primaryArtifacts: ReadonlyMap<string, Uint8Array>;
    }): Promise<RtcBaselineResult<RtcPerformanceObservationArchiveWritten>>;
    writeOutput(input: {
        outputDirectory: string;
        archive: RtcPerformanceObservationArchiveWritten;
    }): Promise<RtcBaselineResult<RtcB06ObservationOutput>>;
    nowUtc(): string;
    monotonicNowMs(): number;
}

type RtcB06ObservationEnvelope = Pick<
    RtcBaselineEnvelope,
    | 'initializeBaseline'
    | 'readExternalAttempts'
    | 'recordExternalAttempt'
    | 'recordExternalCohortAssertion'
    | 'recordExternalAttemptsNotStarted'
    | 'finalize'
    | 'readBaselineValidation'
>;

export function createRtcB06ObservationRunner(
    dependencies: RtcB06ObservationRunnerDependencies
) {
    return {
        run: (observation: RtcB06ObservationRunInput) => runRtcB06Observation(dependencies, observation),
        captureBaseline: (capture: RtcB06BaselineCaptureInput) => captureRtcB06Baseline(dependencies, capture)
    };
}

async function runRtcB06Observation(
    dependencies: RtcB06ObservationRunnerDependencies,
    run: RtcB06ObservationRunInput
) {
    const captured = await captureRtcB06Baseline(dependencies, { ...run, environmentId: 'E3-memory' });
    return captured.ok ? writeObservationArchive(dependencies, run, captured.value) : captured;
}

async function captureRtcB06Baseline(
    dependencies: RtcB06ObservationRunnerDependencies,
    capture: RtcB06BaselineCaptureInput
): Promise<RtcBaselineResult<RtcB06BaselineCapture>> {
    const deadlineMs = capture.jobBudgetSeconds === undefined
        ? undefined
        : dependencies.monotonicNowMs() + capture.jobBudgetSeconds * 1_000;
    const preflight = await dependencies.preflight(capture.environmentId);
    if (!preflight.ok) {
        return preflight;
    }
    const startedAt = dependencies.nowUtc();
    const source = await dependencies.readSource();
    if (!source.ok) {
        return source;
    }
    const identity = createRtcBaselineObservationId({
        startedAt,
        sourceCommit: source.value.commit,
        environmentId: capture.environmentId,
        githubRunId: capture.githubRunId,
        githubRunAttempt: capture.githubRunAttempt
    });
    if (!identity.ok) {
        return identity;
    }
    const initialized = await initializePrimary(dependencies.envelope, identity.value, capture.environmentId);
    if (!initialized.ok) {
        return initialized;
    }
    const primary = await captureAndFinalize(dependencies, {
        baselineId: identity.value,
        environmentId: capture.environmentId,
        deadlineMs
    });
    if (!primary.ok) {
        return primary;
    }
    const primaryOutcome = computeRtcPerformanceObservationOutcome(primary.value);
    const evidenceReport = await readEvidenceReport(dependencies, primary.value);
    if (!evidenceReport.ok) {
        return evidenceReport;
    }
    if (primaryOutcome === 'passed') {
        const accepted = await dependencies.envelope.readBaselineValidation({ baselineId: identity.value });
        if (!accepted.ok) {
            return accepted;
        }
    }
    return {
        ok: true,
        value: {
            baselineId: identity.value,
            startedAt,
            source: { ...source.value, ref: capture.sourceRef },
            primaryOutcome,
            acceptedMetrics: primaryOutcome === 'passed',
            evidenceReport: evidenceReport.value,
            repeatDecision: 'not-required',
            repeatOutcome: 'not-run'
        }
    };
}

async function readEvidenceReport(
    dependencies: RtcB06ObservationRunnerDependencies,
    summary: RtcBaselineFinalizedSummary
) {
    const artifacts = await dependencies.readFinalizedArtifacts(summary.baselineId);
    return artifacts.ok
        ? readRtcB06EvidenceReport({ artifacts: artifacts.value, metricSummaries: summary.metricSummaries })
        : artifacts;
}

async function writeObservationArchive(
    dependencies: RtcB06ObservationRunnerDependencies,
    run: RtcB06ObservationRunInput,
    input: RtcB06BaselineCapture
) {
    const { baselineId, startedAt, source, primaryOutcome, repeatDecision, repeatOutcome } = input;
    const primaryArtifacts = await dependencies.readFinalizedArtifacts(baselineId);
    if (!primaryArtifacts.ok) {
        return primaryArtifacts;
    }
    const observation: RtcB06PerformanceObservation = {
        schema: 'rallar.rtc-b06-performance-observation.v1',
        observationId: baselineId,
        startedAt,
        completedAt: dependencies.nowUtc(),
        source: { ...source, ref: run.sourceRef },
        workflow: {
            runId: run.githubRunId,
            runAttempt: run.githubRunAttempt,
            url: run.githubRunUrl
        },
        primary: {
            outcome: primaryOutcome,
            acceptedMetrics: primaryOutcome === 'passed'
        },
        repeat: { decision: repeatDecision, outcome: repeatOutcome }
    };
    const archived = await dependencies.createArchive({
        observation,
        primaryArtifacts: primaryArtifacts.value
    });
    if (!archived.ok) {
        return archived;
    }
    const output = await dependencies.writeOutput({
        outputDirectory: run.outputDirectory,
        archive: archived.value
    });
    return output.ok
        ? {
            ok: true as const,
            value: { observation, archive: archived.value, output: output.value, evidenceReport: input.evidenceReport }
        }
        : output;
}

function initializePrimary(
    envelope: RtcB06ObservationEnvelope,
    baselineId: string,
    environmentId: RtcB06BaselineCaptureInput['environmentId']
) {
    return envelope.initializeBaseline({
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId,
        workloadIds: ['RTC-B06'],
        environmentId,
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: [toRtcB06ConditionalEnvironmentDecision(environmentId)]
    });
}

interface RtcB06AttemptsRun {
    readonly baselineId: string;
    readonly environmentId: RtcB06BaselineCaptureInput['environmentId'];
    /**
     * The monotonic time by which a started attempt, its build and web server start included, must be able to end;
     * absent, every attempt starts.
     */
    readonly deadlineMs: number | undefined;
}

interface RtcB06ProducedAttempts {
    readonly complete: boolean;
    readonly retentionExitStatus: number;
}

async function captureAndFinalize(dependencies: RtcB06ObservationRunnerDependencies, run: RtcB06AttemptsRun) {
    const { baselineId, environmentId } = run;
    const retentionCohortId = `rtc-b06-${environmentId.toLowerCase()}-retention`;
    const attempts = await dependencies.envelope.readExternalAttempts({ baselineId, workloadId: 'RTC-B06' });
    if (!attempts.ok) {
        return attempts;
    }
    const produced = await produceAttempts(dependencies, run, attempts.value);
    if (!produced.ok) {
        return produced;
    }
    if (produced.value.complete) {
        await dependencies.envelope.recordExternalCohortAssertion({
            baselineId,
            workloadId: 'RTC-B06',
            cohortId: retentionCohortId,
            producerExitStatus: produced.value.retentionExitStatus,
            rawResultRelativePath: `artifacts/staging/${retentionCohortId}.json`
        });
    }
    return dependencies.envelope.finalize({ baselineId });
}

/**
 * Runs the attempts in order until one is refused or the job budget cannot cover the next attempt; that attempt and
 * every later one are then recorded as not started, so finalization still accounts for each of them.
 */
async function produceAttempts(
    dependencies: RtcB06ObservationRunnerDependencies,
    run: RtcB06AttemptsRun,
    attempts: readonly RtcBaselineAttemptLocatorDto[]
): Promise<RtcBaselineResult<RtcB06ProducedAttempts>> {
    let retentionExitStatus = 1;
    for (const attempt of attempts) {
        const locator = toAttemptInputLocator(attempt);
        if (!fitsJobDeadline(dependencies, run, attempt)) {
            const notStarted = await dependencies.envelope.recordExternalAttemptsNotStarted({
                baselineId: run.baselineId,
                locator
            });
            return notStarted.ok ? { ok: true, value: { complete: false, retentionExitStatus } } : notStarted;
        }
        const exitStatus = await runProducer(dependencies, run.baselineId, attempt);
        if (attempt.caseId === 'retention-100' && attempt.intendedPhase === 'retained') {
            retentionExitStatus = exitStatus;
        }
        const recorded = await dependencies.envelope.recordExternalAttempt({
            baselineId: run.baselineId,
            locator,
            producerExitStatus: exitStatus,
            rawResultRelativePath: attempt.rawResultRelativePath
        });
        if (!recorded.ok) {
            return { ok: true, value: { complete: false, retentionExitStatus } };
        }
    }
    return { ok: true, value: { complete: true, retentionExitStatus } };
}

function fitsJobDeadline(
    dependencies: RtcB06ObservationRunnerDependencies,
    run: RtcB06AttemptsRun,
    attempt: RtcBaselineAttemptLocatorDto
): boolean {
    return run.deadlineMs === undefined ||
        run.deadlineMs - dependencies.monotonicNowMs() >= computeRtcB06AttemptTimeoutMs(attempt.caseId);
}

function toAttemptInputLocator(attempt: RtcBaselineAttemptLocatorDto): RtcBaselineAttemptInputLocatorDto {
    return {
        workloadId: attempt.workloadId,
        caseId: attempt.caseId,
        inputKey: attempt.inputKey,
        intendedPhase: attempt.intendedPhase,
        outerOrdinal: attempt.outerOrdinal
    };
}

async function runProducer(
    dependencies: RtcB06ObservationRunnerDependencies,
    baselineId: string,
    attempt: RtcBaselineAttemptLocatorDto
) {
    try {
        return validExitStatus(
            (await dependencies.runLiveRtcProducer({ baselineId, attempt })).exitStatus
        );
    }
    catch {
        return 1;
    }
}

function validExitStatus(value: number) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 1;
}

function toRtcB06ConditionalEnvironmentDecision(
    environmentId: RtcB06BaselineCaptureInput['environmentId']
): RtcBaselineConditionalEnvironmentDecisionDto {
    return {
        environmentId: 'E4-pg' as const,
        decision: environmentId === 'E4-pg' ? 'required' as const : 'not-required' as const,
        reason: environmentId === 'E4-pg'
            ? 'E4-pg explicitly selected by the maintainer for governed baseline capture.'
            : 'E3-memory observation only; no database-backed candidate is being selected.'
    };
}
