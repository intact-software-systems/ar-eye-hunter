import type { RtcBaselineAttemptLocatorDto, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import { createRtcBaselineObservationId, createRtcBaselineRepeatId } from '../contracts/rtc-baseline-id.ts';
import type { RtcBaselineFinalizedSummary } from '../evidence/rtc-baseline-finalized-evidence.ts';
import type { RtcBaselineEnvelope } from '../runtime/rtc-baseline-envelope.ts';
import type { RtcB06PerformanceObservation } from './rtc-b06-performance-observation.ts';
import type { RtcPerformanceObservationArchiveWritten } from './rtc-performance-observation-archive.ts';
import type { RtcPerformanceObservationOutcome } from './rtc-performance-observation.ts';

const conditionalEnvironmentDecision = {
    environmentId: 'E4-pg' as const,
    decision: 'not-required' as const,
    reason: 'E3-memory observation only; no database-backed candidate is being selected.'
};
const retentionCohortId = 'rtc-b06-e3-memory-retention';

type RtcB06ObservationEnvelope = Pick<
    RtcBaselineEnvelope,
    | 'initializeBaseline'
    | 'readExternalAttempts'
    | 'recordExternalAttempt'
    | 'recordExternalCohortAssertion'
    | 'finalize'
    | 'readBaselineValidation'
    | 'readRepeatRequirement'
>;

export interface RtcB06ObservationRunInput {
    readonly sourceRef: 'main';
    readonly githubRunId: number;
    readonly githubRunAttempt: number;
    readonly githubRunUrl: string;
    readonly outputDirectory: string;
}

export interface RtcB06ObservationOutput {
    readonly archivePath: string;
    readonly indexEntryPath: string;
}

export interface RtcB06ObservationRunnerDependencies {
    readonly envelope: RtcB06ObservationEnvelope;
    preflight(): Promise<RtcBaselineResult<void>>;
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
        repeatArtifacts?: ReadonlyMap<string, Uint8Array>;
    }): Promise<RtcBaselineResult<RtcPerformanceObservationArchiveWritten>>;
    writeOutput(input: {
        outputDirectory: string;
        archive: RtcPerformanceObservationArchiveWritten;
    }): Promise<RtcBaselineResult<RtcB06ObservationOutput>>;
    nowUtc(): string;
}

export function createRtcB06ObservationRunner(
    dependencies: RtcB06ObservationRunnerDependencies
) {
    return {
        run: (observation: RtcB06ObservationRunInput) => runRtcB06Observation(dependencies, observation)
    };
}

async function runRtcB06Observation(
    dependencies: RtcB06ObservationRunnerDependencies,
    run: RtcB06ObservationRunInput
) {
    const preflight = await dependencies.preflight();
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
        environmentId: 'E3-memory',
        githubRunId: run.githubRunId,
        githubRunAttempt: run.githubRunAttempt
    });
    if (!identity.ok) {
        return identity;
    }
    const initialized = await initializePrimary(dependencies.envelope, identity.value);
    if (!initialized.ok) {
        return initialized;
    }
    const primary = await captureAndFinalize(dependencies, identity.value);
    if (!primary.ok) {
        return primary;
    }
    const primaryOutcome = outcomeOf(primary.value);
    let repeatDecision: RtcB06PerformanceObservation['repeat']['decision'] = 'not-required';
    let repeatOutcome: RtcB06PerformanceObservation['repeat']['outcome'] = 'not-run';
    let repeatArtifacts: ReadonlyMap<string, Uint8Array> | undefined;
    if (primaryOutcome === 'passed') {
        const accepted = await dependencies.envelope.readBaselineValidation({
            baselineId: identity.value
        });
        if (!accepted.ok) {
            return accepted;
        }
        const repeat = await dependencies.envelope.readRepeatRequirement({
            baselineId: identity.value
        });
        if (!repeat.ok) {
            return repeat;
        }
        if (repeat.value.workloadIds.includes('RTC-B06')) {
            repeatDecision = 'required';
            const repeated = await captureRepeat(dependencies, identity.value);
            if (!repeated.ok) {
                return repeated;
            }
            repeatOutcome = outcomeOf(repeated.value.summary);
            repeatArtifacts = repeated.value.artifacts;
        }
    }
    const primaryArtifacts = await dependencies.readFinalizedArtifacts(identity.value);
    if (!primaryArtifacts.ok) {
        return primaryArtifacts;
    }
    const observation: RtcB06PerformanceObservation = {
        schema: 'rallar.rtc-b06-performance-observation.v1',
        observationId: identity.value,
        startedAt,
        completedAt: dependencies.nowUtc(),
        source: { ...source.value, ref: run.sourceRef },
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
        primaryArtifacts: primaryArtifacts.value,
        ...(repeatArtifacts === undefined ? {} : { repeatArtifacts })
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
            value: { observation, archive: archived.value, output: output.value }
        }
        : output;
}

async function captureRepeat(
    dependencies: RtcB06ObservationRunnerDependencies,
    primaryBaselineId: string
) {
    const repeatId = createRtcBaselineRepeatId(primaryBaselineId);
    if (!repeatId.ok) {
        return repeatId;
    }
    const initialized = await dependencies.envelope.initializeBaseline({
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId: repeatId.value,
        workloadIds: ['RTC-B06'],
        environmentId: 'E3-memory',
        retainedSampleMultiplier: 2,
        repeatLink: null,
        conditionalEnvironmentDecisions: [conditionalEnvironmentDecision],
        repeatOf: primaryBaselineId
    });
    if (!initialized.ok) {
        return initialized;
    }
    const summary = await captureAndFinalize(dependencies, repeatId.value);
    if (!summary.ok) {
        return summary;
    }
    const artifacts = await dependencies.readFinalizedArtifacts(repeatId.value);
    return artifacts.ok
        ? { ok: true as const, value: { summary: summary.value, artifacts: artifacts.value } }
        : artifacts;
}

function initializePrimary(envelope: RtcB06ObservationEnvelope, baselineId: string) {
    return envelope.initializeBaseline({
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId,
        workloadIds: ['RTC-B06'],
        environmentId: 'E3-memory',
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: [conditionalEnvironmentDecision]
    });
}

async function captureAndFinalize(
    dependencies: RtcB06ObservationRunnerDependencies,
    baselineId: string
) {
    const attempts = await dependencies.envelope.readExternalAttempts({
        baselineId,
        workloadId: 'RTC-B06'
    });
    if (!attempts.ok) {
        return attempts;
    }
    let attemptsComplete = true;
    let retentionExitStatus = 1;
    for (const attempt of attempts.value) {
        const exitStatus = await runProducer(dependencies, baselineId, attempt);
        if (attempt.caseId === 'retention-100' && attempt.intendedPhase === 'retained') {
            retentionExitStatus = exitStatus;
        }
        const recorded = await dependencies.envelope.recordExternalAttempt({
            baselineId,
            locator: {
                workloadId: attempt.workloadId,
                caseId: attempt.caseId,
                inputKey: attempt.inputKey,
                intendedPhase: attempt.intendedPhase,
                outerOrdinal: attempt.outerOrdinal
            },
            producerExitStatus: exitStatus,
            rawResultRelativePath: attempt.rawResultRelativePath
        });
        if (!recorded.ok) {
            attemptsComplete = false;
            break;
        }
    }
    if (attemptsComplete) {
        await dependencies.envelope.recordExternalCohortAssertion({
            baselineId,
            workloadId: 'RTC-B06',
            cohortId: retentionCohortId,
            producerExitStatus: retentionExitStatus,
            rawResultRelativePath: `artifacts/staging/${retentionCohortId}.json`
        });
    }
    return dependencies.envelope.finalize({ baselineId });
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

function outcomeOf(summary: RtcBaselineFinalizedSummary): RtcPerformanceObservationOutcome {
    const outcomes = [...summary.sampleOutcomes, ...summary.cohortOutcomes];
    return outcomes.length === 0
        ? 'incomplete'
        : outcomes.some(({ outcome }) => outcome !== 'passed')
        ? 'failed'
        : 'passed';
}

function validExitStatus(value: number) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 1;
}
