import type { DistributedRunMonitor } from '../distributed-run-monitor.ts';
import type {
    DistributedRunFailureRow,
    DistributedRunRuntimeDiagnosticRow
} from '../distributed-run-observation/distributed-run-row-contracts.ts';
import type { DistributedRunAnalysisReport } from './distributed-run-analysis-report.ts';
import type { RunVerdictTone } from './run-verdict-view.ts';
import { toCompactStrings } from './to-compact-strings.ts';
import { toRunVerdictStreamPerformanceItem } from './to-run-verdict-stream-performance-item.ts';

export type RunCausalTrailItem = Readonly<{
    kind:
        | 'failure-category'
        | 'command-result'
        | 'stream-performance'
        | 'diagnostic'
        | 'artifact'
        | 'events';
    label: string;
    detail: string;
    tone: RunVerdictTone;
    targetKind?: 'command' | 'diagnostic' | 'artifact' | 'event' | 'agent';
    targetId?: string;
    actionLabel?: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    atEpochMs?: number;
    evidence: readonly string[];
}>;

export function runCausalTrailForFailure(
    input: Readonly<{
        causalTrail: readonly RunCausalTrailItem[];
        failure: DistributedRunFailureRow;
        runtimeDiagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
    }>
): readonly RunCausalTrailItem[] {
    const directDiagnosticIds = new Set(
        input.runtimeDiagnostics
            .filter((row) => row.correlatedFailureKeys.includes(input.failure.key))
            .map((row) => row.eventId)
    );

    return input.causalTrail.filter((item) => {
        if (item.kind === 'artifact') {
            return true;
        }
        if (item.kind === 'diagnostic') {
            return item.targetId !== undefined && directDiagnosticIds.has(item.targetId);
        }
        if (input.failure.kind === 'command') {
            return item.commandId === input.failure.commandId;
        }
        if (input.failure.kind === 'recipe') {
            return item.commandId === undefined && item.recipeId === input.failure.recipeId;
        }
        if (input.failure.kind === 'participant') {
            return item.commandId === undefined && item.agentId === input.failure.agentId;
        }
        return item.commandId === undefined && item.agentId === undefined &&
            item.recipeId === undefined;
    });
}

export function toRunVerdictCausalTrail(
    report: DistributedRunAnalysisReport,
    monitor: DistributedRunMonitor
): readonly RunCausalTrailItem[] {
    const firstFailure = report.firstFailure;
    if (!firstFailure) {
        return [];
    }

    const firstAction = report.nextActions.find((action) => action.evidence.includes(firstFailure.key)) ??
        report.nextActions[0];
    const correlatedDiagnostics = report.diagnostics.correlated.filter((row) =>
        row.correlatedFailureKeys.includes(firstFailure.key)
    );
    const diagnosticEvidence = correlatedDiagnostics.length > 0
        ? correlatedDiagnostics.map((row) => row.eventId)
        : report.rawEvidence.diagnosticIds.slice(0, 3);
    const eventEvidence = monitor.events
        .filter((event) =>
            event.commandId === firstFailure.commandId ||
            event.agentId === firstFailure.agentId
        )
        .map((event) => event.eventId);
    const streamPerformanceItem = toRunVerdictStreamPerformanceItem({
        report,
        monitor,
        firstFailure,
        firstActionCategory: firstAction?.category,
        eventEvidence
    });

    return [
        toFailureCategoryItem(firstFailure, firstAction),
        toCommandResultItem(firstFailure),
        ...(streamPerformanceItem ? [streamPerformanceItem] : []),
        toDiagnosticItem({ firstFailure, correlatedDiagnostics, diagnosticEvidence }),
        toArtifactItem(report),
        toLinkedEventsItem(firstFailure, eventEvidence)
    ];
}

type FirstFailure = NonNullable<DistributedRunAnalysisReport['firstFailure']>;

function toFailureCategoryItem(
    firstFailure: FirstFailure,
    firstAction: DistributedRunAnalysisReport['nextActions'][number] | undefined
): RunCausalTrailItem {
    return {
        kind: 'failure-category',
        label: firstAction?.title ?? 'Failure category',
        detail: firstAction?.likelyCause ?? firstFailure.message,
        tone: 'bad',
        targetKind: firstFailure.commandId ? 'command' : 'agent',
        targetId: firstFailure.commandId ?? firstFailure.agentId,
        actionLabel: firstFailure.commandId
            ? `Open command ${firstFailure.commandId}`
            : firstFailure.agentId
            ? `Inspect agent ${firstFailure.agentId}`
            : 'Inspect first failure',
        agentId: firstFailure.agentId,
        recipeId: firstFailure.recipeId,
        commandId: firstFailure.commandId,
        atEpochMs: firstFailure.atEpochMs,
        evidence: toCompactStrings([firstFailure.key, firstFailure.code])
    };
}

function toCommandResultItem(firstFailure: FirstFailure): RunCausalTrailItem {
    return {
        kind: 'command-result',
        label: firstFailure.commandId
            ? `Command ${firstFailure.commandId}`
            : 'Distributed result',
        detail: firstFailure.message,
        tone: 'bad',
        targetKind: firstFailure.commandId ? 'command' : undefined,
        targetId: firstFailure.commandId,
        actionLabel: firstFailure.commandId
            ? `Open command ${firstFailure.commandId}`
            : 'Open distributed result',
        agentId: firstFailure.agentId,
        recipeId: firstFailure.recipeId,
        commandId: firstFailure.commandId,
        atEpochMs: firstFailure.atEpochMs,
        evidence: toCompactStrings([
            firstFailure.commandId,
            firstFailure.agentId,
            firstFailure.recipeId
        ])
    };
}

function toDiagnosticItem(
    input: Readonly<{
        firstFailure: FirstFailure;
        correlatedDiagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
        diagnosticEvidence: readonly string[];
    }>
): RunCausalTrailItem {
    const { correlatedDiagnostics, diagnosticEvidence } = input;
    return {
        kind: 'diagnostic',
        label: correlatedDiagnostics.length > 0
            ? `${correlatedDiagnostics.length} correlated diagnostic${correlatedDiagnostics.length === 1 ? '' : 's'}`
            : 'No correlated diagnostics',
        detail: correlatedDiagnostics[0]?.summary ??
            'No runtime diagnostic was directly correlated to the first failure in the loaded snapshot.',
        tone: correlatedDiagnostics.length > 0 ? 'warn' : 'muted',
        targetKind: 'diagnostic',
        targetId: diagnosticEvidence[0],
        actionLabel: correlatedDiagnostics.length > 0
            ? `Filter diagnostics (${correlatedDiagnostics.length})`
            : 'Filter diagnostics for first failure',
        agentId: correlatedDiagnostics[0]?.agentId ?? input.firstFailure.agentId,
        commandId: correlatedDiagnostics[0]?.commandId ?? input.firstFailure.commandId,
        atEpochMs: correlatedDiagnostics[0]?.atEpochMs,
        evidence: diagnosticEvidence
    };
}

function toArtifactItem(report: DistributedRunAnalysisReport): RunCausalTrailItem {
    return {
        kind: 'artifact',
        label: `Artifact ${report.rawEvidence.artifactStatus}`,
        detail: report.rawEvidence.artifactMessage,
        tone: report.rawEvidence.artifactStatus === 'valid' ? 'good' : 'warn',
        targetKind: 'artifact',
        targetId: report.rawEvidence.artifactStatus,
        actionLabel: 'Inspect artifact evidence',
        evidence: [report.rawEvidence.artifactStatus]
    };
}

function toLinkedEventsItem(
    firstFailure: FirstFailure,
    eventEvidence: readonly string[]
): RunCausalTrailItem {
    return {
        kind: 'events',
        label: `${eventEvidence.length} linked event${eventEvidence.length === 1 ? '' : 's'}`,
        detail: eventEvidence.length > 0
            ? 'Runtime events were emitted near the failed command or agent.'
            : 'No runtime events were linked to the first failed command or agent.',
        tone: eventEvidence.length > 0 ? 'active' : 'muted',
        targetKind: eventEvidence.length > 0 ? 'event' : undefined,
        targetId: eventEvidence[0],
        actionLabel: eventEvidence.length > 0
            ? `Filter ${eventEvidence.length} linked event${eventEvidence.length === 1 ? '' : 's'}`
            : 'Review event filters',
        agentId: firstFailure.agentId,
        commandId: firstFailure.commandId,
        evidence: eventEvidence
    };
}
