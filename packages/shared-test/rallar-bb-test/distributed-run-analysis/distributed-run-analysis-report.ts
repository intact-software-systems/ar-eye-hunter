import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlSnapshotBounds
} from '../control-snapshots.ts';
import { computeDistributedRunDuration } from '../distributed-run-history/compute-distributed-run-duration.ts';
import {
    getDistributedRunMonitorAnalysisReuse,
    getDistributedRunMonitorFirstPhase,
    setDistributedRunAnalysisReportDerivation,
    type DistributedRunMonitorAnalysisReuse
} from '../distributed-run-monitor-index.ts';
import { deriveDistributedRunMonitor, type DistributedRunMonitor } from '../distributed-run-monitor.ts';
import { resolveFirstDistributedFailure } from '../distributed-run-observation/distributed-run-failure-rows.ts';
import type {
    DistributedRunArtifactValidationStatus,
    DistributedRunFailureRow,
    DistributedRunProgressStatus,
    DistributedRunRecipeProgressRow,
    DistributedRunRuntimeDiagnosticRow
} from '../distributed-run-observation/distributed-run-row-contracts.ts';
import type {
    DistributedFailureExplanation,
    FirstDistributedRunPhaseForCommand
} from './distributed-failure-explanation-contracts.ts';
import { toDistributedFailureExplanations } from './distributed-failure-explanations.ts';
import { toDistributedFailureCategory } from './to-distributed-failure-explanation.ts';

export type DistributedRunAnalysisReport = Readonly<{
    distributedRunId: string;
    summary: Readonly<{
        state: string;
        ok: boolean;
        durationMs?: number;
        targetCount: number;
        commandCount: number;
        completedCommandCount: number;
        failedCommandCount: number;
        resultCount: number;
        failedResultCount: number;
        artifactStatus: DistributedRunArtifactValidationStatus;
        snapshotMayBeTruncated: boolean;
        snapshotWarnings: readonly string[];
    }>;
    firstFailure?: Readonly<{
        category: DistributedFailureExplanation['category'];
        key: string;
        kind: DistributedRunFailureRow['kind'];
        message: string;
        code?: string;
        agentId?: string;
        recipeId?: string;
        commandId?: string;
        atEpochMs?: number;
    }>;
    agents: readonly Readonly<{
        agentId: string;
        role?: string;
        readiness: DistributedRunProgressStatus;
        barrier: DistributedRunProgressStatus;
        execution: DistributedRunProgressStatus;
        eventCount: number;
        failedCommandCount: number;
        reconnectCount?: number;
        lastHeartbeatAtEpochMs?: number;
    }>[];
    recipes: readonly DistributedRunRecipeProgressRow[];
    diagnostics: Readonly<{
        total: number;
        warnings: number;
        errors: number;
        ws: number;
        rtc: number;
        correlated: readonly DistributedRunRuntimeDiagnosticRow[];
    }>;
    nextActions: readonly DistributedFailureExplanation[];
    rawEvidence: Readonly<{
        failureKeys: readonly string[];
        diagnosticIds: readonly string[];
        artifactStatus: DistributedRunArtifactValidationStatus;
        artifactMessage: string;
    }>;
}>;

export function deriveDistributedRunAnalysisReport(
    input: Readonly<{
        distributedRun: ControlDistributedRunSnapshot;
        controlRun?: ControlRunSnapshot;
        artifactBundle?: ControlDistributedRunArtifactBundle;
        snapshotBounds?: ControlSnapshotBounds;
        monitor?: DistributedRunMonitor;
    }>
): DistributedRunAnalysisReport {
    const monitor = input.monitor ?? deriveDistributedRunMonitor(input);
    const analysisReuse = getDistributedRunMonitorAnalysisReuse(
        monitor,
        input.distributedRun
    );
    const reportWork = createReportWork();
    const firstPhaseForCommand = createReportFirstPhaseLookup({
        analysisReuse,
        commandLinks: input.distributedRun.commandLinks,
        reportWork
    });
    const firstFailure = resolveFirstDistributedFailure(monitor.failures);
    const explanations = toDistributedFailureExplanations({
        distributedRun: input.distributedRun,
        monitor,
        firstFailure,
        firstPhaseForCommand
    });
    const controlAgents = new Map((input.controlRun?.agents ?? []).map((agent) => [agent.agentId, agent]));
    const snapshotWarnings = toDistributedSnapshotWarnings(input.controlRun, input.snapshotBounds);
    const firstExplanation = firstFailure
        ? explanations.find((explanation) => explanation.evidence.includes(firstFailure.key)) ??
            explanations[0]
        : undefined;

    const report: DistributedRunAnalysisReport = {
        distributedRunId: input.distributedRun.distributedRunId,
        summary: toReportSummary({
            distributedRun: input.distributedRun,
            monitor,
            snapshotWarnings
        }),
        firstFailure: toReportFirstFailure(firstFailure, firstExplanation),
        agents: toReportAgentRows(monitor, controlAgents),
        recipes: monitor.recipeProgress,
        diagnostics: toReportDiagnostics(monitor),
        nextActions: explanations,
        rawEvidence: toReportRawEvidence(monitor)
    };
    setDistributedRunAnalysisReportDerivation(report, monitor, reportWork);
    return report;
}

function toReportDiagnostics(monitor: DistributedRunMonitor): DistributedRunAnalysisReport['diagnostics'] {
    return {
        total: monitor.diagnosticCounts.total,
        warnings: monitor.diagnosticCounts.warning,
        errors: monitor.diagnosticCounts.error,
        ws: monitor.diagnosticCounts.ws,
        rtc: monitor.diagnosticCounts.rtc,
        correlated: monitor.runtimeDiagnostics.filter((row) => row.correlatedFailureKeys.length > 0)
    };
}

function toReportRawEvidence(monitor: DistributedRunMonitor): DistributedRunAnalysisReport['rawEvidence'] {
    return {
        failureKeys: monitor.failures.map((failure) => failure.key),
        diagnosticIds: monitor.runtimeDiagnostics.map((row) => row.eventId),
        artifactStatus: monitor.artifact.status,
        artifactMessage: monitor.artifact.message
    };
}

function toReportSummary(
    input: Readonly<{
        distributedRun: ControlDistributedRunSnapshot;
        monitor: DistributedRunMonitor;
        snapshotWarnings: readonly string[];
    }>
): DistributedRunAnalysisReport['summary'] {
    const { distributedRun, monitor, snapshotWarnings } = input;
    return {
        state: distributedRun.state,
        ok: distributedRun.rollup.ok,
        durationMs: computeDistributedRunDuration(distributedRun),
        targetCount: distributedRun.targetAgentIds.length,
        commandCount: monitor.commandCounts.total,
        completedCommandCount: monitor.commandCounts.completed,
        failedCommandCount: monitor.commandCounts.failed,
        resultCount: monitor.resultCounts.total,
        failedResultCount: monitor.resultCounts.failed,
        artifactStatus: monitor.artifact.status,
        snapshotMayBeTruncated: snapshotWarnings.length > 0,
        snapshotWarnings
    };
}

function toReportFirstFailure(
    firstFailure: DistributedRunFailureRow | undefined,
    firstExplanation: DistributedFailureExplanation | undefined
): DistributedRunAnalysisReport['firstFailure'] {
    if (!firstFailure) {
        return undefined;
    }
    return {
        category: firstExplanation?.category ?? toDistributedFailureCategory(firstFailure),
        key: firstFailure.key,
        kind: firstFailure.kind,
        message: firstFailure.message,
        code: firstFailure.code,
        agentId: firstFailure.agentId,
        recipeId: firstFailure.recipeId,
        commandId: firstFailure.commandId,
        atEpochMs: firstFailure.atEpochMs
    };
}

interface ReportWork {
    reportCommandLinkLookupCount: number;
    reportFallbackCommandLinkIndexPassCount: number;
    reportFallbackCommandLinkVisitCount: number;
    reportFallbackCommandPhaseLookupCount: number;
}

function createReportWork(): ReportWork {
    return {
        reportCommandLinkLookupCount: 0,
        reportFallbackCommandLinkIndexPassCount: 0,
        reportFallbackCommandLinkVisitCount: 0,
        reportFallbackCommandPhaseLookupCount: 0
    };
}

/**
 * The fallback link index is built on the first command that needs a phase, so a
 * report without failures never walks the command links.
 */
function createReportFirstPhaseLookup(
    input: Readonly<{
        analysisReuse: DistributedRunMonitorAnalysisReuse | undefined;
        commandLinks: readonly ControlDistributedRunCommandLink[];
        reportWork: ReportWork;
    }>
): FirstDistributedRunPhaseForCommand {
    const { analysisReuse, reportWork } = input;
    let fallbackFirstPhasesByCommandId: ReadonlyMap<string, ControlDistributedRunCommandLink['phase']> | undefined;
    return (commandId) => {
        if (analysisReuse !== undefined) {
            if (commandId !== undefined) {
                reportWork.reportCommandLinkLookupCount += 1;
            }
            return getDistributedRunMonitorFirstPhase(analysisReuse, commandId);
        }
        if (commandId === undefined) {
            return undefined;
        }
        reportWork.reportFallbackCommandPhaseLookupCount += 1;
        if (fallbackFirstPhasesByCommandId === undefined) {
            reportWork.reportFallbackCommandLinkIndexPassCount += 1;
            fallbackFirstPhasesByCommandId = toFirstDistributedRunPhasesByCommandId(
                input.commandLinks,
                reportWork
            );
        }
        return fallbackFirstPhasesByCommandId.get(commandId);
    };
}

function toReportAgentRows(
    monitor: DistributedRunMonitor,
    controlAgents: ReadonlyMap<string, ControlRunSnapshot['agents'][number]>
): DistributedRunAnalysisReport['agents'] {
    return monitor.agentProgress.map((row) => {
        const agent = controlAgents.get(row.agentId);
        return {
            agentId: row.agentId,
            role: row.role,
            readiness: row.readiness,
            barrier: row.barrier,
            execution: row.execution,
            eventCount: row.eventCount,
            failedCommandCount: row.failedCommandCount,
            reconnectCount: agent?.reconnectCount,
            lastHeartbeatAtEpochMs: agent?.lastHeartbeatAtEpochMs
        };
    });
}

function toFirstDistributedRunPhasesByCommandId(
    links: readonly ControlDistributedRunCommandLink[],
    work: { reportFallbackCommandLinkVisitCount: number; }
): ReadonlyMap<string, ControlDistributedRunCommandLink['phase']> {
    const firstPhasesByCommandId = new Map<string, ControlDistributedRunCommandLink['phase']>();
    for (const link of links) {
        work.reportFallbackCommandLinkVisitCount += 1;
        if (!firstPhasesByCommandId.has(link.commandId)) {
            firstPhasesByCommandId.set(link.commandId, link.phase);
        }
    }
    return firstPhasesByCommandId;
}

function toDistributedSnapshotWarnings(
    controlRun: ControlRunSnapshot | undefined,
    bounds: ControlSnapshotBounds | undefined
): readonly string[] {
    if (!controlRun || !bounds) {
        return [];
    }
    const checks: ReadonlyArray<readonly [keyof ControlSnapshotBounds, number]> = [
        ['commands', controlRun.commands.length],
        ['results', controlRun.results.length],
        ['events', controlRun.events.length],
        ['stats', controlRun.stats.length],
        ['reports', controlRun.reports.length],
        ['heartbeats', controlRun.heartbeats.length]
    ];
    return checks.flatMap(([key, count]) => {
        const bound = bounds[key];
        return bound !== undefined && bound > 0 && count >= bound
            ? [`Loaded ${count} ${key}; evidence may be truncated by the current snapshot bound.`]
            : [];
    });
}
