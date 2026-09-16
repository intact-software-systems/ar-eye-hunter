import { Either } from '@shared/resilience/Either.ts';

import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from './control-snapshots.ts';
import { computeControlRequestFailureAnalysis } from './distributed-artifact-analysis/compute-control-request-failure.ts';
import {
    computeDistributedRunArtifactPipelineAnalysis,
    resolveArtifactSchemaVersion,
    toDistributedRunContentSnapshots,
    toPipelineArtifactBundle
} from './distributed-artifact-analysis/compute-distributed-run-artifact-pipeline-analysis.ts';
import type { DistributedRunControlPostRequest } from './distributed-artifact-analysis/decode-control-post-request.ts';
import type { DistributedRunRunnerSummary } from './distributed-artifact-analysis/decode-distributed-run-runner-summary.ts';
import {
    toDistributedRunArtifactContent,
    toDistributedRunBundleContent
} from './distributed-artifact-analysis/to-distributed-run-artifact-content.ts';
import { parseDistributedArtifactPipeline } from './distributed-artifact-pipeline.ts';
import type { DistributedRunAnalysisReport } from './distributed-run-analysis/distributed-run-analysis-report.ts';
import type { RunVerdictView } from './distributed-run-analysis/run-verdict-view.ts';

export type DistributedRunArtifactFiles = Readonly<Record<string, string | undefined>>;

export interface DistributedRunAnalysisInput {
    readonly files: DistributedRunArtifactFiles;
    readonly generatedAtEpochMs: number;
}

export interface DistributedRunArtifactRejection {
    readonly fileName: string;
    readonly message: string;
}

export interface DistributedRunArtifactParseWarning {
    readonly fileName: string;
    readonly message: string;
    /** Absent when the warning concerns a whole file rather than one JSONL line. */
    readonly lineNumber?: number;
}

export interface DistributedRunFailureAnalysis {
    readonly category: string;
    readonly title: string;
    readonly likelyCause: string;
    readonly nextAction: string;
    readonly minimalFixArea: string;
    readonly verificationCommand: string;
    readonly affectedAgents: readonly string[];
    readonly affectedRegions: readonly string[];
    /** Absent when the failure evidence names no command. */
    readonly commandId?: string;
    /** Absent when the failure evidence names no recipe. */
    readonly recipeId?: string;
    readonly evidenceFile: string;
}

/**
 * Duration statistics over the sampled durations. Without samples the summary repeats the recorded timing;
 * with neither samples nor a record it counts zero samples and zero outliers.
 */
export interface DistributedRunTimingSummary {
    /** Absent only when the summary repeats a recorded timing that omits its count. */
    readonly count?: number;
    /** Absent when no duration was sampled and there is no record or the record omits it. */
    readonly minMs?: number;
    /** Absent when no duration was sampled and there is no record or the record omits it. */
    readonly p50Ms?: number;
    /** Absent when no duration was sampled and there is no record or the record omits it. */
    readonly p95Ms?: number;
    /** Absent when no duration was sampled and there is no record or the record omits it. */
    readonly p99Ms?: number;
    /** Absent when no duration was sampled and there is no record or the record omits it. */
    readonly maxMs?: number;
    /** Absent when no duration was sampled and there is no record or the record omits it. */
    readonly averageMs?: number;
    /** Absent without both a median and a p95. */
    readonly spreadRatio?: number;
    /** Absent only when the summary repeats a recorded timing that omits its outlier count. */
    readonly outlierCount?: number;
}

export interface DistributedRunSlowestAgent {
    readonly agentId: string;
    readonly commandCount: number;
    readonly averageMs: number;
    readonly maxMs: number;
}

/** Each duration statistic is absent when the agent's streams record neither observations nor durations. */
export interface DistributedRunSlowestStreamAgent {
    readonly agentId: string;
    readonly streamCount: number;
    readonly plannedFrames: number;
    readonly completedFrames: number;
    readonly averageMs?: number;
    readonly p95Ms?: number;
    readonly p99Ms?: number;
    readonly maxMs?: number;
}

export interface DistributedRunStreamTiming {
    readonly streamCount: number;
    readonly plannedFrames: number;
    readonly scheduledFrames: number;
    readonly attemptedFrames: number;
    readonly completedFrames: number;
    readonly failedFrames: number;
    readonly droppedFrames: number;
    readonly inFlightLimitDropCount: number;
    readonly backpressureCount: number;
    /** Absent when no frame was attempted. */
    readonly sendSuccessRatio?: number;
    /** Absent when no stream records its requested rate. */
    readonly requestedRateHz?: number;
    /** Absent when no stream records its achieved schedule rate. */
    readonly achievedScheduleHz?: number;
    /** Absent when no stream records its achieved completion rate. */
    readonly achievedCompletionHz?: number;
    /** Absent when no stream records its start drift. */
    readonly maxStartDriftMs?: number;
    readonly lateFrameCount: number;
    readonly duration: DistributedRunTimingSummary;
    readonly slowestAgents: readonly DistributedRunSlowestStreamAgent[];
}

export interface DistributedRunLowestReceiver {
    readonly agentId: string;
    readonly receivedMessages: number;
    /** Absent when the receiver's delivery bound sets no expected message count. */
    readonly expectedInboundMessages?: number;
    /** Absent without a positive expected message count. */
    readonly deliveryRatio?: number;
}

export interface DistributedRunReceiverDelivery {
    readonly sampleCount: number;
    /** Absent when no receiver's delivery bound sets an expected message count. */
    readonly expectedInboundMessages?: number;
    /** Absent when no receiver's delivery bound sets a minimum message count. */
    readonly minExpectedInboundMessages?: number;
    /** Absent when no receiver's delivery bound sets a minimum receive ratio. */
    readonly minReceiveRatio?: number;
    readonly minReceivedMessages: number;
    readonly medianReceivedMessages: number;
    readonly p95ReceivedMessages: number;
    readonly maxReceivedMessages: number;
    /** Absent when no receiver has a positive expected message count; so are the median and p95 ratios. */
    readonly minDeliveryRatio?: number;
    readonly medianDeliveryRatio?: number;
    readonly p95DeliveryRatio?: number;
    readonly lowestAgents: readonly DistributedRunLowestReceiver[];
}

export interface DistributedRunPerformanceAnalysis {
    /** Absent when the run snapshot lacks start or completion times and the fleet report records no run timing. */
    readonly runDurationMs?: number;
    readonly agentCount: number;
    readonly passRate: number;
    readonly reconnectCount: number;
    readonly diagnosticCount: number;
    readonly warningDiagnosticCount: number;
    readonly errorDiagnosticCount: number;
    readonly exportedEventCount: number;
    readonly agentReportedEventCount: number;
    readonly failedAgentCount: number;
    /** Absent when no fleet report records the missing agents. */
    readonly missingAgentCount?: number;
    /** Absent when no fleet report records the stale agents. */
    readonly staleAgentCount?: number;
    /** Absent when no fleet report records the flaky agents. */
    readonly flakyAgentCount?: number;
    readonly commandTiming: DistributedRunTimingSummary;
    /** Absent unless every stream sample is a terminal summary with its frame counts. */
    readonly streamTiming?: DistributedRunStreamTiming;
    /** Absent when no stats result carries a message count with a receiver delivery bound. */
    readonly receiverDelivery?: DistributedRunReceiverDelivery;
    readonly slowestAgents: readonly DistributedRunSlowestAgent[];
}

export interface DistributedRunTargetResolutionAnalysis {
    readonly selected: number;
    /** Absent when the target resolution records no expected participant count. */
    readonly expectedParticipantCount?: number;
    readonly missingExpectedParticipants: number;
    readonly blockers: number;
    readonly staleAgents: number;
    readonly offlineAgents: number;
    readonly wrongGroupAgents: number;
    readonly agentsWithoutIdentity: number;
    readonly roleCounts: Readonly<Record<string, number>>;
    readonly regions: Readonly<Record<string, number>>;
    readonly providers: Readonly<Record<string, number>>;
    readonly targetAgentIds: readonly string[];
    readonly blockingAgentIds: readonly string[];
}

/** Each id is absent when the group record does not name it. */
export interface DistributedRunAnalysisGroup {
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly groupId?: string;
}

export interface DistributedRunAnalysisSummary {
    /** Absent when neither fleet-report.json nor a usable control-run.json records the run's agents. */
    readonly agents?: number;
    readonly passRate: number;
    readonly failureGroups: number;
    readonly blockingFailures: number;
}

export interface DistributedRunSpaAnalysis {
    readonly report: DistributedRunAnalysisReport;
    readonly verdict: RunVerdictView;
}

/** The sections every distributed run analysis carries, whatever its verdict. */
export interface DistributedRunAnalysisSections {
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly status: string;
    /** Absent when neither the manifest nor fleet-report.json names the run group. */
    readonly group?: DistributedRunAnalysisGroup;
    readonly summary: DistributedRunAnalysisSummary;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    /** Absent when control-run.json is missing or malformed; a parse warning names the file and the summary says so. */
    readonly performance?: DistributedRunPerformanceAnalysis;
    /** Absent when neither target-resolution.json nor the run snapshot records target resolution. */
    readonly targetResolution?: DistributedRunTargetResolutionAnalysis;
    readonly spa: DistributedRunSpaAnalysis;
    readonly summaryMarkdown: string;
    /** Absent with the performance section. */
    readonly performanceMarkdown?: string;
}

export interface DistributedRunPassedAnalysis extends DistributedRunAnalysisSections {
    readonly ok: true;
}

export interface DistributedRunFailedAnalysis extends DistributedRunAnalysisSections {
    readonly ok: false;
    readonly failure: DistributedRunFailureAnalysis;
    readonly fixProposalMarkdown: string;
}

export type DistributedRunAnalysis = DistributedRunPassedAnalysis | DistributedRunFailedAnalysis;

export interface DistributedRunSnapshots {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlRun: ControlRunSnapshot;
}

export interface DistributedRunArtifactSnapshots extends DistributedRunSnapshots {
    /** Absent when the artifact files cannot form a bundle; parseWarnings says why. */
    readonly artifactBundle?: ControlDistributedRunArtifactBundle;
    /** The artifact warnings of the files these snapshots were read from, the bundle rejection included. */
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
}

/** The analysis of artifacts that record a failed control request instead of a distributed run. */
export interface DistributedRunControlRequestFailureAnalysis {
    readonly generatedAtEpochMs: number;
    /** Absent when neither runner-summary.json nor manifest.json names the run. */
    readonly distributedRunId?: string;
    /** Absent when the runner stopped before it wrote runner-summary.json. */
    readonly runnerSummary?: DistributedRunRunnerSummary;
    readonly ok: false;
    readonly request: DistributedRunControlPostRequest;
    /** Absent when the runner recorded no response body or the artifacts do not hold its file. */
    readonly responseBody?: string;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    readonly failure: DistributedRunFailureAnalysis;
    readonly summaryMarkdown: string;
    readonly fixProposalMarkdown: string;
}

export type DistributedRunArtifactAnalysis =
    | Readonly<{ variant: 'distributed-run'; analysis: DistributedRunAnalysis; }>
    | Readonly<{ variant: 'control-request-failure'; analysis: DistributedRunControlRequestFailureAnalysis; }>;

export function computeDistributedRunArtifactAnalysis(
    input: DistributedRunAnalysisInput
): Either<DistributedRunArtifactRejection, DistributedRunArtifactAnalysis> {
    const parsed = parseDistributedArtifactPipeline(input.files, { projection: 'literal-loose-files' });
    return toDistributedRunArtifactContent(parsed).mapRight((content): DistributedRunArtifactAnalysis =>
        content.variant === 'distributed-run'
            ? {
                variant: 'distributed-run',
                analysis: computeDistributedRunArtifactPipelineAnalysis({
                    parsed,
                    content,
                    generatedAtEpochMs: input.generatedAtEpochMs,
                    artifactSchemaVersion: resolveArtifactSchemaVersion(parsed)
                }).analysis
            }
            : {
                variant: 'control-request-failure',
                analysis: computeControlRequestFailureAnalysis(content, input.generatedAtEpochMs)
            }
    );
}

export function toDistributedArtifactBundle(
    files: DistributedRunArtifactFiles,
    generatedAtEpochMs: number
): Either<DistributedRunArtifactRejection, ControlDistributedRunArtifactBundle> {
    const parsed = parseDistributedArtifactPipeline(files, { projection: 'literal-loose-files' });
    return toDistributedRunBundleContent(parsed).flatMap(
        (rejection) => Either.ofLeft(rejection),
        (content) =>
            toPipelineArtifactBundle({
                parsed,
                distributedRunId: content.distributedRun.distributedRunId,
                generatedAtEpochMs,
                artifactSchemaVersion: resolveArtifactSchemaVersion(parsed)
            })
    );
}

export function toDistributedArtifactSnapshots(
    files: DistributedRunArtifactFiles,
    generatedAtEpochMs: number
): Either<DistributedRunArtifactRejection, DistributedRunArtifactSnapshots> {
    const parsed = parseDistributedArtifactPipeline(files, { projection: 'literal-loose-files' });
    return toDistributedRunBundleContent(parsed).flatMap(
        (rejection) => Either.ofLeft(rejection),
        (content) =>
            toDistributedRunContentSnapshots({
                parsed,
                content,
                generatedAtEpochMs,
                artifactSchemaVersion: resolveArtifactSchemaVersion(parsed)
            })
    );
}
