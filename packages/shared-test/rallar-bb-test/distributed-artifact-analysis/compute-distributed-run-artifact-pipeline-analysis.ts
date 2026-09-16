import { Either } from '@shared/resilience/Either.ts';

import type { ControlDistributedRunArtifactBundle } from '../control-snapshots.ts';
import type {
    DistributedRunAnalysis,
    DistributedRunAnalysisGroup,
    DistributedRunAnalysisSummary,
    DistributedRunArtifactParseWarning,
    DistributedRunArtifactRejection,
    DistributedRunArtifactSnapshots,
    DistributedRunFailedAnalysis,
    DistributedRunPassedAnalysis,
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
    toDistributedRunSummaryMarkdown
} from './to-distributed-run-analysis-markdown.ts';
import type { DistributedRunBundleContent } from './to-distributed-run-artifact-content.ts';

/** The decoded bundle content of the parsed artifact files it was read from, with the analysis time and schema version. */
export interface DistributedRunArtifactPipelineInput {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly content: DistributedRunBundleContent;
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
}

export interface DistributedRunArtifactPipelineAnalysisResult {
    readonly analysis: DistributedRunAnalysis;
    /** Absent when control-run.json is missing or malformed; the analysis warnings say why. */
    readonly snapshots?: DistributedRunArtifactSnapshots;
    readonly monitor: DistributedRunMonitor;
    readonly report: DistributedRunAnalysisReport;
}

/** A run analysis before its markdown renderings. */
export type DistributedRunAnalysisFacts =
    | Omit<DistributedRunPassedAnalysis, 'summaryMarkdown' | 'performanceMarkdown'>
    | Omit<DistributedRunFailedAnalysis, 'summaryMarkdown' | 'fixProposalMarkdown' | 'performanceMarkdown'>;

export interface ToPipelineArtifactBundleInput {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly distributedRunId: string;
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
}

interface DistributedRunAnalysisFactsInput {
    readonly content: DistributedRunBundleContent;
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    readonly spa: DistributedRunSpaAnalysis;
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

const BUNDLE_CORE_FILE_NAMES = ['distributed-run.json', 'control-run.json', 'manifest.json'] as const;

const DISTRIBUTED_ARTIFACT_V2_EVIDENCE_FILE_NAMES = ['report.json', 'failures.json', 'metadata.json'] as const;

export function computeDistributedRunArtifactPipelineAnalysis(
    input: DistributedRunArtifactPipelineInput
): DistributedRunArtifactPipelineAnalysisResult {
    const { parsed, content, generatedAtEpochMs, artifactSchemaVersion } = input;
    const { distributedRun } = content;
    const controlRun = content.controlRun.status === 'recorded' ? content.controlRun.snapshot : undefined;
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
            ...(content.controlRun.status === 'unavailable' ? [content.controlRun.reason] : []),
            ...content.parseWarnings.map((warning) => ({ ...warning })),
            ...(bundle.left ? [bundle.left] : [])
        ],
        spa: { report, verdict: deriveRunVerdictView({ distributedRun, monitor, report, artifactBundle }) }
    });
    return {
        analysis: toDistributedRunAnalysis(facts),
        ...(controlRun === undefined ? {} : { snapshots: toArtifactSnapshots(content, bundle).right }),
        monitor,
        report
    };
}

/** Snapshots need the control run; the artifact bundle rides along when the files form one. */
export function toDistributedRunContentSnapshots(
    input: DistributedRunArtifactPipelineInput
): Either<DistributedRunArtifactRejection, DistributedRunArtifactSnapshots> {
    const { parsed, content } = input;
    return toArtifactSnapshots(
        content,
        toPipelineArtifactBundle({
            parsed,
            distributedRunId: content.distributedRun.distributedRunId,
            generatedAtEpochMs: input.generatedAtEpochMs,
            artifactSchemaVersion: input.artifactSchemaVersion
        })
    );
}

/** A bundle needs the run snapshot, the control run and the manifest; other known artifact files ride along. */
export function toPipelineArtifactBundle(
    input: ToPipelineArtifactBundleInput
): Either<DistributedRunArtifactRejection, ControlDistributedRunArtifactBundle> {
    const files = input.parsed.projectedFiles;
    const missingFileName = BUNDLE_CORE_FILE_NAMES.find((fileName) => files[fileName] === undefined);
    if (missingFileName !== undefined) {
        return Either.ofLeft({
            fileName: missingFileName,
            message: `${missingFileName} is required to form a distributed-run artifact bundle.`
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
        distributedRunId: input.distributedRunId,
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

function toArtifactSnapshots(
    content: DistributedRunBundleContent,
    bundle: Either<DistributedRunArtifactRejection, ControlDistributedRunArtifactBundle>
): Either<DistributedRunArtifactRejection, DistributedRunArtifactSnapshots> {
    if (content.controlRun.status === 'unavailable') {
        return Either.ofLeft(content.controlRun.reason);
    }
    return Either.ofRight({
        distributedRun: content.distributedRun,
        controlRun: content.controlRun.snapshot,
        ...(bundle.right === undefined ? {} : { artifactBundle: bundle.right }),
        parseWarnings: [...content.parseWarnings, ...(bundle.left ? [bundle.left] : [])]
    });
}

function computeDistributedRunAnalysisFacts(input: DistributedRunAnalysisFactsInput): DistributedRunAnalysisFacts {
    const { content, spa } = input;
    const { distributedRun, fleetReport } = content;
    const ok = fleetReport?.ok ?? distributedRun.rollup.ok;
    const performance = computeRecordedPerformance(content);
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
        spa
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
        spaReport: spa.report
    });
    return { ok, ...sections, failure };
}

/** Performance needs the control run's agents, commands and results, so an unavailable control run leaves it absent. */
function computeRecordedPerformance(
    content: DistributedRunBundleContent
): DistributedRunPerformanceAnalysis | undefined {
    if (content.controlRun.status === 'unavailable') {
        return undefined;
    }
    return computeDistributedRunPerformance({
        distributedRun: content.distributedRun,
        controlRun: content.controlRun.snapshot,
        fleetReport: content.fleetReport,
        results: content.results,
        events: content.events
    });
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
