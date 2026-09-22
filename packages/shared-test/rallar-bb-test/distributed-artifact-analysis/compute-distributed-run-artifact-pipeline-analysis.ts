import { Either } from '@shared/resilience/Either.ts';

import type { ControlDistributedRunArtifactBundle, ControlRunSnapshot } from '../control-snapshots.ts';
import type {
    DistributedRunAnalysis,
    DistributedRunAnalysisGroup,
    DistributedRunAnalysisSummary,
    DistributedRunArtifactParseWarning,
    DistributedRunArtifactRejection,
    DistributedRunArtifactSnapshots,
    DistributedRunPerformanceAnalysis,
    DistributedRunSpaAnalysis,
    DistributedRunTargetResolutionAnalysis
} from '../distributed-artifact-analysis.ts';
import type { ParsedDistributedArtifactPipeline } from '../distributed-artifact-pipeline.ts';
import {
    deriveDistributedRunAnalysisReport,
    type DistributedRunAnalysisReport
} from '../distributed-run-analysis/distributed-run-analysis-report.ts';
import { deriveRunVerdictView } from '../distributed-run-analysis/run-verdict-view.ts';
import { deriveDistributedRunMonitor, type DistributedRunMonitor } from '../distributed-run-monitor.ts';
import { validateDistributedRunArtifactFromParsed } from '../distributed-run-observation/validate-distributed-run-artifact.ts';
import { computeDistributedRunPerformance } from '../distributed-run-performance/compute-distributed-run-performance.ts';
import type { RallarBlackBoxDistributedTargetResolution } from '../distributed-run.ts';
import { computeDistributedRunFailure } from './compute-distributed-run-failure.ts';
import {
    decodeAnalysisGroup,
    type DistributedRunFleetReportEvidence
} from './decode-distributed-run-report-evidence.ts';
import {
    toDistributedRunFixProposalMarkdown,
    toDistributedRunPerformanceMarkdown,
    toDistributedRunSummaryMarkdown,
    type DistributedRunAnalysisFacts
} from './to-distributed-run-analysis-markdown.ts';
import type { DistributedRunBundleContent } from './to-distributed-run-artifact-content.ts';

/** The decoded bundle content of the parsed artifact files it was read from, with the analysis time and schema version. */
export interface DistributedRunArtifactPipelineInput {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly content: DistributedRunBundleContent;
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
}

/** The pipeline analysis of a run whose control-run.json holds a control run snapshot. */
export interface DistributedRunRecordedControlRunAnalysis {
    readonly controlRunStatus: 'recorded';
    readonly analysis: DistributedRunAnalysis;
    readonly snapshots: DistributedRunArtifactSnapshots;
    readonly monitor: DistributedRunMonitor;
    readonly report: DistributedRunAnalysisReport;
}

/**
 * The pipeline analysis of a run whose control-run.json is missing or malformed. Snapshots, the monitor
 * and its report all read the control run, so none of them exists; the reason says why.
 */
export interface DistributedRunUnavailableControlRunAnalysis {
    readonly controlRunStatus: 'unavailable';
    readonly analysis: DistributedRunAnalysis;
    readonly reason: DistributedRunArtifactParseWarning;
}

export type DistributedRunArtifactPipelineAnalysisResult =
    | DistributedRunRecordedControlRunAnalysis
    | DistributedRunUnavailableControlRunAnalysis;

interface DistributedRunAnalysisFactsInput {
    readonly content: DistributedRunBundleContent;
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    /** Undefined when control-run.json is unavailable, because performance reads the control run. */
    readonly performance: DistributedRunPerformanceAnalysis | undefined;
    /** Undefined when control-run.json is unavailable, because the SPA report and verdict read the control run. */
    readonly spa: DistributedRunSpaAnalysis | undefined;
}

const DISTRIBUTED_ARTIFACT_FILE_NAMES: ReadonlySet<string> = new Set([
    'distributed-run.json',
    'manifest.json',
    'target-resolution.json',
    'runner-summary.json',
    'control-post-create-error.json',
    'control-post-stage-error.json',
    'control-post-start-error.json',
    'control-post-request-error.json',
    'control-post-error-metadata.json',
    'control-run.json',
    'fleet-report.json',
    'report.json',
    'results.jsonl',
    'events.jsonl',
    'failures.json',
    'metadata.json'
]);

const DISTRIBUTED_ARTIFACT_V2_EVIDENCE_FILE_NAMES = ['report.json', 'failures.json', 'metadata.json'] as const;

export function computeDistributedRunArtifactPipelineAnalysis(
    input: DistributedRunArtifactPipelineInput
): DistributedRunArtifactPipelineAnalysisResult {
    const { controlRun } = input.content;
    return controlRun.status === 'recorded'
        ? computeRecordedControlRunAnalysis(input, controlRun.snapshot)
        : computeUnavailableControlRunAnalysis(input, controlRun.reason);
}

/** Snapshots need the control run; the artifact bundle rides along when the files form one. */
export function toDistributedRunContentSnapshots(
    input: DistributedRunArtifactPipelineInput
): Either<DistributedRunArtifactRejection, DistributedRunArtifactSnapshots> {
    const { controlRun } = input.content;
    return controlRun.status === 'recorded'
        ? Either.ofRight(toRecordedSnapshots(input, controlRun.snapshot))
        : Either.ofLeft(controlRun.reason);
}

/** A bundle needs the decoded run snapshot, a recorded control run and manifest.json; other known artifact files ride along. */
export function toPipelineArtifactBundle(
    input: DistributedRunArtifactPipelineInput
): Either<DistributedRunArtifactRejection, ControlDistributedRunArtifactBundle> {
    const { parsed, content } = input;
    if (content.controlRun.status === 'unavailable') {
        return Either.ofLeft(content.controlRun.reason);
    }
    const files = parsed.projectedFiles;
    if (files['manifest.json'] === undefined) {
        return Either.ofLeft({
            fileName: 'manifest.json',
            message: 'manifest.json is required to form a distributed-run artifact bundle.'
        });
    }
    const bundleFiles: Record<string, string> = {};
    for (const [fileName, text] of Object.entries(files)) {
        if (text !== undefined && DISTRIBUTED_ARTIFACT_FILE_NAMES.has(fileName)) {
            bundleFiles[fileName] = text;
        }
    }
    return Either.ofRight({
        artifactSchemaVersion: input.artifactSchemaVersion,
        distributedRunId: content.distributedRun.distributedRunId,
        generatedAtEpochMs: input.generatedAtEpochMs,
        files: bundleFiles as ControlDistributedRunArtifactBundle['files']
    });
}

/** Artifacts carrying the report, failures and metadata files are schema v2; the rest are v1. */
export function resolveArtifactSchemaVersion(parsed: ParsedDistributedArtifactPipeline): number {
    return DISTRIBUTED_ARTIFACT_V2_EVIDENCE_FILE_NAMES.every((fileName) =>
            parsed.projectedFiles[fileName] !== undefined
        )
        ? 2
        : 1;
}

function computeRecordedControlRunAnalysis(
    input: DistributedRunArtifactPipelineInput,
    controlRun: ControlRunSnapshot
): DistributedRunRecordedControlRunAnalysis {
    const { content } = input;
    const { distributedRun } = content;
    const snapshots = toRecordedSnapshots(input, controlRun);
    const { artifactBundle } = snapshots;
    const monitor = deriveDistributedRunMonitor({
        distributedRun,
        controlRun,
        artifactBundle,
        artifactValidation: validateDistributedRunArtifactFromParsed(artifactBundle, input.parsed)
    });
    const report = deriveDistributedRunAnalysisReport({ distributedRun, controlRun, artifactBundle, monitor });
    const facts = computeDistributedRunAnalysisFacts({
        content,
        generatedAtEpochMs: input.generatedAtEpochMs,
        artifactSchemaVersion: input.artifactSchemaVersion,
        parseWarnings: snapshots.parseWarnings.map((warning) => ({ ...warning })),
        performance: computeDistributedRunPerformance({
            distributedRun,
            controlRun,
            fleetReport: content.fleetReport,
            results: content.results,
            events: content.events
        }),
        spa: { report, verdict: deriveRunVerdictView({ distributedRun, monitor, report, artifactBundle }) }
    });
    return { controlRunStatus: 'recorded', analysis: toDistributedRunAnalysis(facts), snapshots, monitor, report };
}

/** The reason leads the warnings; performance and the SPA sections read the control run, so they are left out. */
function computeUnavailableControlRunAnalysis(
    input: DistributedRunArtifactPipelineInput,
    reason: DistributedRunArtifactParseWarning
): DistributedRunUnavailableControlRunAnalysis {
    const { content } = input;
    const facts = computeDistributedRunAnalysisFacts({
        content,
        generatedAtEpochMs: input.generatedAtEpochMs,
        artifactSchemaVersion: input.artifactSchemaVersion,
        parseWarnings: [reason, ...content.parseWarnings].map((warning) => ({ ...warning })),
        performance: undefined,
        spa: undefined
    });
    return { controlRunStatus: 'unavailable', analysis: toDistributedRunAnalysis(facts), reason };
}

function toRecordedSnapshots(
    input: DistributedRunArtifactPipelineInput,
    controlRun: ControlRunSnapshot
): DistributedRunArtifactSnapshots {
    const { content } = input;
    const bundle = toPipelineArtifactBundle(input);
    return {
        distributedRun: content.distributedRun,
        controlRun,
        ...(bundle.right === undefined ? {} : { artifactBundle: bundle.right }),
        parseWarnings: [...content.parseWarnings, ...(bundle.left ? [bundle.left] : [])]
    };
}

function computeDistributedRunAnalysisFacts(input: DistributedRunAnalysisFactsInput): DistributedRunAnalysisFacts {
    const { content, performance, spa } = input;
    const { distributedRun, fleetReport } = content;
    const ok = fleetReport?.ok ?? distributedRun.rollup.ok;
    const targetResolution = content.targetResolution ?? distributedRun.targetResolution;
    const sections = {
        generatedAtEpochMs: input.generatedAtEpochMs,
        artifactSchemaVersion: input.artifactSchemaVersion,
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        status: distributedRun.state,
        // distributed-run.json decoding checks the manifest only as an object, so its group is decoded here.
        group: resolveAnalysisGroup(decodeAnalysisGroup(distributedRun.manifest.group), fleetReport),
        summary: computeAnalysisSummary(content, performance, ok),
        parseWarnings: input.parseWarnings,
        ...(performance === undefined ? {} : { performance }),
        targetResolution: targetResolution === undefined ? undefined : toTargetResolutionAnalysis(targetResolution),
        ...(spa === undefined ? {} : { spa })
    };
    if (ok) {
        return { ok, ...sections };
    }
    const failure = computeDistributedRunFailure({
        distributedRun,
        fleetReport,
        bundledFailure: content.bundledFailure,
        controlPostFailure: content.controlPostFailure,
        results: content.results,
        events: content.events,
        spaReport: spa?.report
    });
    return { ok, ...sections, failure };
}

/** The fleet report's counts win; without one the run snapshot and the measured performance stand in. */
function computeAnalysisSummary(
    content: DistributedRunBundleContent,
    performance: DistributedRunPerformanceAnalysis | undefined,
    ok: boolean
): DistributedRunAnalysisSummary {
    const { distributedRun, fleetReport } = content;
    const agents = fleetReport?.agents ?? performance?.agentCount;
    return {
        ...(agents === undefined ? {} : { agents }),
        passRate: fleetReport?.passRate ?? (distributedRun.rollup.ok ? 1 : 0),
        failureGroups: fleetReport?.failureGroups ?? (ok ? 0 : 1),
        blockingFailures: distributedRun.rollup.summary.blockingFailures
    };
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
    const summaryMarkdown = toDistributedRunSummaryMarkdown(facts);
    const performanceMarkdown = facts.performance === undefined
        ? {}
        : { performanceMarkdown: toDistributedRunPerformanceMarkdown(facts.distributedRunId, facts.performance) };
    return facts.ok
        ? { ...facts, summaryMarkdown, ...performanceMarkdown }
        : {
            ...facts,
            summaryMarkdown,
            fixProposalMarkdown: toDistributedRunFixProposalMarkdown(facts),
            ...performanceMarkdown
        };
}
