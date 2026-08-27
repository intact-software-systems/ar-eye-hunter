import type { RtcBaselineAttemptLocatorDto, RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';
import { createRtcBaselineObservationId, createRtcBaselineRepeatId } from '../contracts/rtc-baseline-id.ts';
import type { RtcBaselineFinalizedSummary } from '../evidence/rtc-baseline-finalized-evidence.ts';
import type { RtcBaselineEnvelope } from '../runtime/rtc-baseline-envelope.ts';
import type { RtcPerformanceObservationArchiveWritten } from './rtc-performance-observation-archive.ts';
import type { RtcPerformanceObservation, RtcPerformanceObservationOutcome } from './rtc-performance-observation.ts';

type RtcB05ObservationEnvelope = Pick<
    RtcBaselineEnvelope,
    | 'initializeBaseline'
    | 'readExternalAttempts'
    | 'recordBrowser'
    | 'finalize'
    | 'readBaselineValidation'
    | 'readRepeatRequirement'
>;

export interface RtcB05ObservationRunInput {
    readonly sourceRef: 'main';
    readonly githubRunId: number;
    readonly githubRunAttempt: number;
    readonly githubRunUrl: string;
    readonly outputDirectory: string;
}

export interface RtcB05ObservationOutput {
    readonly archivePath: string;
    readonly indexEntryPath: string;
}

export interface RtcB05ObservationRunnerDependencies {
    envelope: RtcB05ObservationEnvelope;
    preflight(): Promise<RtcBaselineResult<void>>;
    readSource(): Promise<RtcBaselineResult<{ commit: string; tree: string; }>>;
    runBrowserProducer(input: {
        baselineId: string;
        attempt: RtcBaselineAttemptLocatorDto;
    }): Promise<{ exitStatus: number; }>;
    readFinalizedArtifacts(
        baselineId: string
    ): Promise<RtcBaselineResult<ReadonlyMap<string, Uint8Array>>>;
    createArchive(input: {
        observation: RtcPerformanceObservation;
        primaryArtifacts: ReadonlyMap<string, Uint8Array>;
        repeatArtifacts?: ReadonlyMap<string, Uint8Array>;
    }): Promise<RtcBaselineResult<RtcPerformanceObservationArchiveWritten>>;
    writeOutput(input: {
        outputDirectory: string;
        archive: RtcPerformanceObservationArchiveWritten;
    }): Promise<RtcBaselineResult<RtcB05ObservationOutput>>;
    nowUtc(): string;
}

export function createRtcB05ObservationRunner(
    dependencies: RtcB05ObservationRunnerDependencies
) {
    return {
        run: (input: RtcB05ObservationRunInput) => runRtcB05Observation(dependencies, input)
    };
}

async function runRtcB05Observation(
    dependencies: RtcB05ObservationRunnerDependencies,
    input: RtcB05ObservationRunInput
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
        environmentId: 'E2-browser',
        githubRunId: input.githubRunId,
        githubRunAttempt: input.githubRunAttempt
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
    let repeatDecision: RtcPerformanceObservation['repeat']['decision'] = 'not-required';
    let repeatOutcome: RtcPerformanceObservation['repeat']['outcome'] = 'not-run';
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
        if (repeat.value.workloadIds.includes('RTC-B05')) {
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
    const observation: RtcPerformanceObservation = {
        schema: 'rallar.rtc-performance-observation.v1',
        observationId: identity.value,
        startedAt,
        completedAt: dependencies.nowUtc(),
        source: { ...source.value, ref: input.sourceRef },
        workflow: {
            runId: input.githubRunId,
            runAttempt: input.githubRunAttempt,
            url: input.githubRunUrl
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
        outputDirectory: input.outputDirectory,
        archive: archived.value
    });
    return output.ok
        ? { ok: true as const, value: { observation, archive: archived.value, output: output.value } }
        : output;
}

function initializePrimary(envelope: RtcB05ObservationEnvelope, baselineId: string) {
    return envelope.initializeBaseline({
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId,
        workloadIds: ['RTC-B05'],
        environmentId: 'E2-browser',
        retainedSampleMultiplier: 1,
        repeatLink: null,
        conditionalEnvironmentDecisions: []
    });
}

async function captureAndFinalize(
    dependencies: RtcB05ObservationRunnerDependencies,
    baselineId: string
) {
    const attempts = await dependencies.envelope.readExternalAttempts({
        baselineId,
        workloadId: 'RTC-B05'
    });
    if (!attempts.ok) {
        return attempts;
    }
    for (const attempt of attempts.value) {
        let exitStatus = 1;
        try {
            exitStatus = (await dependencies.runBrowserProducer({ baselineId, attempt })).exitStatus;
        }
        catch {
            exitStatus = 1;
        }
        const recorded = await dependencies.envelope.recordBrowser({
            baselineId,
            locator: {
                workloadId: attempt.workloadId,
                caseId: attempt.caseId,
                inputKey: attempt.inputKey,
                intendedPhase: attempt.intendedPhase,
                outerOrdinal: attempt.outerOrdinal
            },
            producerExitStatus: validExitStatus(exitStatus),
            rawResultRelativePath: attempt.rawResultRelativePath
        });
        if (!recorded.ok) {
            break;
        }
    }
    return dependencies.envelope.finalize({ baselineId });
}

async function captureRepeat(
    dependencies: RtcB05ObservationRunnerDependencies,
    primaryBaselineId: string
) {
    const repeatId = createRtcBaselineRepeatId(primaryBaselineId);
    if (!repeatId.ok) {
        return repeatId;
    }
    const initialized = await dependencies.envelope.initializeBaseline({
        schema: 'rallar.rtc-baseline.capture-request.v1',
        baselineId: repeatId.value,
        workloadIds: ['RTC-B05'],
        environmentId: 'E2-browser',
        retainedSampleMultiplier: 2,
        repeatLink: null,
        conditionalEnvironmentDecisions: [],
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
