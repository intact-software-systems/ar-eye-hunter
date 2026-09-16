import { Either } from '@shared/resilience/Either.ts';

import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from './control-snapshots.ts';
import { computeControlRequestFailureAnalysis } from './distributed-artifact-analysis/compute-control-request-failure.ts';
import { computeDistributedRunFailure } from './distributed-artifact-analysis/compute-distributed-run-failure.ts';
import type { DistributedRunControlPostRequest } from './distributed-artifact-analysis/decode-control-post-request.ts';
import {
    decodeAnalysisGroup,
    type DistributedRunFleetReportEvidence
} from './distributed-artifact-analysis/decode-distributed-run-report-evidence.ts';
import type { DistributedRunRunnerSummary } from './distributed-artifact-analysis/decode-distributed-run-runner-summary.ts';
import {
    toDistributedRunFixProposalMarkdown,
    toDistributedRunPerformanceMarkdown,
    toDistributedRunSummaryMarkdown
} from './distributed-artifact-analysis/to-distributed-run-analysis-markdown.ts';
import {
    toDistributedRunArtifactContent,
    toDistributedRunBundleContent,
    type DistributedRunBundleContent
} from './distributed-artifact-analysis/to-distributed-run-artifact-content.ts';
import {
    resolveArtifactSchemaVersion,
    toPipelineArtifactBundle
} from './distributed-artifact-analysis/to-pipeline-artifact-bundle.ts';
import {
    parseDistributedArtifactPipeline,
    type ParsedDistributedArtifactPipeline
} from './distributed-artifact-pipeline.ts';
import {
    deriveDistributedRunAnalysisReport,
    type DistributedRunAnalysisReport
} from './distributed-run-analysis/distributed-run-analysis-report.ts';
import { deriveRunVerdictView, type RunVerdictView } from './distributed-run-analysis/run-verdict-view.ts';
import { deriveDistributedRunMonitor, type DistributedRunMonitor } from './distributed-run-monitor.ts';
import { validateDistributedRunArtifactFromParsed } from './distributed-run-observation/validate-distributed-run-artifact.ts';
import { computeDistributedRunPerformance } from './distributed-run-performance/compute-distributed-run-performance.ts';
import type { RallarBlackBoxDistributedTargetResolution } from './distributed-run.ts';

export type DistributedRunArtifactFiles = Readonly<Record<string, string | undefined>>;

export interface DistributedRunAnalysisInput {
    readonly files: DistributedRunArtifactFiles;
    readonly generatedAtEpochMs: number;
    /** Absent when the analysis takes the schema version the artifact files imply. */
    readonly artifactSchemaVersion?: number;
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
 * Duration statistics over the sampled durations, or the recorded timing when none were sampled; each one is
 * absent when no duration was sampled and the recorded timing omits it.
 */
export interface DistributedRunTimingSummary {
    readonly count?: number;
    readonly minMs?: number;
    readonly p50Ms?: number;
    readonly p95Ms?: number;
    readonly p99Ms?: number;
    readonly maxMs?: number;
    readonly averageMs?: number;
    /** Absent without both a median and a p95. */
    readonly spreadRatio?: number;
    readonly outlierCount?: number;
}

export interface DistributedRunSlowestAgent {
    readonly agentId: string;
    readonly commandCount: number;
    /** The analysis always writes it; performance evidence assembled elsewhere may omit it. */
    readonly averageMs?: number;
    /** The analysis always writes it; performance evidence assembled elsewhere may omit it. */
    readonly maxMs?: number;
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
    /** The analysis always writes it; performance evidence assembled elsewhere may omit it. */
    readonly minReceivedMessages?: number;
    /** The analysis always writes it; performance evidence assembled elsewhere may omit it. */
    readonly medianReceivedMessages?: number;
    /** The analysis always writes it; performance evidence assembled elsewhere may omit it. */
    readonly p95ReceivedMessages?: number;
    /** The analysis always writes it; performance evidence assembled elsewhere may omit it. */
    readonly maxReceivedMessages?: number;
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
    readonly agents: number;
    readonly passRate: number;
    readonly failureGroups: number;
    readonly blockingFailures: number;
}

export interface DistributedRunSpaAnalysis {
    readonly report: DistributedRunAnalysisReport;
    readonly verdict: RunVerdictView;
}

export interface DistributedRunAnalysis {
    readonly generatedAtEpochMs: number;
    /** The analysis always writes it; projections of the analysis for the Analyze view may omit it. */
    readonly artifactSchemaVersion?: number;
    readonly distributedRunId: string;
    /** The analysis always writes it; projections of the analysis for the Analyze view may omit it. */
    readonly controlRunId?: string;
    readonly status: string;
    readonly ok: boolean;
    /** Absent when neither the manifest nor fleet-report.json names the run group. */
    readonly group?: DistributedRunAnalysisGroup;
    readonly summary: DistributedRunAnalysisSummary;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    /** Absent when the run passed. */
    readonly failure?: DistributedRunFailureAnalysis;
    /** The analysis always writes it; projections of the analysis for the Analyze view may omit it. */
    readonly performance?: DistributedRunPerformanceAnalysis;
    /** Absent when neither target-resolution.json nor the run snapshot records target resolution. */
    readonly targetResolution?: DistributedRunTargetResolutionAnalysis;
    /** The analysis always writes it; projections of the analysis for the Analyze view may omit it. */
    readonly spa?: DistributedRunSpaAnalysis;
    readonly summaryMarkdown: string;
    /** Absent when the run passed. */
    readonly fixProposalMarkdown?: string;
    /** The analysis always writes it; projections of the analysis for the Analyze view may omit it. */
    readonly performanceMarkdown?: string;
}

/** A run analysis before its markdown renderings. */
export interface DistributedRunAnalysisFacts
    extends
        Omit<
            DistributedRunAnalysis,
            'performance' | 'spa' | 'summaryMarkdown' | 'fixProposalMarkdown' | 'performanceMarkdown'
        > {
    readonly artifactSchemaVersion: number;
    readonly controlRunId: string;
    readonly performance: DistributedRunPerformanceAnalysis;
    readonly spa: DistributedRunSpaAnalysis;
}

export interface DistributedRunSnapshots {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlRun: ControlRunSnapshot;
}

export interface DistributedRunArtifactSnapshots extends DistributedRunSnapshots {
    /** Absent when the artifact files cannot form a bundle; the analysis warnings say why. */
    readonly artifactBundle?: ControlDistributedRunArtifactBundle;
}

/** The analysis of artifacts that record a failed control request instead of a distributed run. */
export interface DistributedRunControlRequestFailureAnalysis {
    readonly generatedAtEpochMs: number;
    /** Absent when the runner stopped before it wrote runner-summary.json. */
    readonly runnerSummary?: DistributedRunRunnerSummary;
    readonly ok: false;
    readonly request: DistributedRunControlPostRequest;
    /** Absent when the failed request returned no response body. */
    readonly responseBody?: string;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    readonly failure: DistributedRunFailureAnalysis;
    readonly summaryMarkdown: string;
    readonly fixProposalMarkdown: string;
}

export type DistributedRunArtifactAnalysis =
    | Readonly<{ variant: 'distributed-run'; analysis: DistributedRunAnalysis; }>
    | Readonly<{ variant: 'control-request-failure'; analysis: DistributedRunControlRequestFailureAnalysis; }>;

export interface DistributedRunArtifactPipelineAnalysisInput {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly content: DistributedRunBundleContent;
    readonly generatedAtEpochMs: number;
    /** Absent when the analysis takes the schema version the artifact files imply. */
    readonly artifactSchemaVersion?: number;
}

export interface DistributedRunArtifactPipelineAnalysisResult {
    readonly analysis: DistributedRunAnalysis;
    readonly snapshots: DistributedRunArtifactSnapshots;
    readonly monitor: DistributedRunMonitor;
    readonly report: DistributedRunAnalysisReport;
    readonly telemetry: DistributedRunAnalysisDerivationTelemetry;
}

export interface DistributedRunAnalysisDerivationTelemetry {
    readonly monitorDerivationCount: number;
    readonly reportDerivationCount: number;
}

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
                    artifactSchemaVersion: input.artifactSchemaVersion
                }).analysis
            }
            : {
                variant: 'control-request-failure',
                analysis: computeControlRequestFailureAnalysis(content, input.generatedAtEpochMs)
            }
    );
}

export function computeDistributedRunArtifactPipelineAnalysis(
    input: DistributedRunArtifactPipelineAnalysisInput
): DistributedRunArtifactPipelineAnalysisResult {
    const { parsed, content, generatedAtEpochMs } = input;
    const { distributedRun, controlRun } = content.snapshots;
    const artifactSchemaVersion = input.artifactSchemaVersion ?? resolveArtifactSchemaVersion(parsed);
    const bundle = toPipelineArtifactBundle({
        parsed,
        distributedRunId: distributedRun.distributedRunId,
        generatedAtEpochMs,
        artifactSchemaVersion
    });
    const artifactBundle = bundle.right;
    const monitor = deriveDistributedRunMonitor({
        distributedRun,
        controlRun,
        artifactBundle,
        artifactValidation: validateDistributedRunArtifactFromParsed(artifactBundle, parsed)
    });
    const report = deriveDistributedRunAnalysisReport({ distributedRun, controlRun, artifactBundle, monitor });
    const facts = computeDistributedRunAnalysisFacts({
        content,
        generatedAtEpochMs,
        artifactSchemaVersion,
        parseWarnings: [
            ...content.parseWarnings.map((warning) => ({ ...warning })),
            ...(bundle.left ? [bundle.left] : [])
        ],
        spa: { report, verdict: deriveRunVerdictView({ distributedRun, monitor, report, artifactBundle }) }
    });
    return {
        analysis: toDistributedRunAnalysis(facts),
        snapshots: { distributedRun, controlRun, ...(artifactBundle === undefined ? {} : { artifactBundle }) },
        monitor,
        report,
        telemetry: { monitorDerivationCount: 1, reportDerivationCount: 1 }
    };
}

export function toDistributedArtifactBundle(
    files: DistributedRunArtifactFiles,
    generatedAtEpochMs: number,
    artifactSchemaVersion?: number
): Either<DistributedRunArtifactRejection, ControlDistributedRunArtifactBundle> {
    const parsed = parseDistributedArtifactPipeline(files, { projection: 'literal-loose-files' });
    return toDistributedRunBundleContent(parsed).flatMap(
        (rejection) => Either.ofLeft(rejection),
        (content) =>
            toPipelineArtifactBundle({
                parsed,
                distributedRunId: content.snapshots.distributedRun.distributedRunId,
                generatedAtEpochMs,
                artifactSchemaVersion: artifactSchemaVersion ?? resolveArtifactSchemaVersion(parsed)
            })
    );
}

export function toDistributedArtifactSnapshots(
    files: DistributedRunArtifactFiles,
    generatedAtEpochMs: number,
    artifactSchemaVersion?: number
): Either<DistributedRunArtifactRejection, DistributedRunArtifactSnapshots> {
    const parsed = parseDistributedArtifactPipeline(files, { projection: 'literal-loose-files' });
    return toDistributedRunBundleContent(parsed).mapRight((content) => {
        const bundle = toPipelineArtifactBundle({
            parsed,
            distributedRunId: content.snapshots.distributedRun.distributedRunId,
            generatedAtEpochMs,
            artifactSchemaVersion: artifactSchemaVersion ?? resolveArtifactSchemaVersion(parsed)
        });
        return {
            ...content.snapshots,
            ...(bundle.right === undefined ? {} : { artifactBundle: bundle.right })
        };
    });
}

interface DistributedRunAnalysisFactsInput {
    readonly content: DistributedRunBundleContent;
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    readonly spa: DistributedRunSpaAnalysis;
}

function computeDistributedRunAnalysisFacts(input: DistributedRunAnalysisFactsInput): DistributedRunAnalysisFacts {
    const { content, spa } = input;
    const { distributedRun } = content.snapshots;
    const { fleetReport } = content;
    const ok = fleetReport?.ok ?? distributedRun.rollup.ok;
    const performance = computeDistributedRunPerformance({
        ...content.snapshots,
        fleetReport,
        results: content.results,
        events: content.events
    });
    const failure = ok
        ? undefined
        : computeDistributedRunFailure({
            distributedRun,
            fleetReport,
            bundledFailure: content.bundledFailure,
            controlPostFailure: content.controlPostFailure,
            results: content.results,
            events: content.events,
            spaReport: spa.report
        });
    const identity = {
        generatedAtEpochMs: input.generatedAtEpochMs,
        artifactSchemaVersion: input.artifactSchemaVersion,
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        status: distributedRun.state
    };
    const overview = {
        // distributed-run.json decoding checks the manifest only as an object, so its group is decoded here.
        group: resolveAnalysisGroup(decodeAnalysisGroup(distributedRun.manifest.group), fleetReport),
        summary: {
            agents: fleetReport?.agents ?? performance.agentCount,
            passRate: fleetReport?.passRate ?? performance.passRate,
            failureGroups: fleetReport?.failureGroups ?? (failure ? 1 : 0),
            blockingFailures: distributedRun.rollup.summary.blockingFailures
        },
        parseWarnings: input.parseWarnings
    };
    const targetResolution = content.targetResolution ?? distributedRun.targetResolution;
    const evidence = {
        performance,
        targetResolution: targetResolution === undefined ? undefined : toTargetResolutionAnalysis(targetResolution),
        spa
    };
    return { ...identity, ok, ...overview, failure, ...evidence };
}

/** The manifest group wins; the fleet report group stands in only when the manifest names none. */
function resolveAnalysisGroup(
    manifestGroup: DistributedRunAnalysisGroup | undefined,
    fleetReport: DistributedRunFleetReportEvidence | undefined
): DistributedRunAnalysisGroup | undefined {
    return manifestGroup ?? fleetReport?.group;
}

function toTargetResolutionAnalysis(
    resolution: RallarBlackBoxDistributedTargetResolution
): DistributedRunTargetResolutionAnalysis {
    const { summary } = resolution;
    return {
        selected: summary.selected,
        expectedParticipantCount: summary.expectedParticipantCount,
        missingExpectedParticipants: summary.missingExpectedParticipants,
        blockers: resolution.blockers.length,
        staleAgents: summary.staleAgents,
        offlineAgents: summary.offlineAgents,
        wrongGroupAgents: summary.wrongGroupAgents,
        agentsWithoutIdentity: summary.agentsWithoutIdentity,
        roleCounts: toCountsByName(summary.roleCounts),
        regions: toCountsByName(summary.regions),
        providers: toCountsByName(summary.providers),
        targetAgentIds: resolution.targetAgentIds,
        blockingAgentIds: resolution.blockers.map((blocker) => blocker.agentId)
    };
}

function toCountsByName(counts: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
    return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function toDistributedRunAnalysis(facts: DistributedRunAnalysisFacts): DistributedRunAnalysis {
    return {
        ...facts,
        summaryMarkdown: toDistributedRunSummaryMarkdown(facts),
        fixProposalMarkdown: facts.failure ? toDistributedRunFixProposalMarkdown(facts, facts.failure) : undefined,
        performanceMarkdown: toDistributedRunPerformanceMarkdown(facts.distributedRunId, facts.performance)
    };
}
