import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot
} from '../control-snapshots.ts';
import { toDistributedRunRecipeSelectionId } from '../distributed-run-history/to-distributed-run-recipe-selection-id.ts';
import { deriveDistributedRunMonitor, type DistributedRunMonitor } from '../distributed-run-monitor.ts';
import type { DistributedRunArtifactValidationStatus } from '../distributed-run-observation/distributed-run-row-contracts.ts';
import {
    deriveDistributedRunAnalysisReport,
    type DistributedRunAnalysisReport
} from './distributed-run-analysis-report.ts';
import { toRunVerdictCausalTrail, type RunCausalTrailItem } from './run-verdict-causal-trail.ts';
import {
    toRunVerdictSuccessSignals,
    toRunVerdictSummary,
    toRunVerdictWarnings
} from './run-verdict-signals.ts';

export type RunVerdictKind =
    | 'no-run'
    | 'running'
    | 'passed'
    | 'failed'
    | 'attention';

export type RunVerdictTone = 'good' | 'active' | 'warn' | 'bad' | 'muted';

export type RunVerdictEvidenceItem = Readonly<{
    label: string;
    value: string;
    tone: RunVerdictTone;
    detail?: string;
}>;

export type RunVerdictView = Readonly<{
    verdict: RunVerdictKind;
    tone: RunVerdictTone;
    title: string;
    summary: string;
    runId?: string;
    state?: string;
    recipeLabel?: string;
    profileLabel?: string;
    targetCount?: number;
    durationMs?: number;
    artifactStatus: DistributedRunArtifactValidationStatus;
    artifactMessage: string;
    refreshedAtEpochMs?: number;
    likelyCause?: string;
    nextAction?: string;
    primaryEvidence: readonly RunVerdictEvidenceItem[];
    successSignals: readonly string[];
    warningSignals: readonly string[];
    causalTrail: readonly RunCausalTrailItem[];
}>;

export function deriveRunVerdictView(
    input: Readonly<{
        distributedRun?: ControlDistributedRunSnapshot;
        monitor?: DistributedRunMonitor;
        report?: DistributedRunAnalysisReport;
        artifactBundle?: ControlDistributedRunArtifactBundle;
        refreshedAtEpochMs?: number;
    }>
): RunVerdictView {
    if (!input.distributedRun) {
        return toNoRunVerdictView(input.refreshedAtEpochMs);
    }

    const { monitor, report } = computeVerdictEvidence({
        ...input,
        distributedRun: input.distributedRun
    });
    const selectedRecipe = input.distributedRun.manifest.recipes[0];
    const recipeLabel = selectedRecipe
        ? [toDistributedRunRecipeSelectionId(selectedRecipe), selectedRecipe.profile].filter(Boolean).join(' ')
        : undefined;
    const firstAction = report.nextActions[0];
    const warningSignals = toRunVerdictWarnings(monitor, report);
    const successSignals = toRunVerdictSuccessSignals(monitor, report);
    const verdict = toRunVerdictKind(input.distributedRun, report);
    const hasWarnings = warningSignals.length > 0;

    return {
        verdict,
        tone: toRunVerdictTone(verdict, hasWarnings),
        title: toRunVerdictTitle(verdict, hasWarnings),
        summary: toRunVerdictSummary(input.distributedRun, report, monitor),
        runId: input.distributedRun.distributedRunId,
        state: input.distributedRun.state,
        recipeLabel,
        profileLabel: selectedRecipe?.profile,
        targetCount: report.summary.targetCount,
        durationMs: report.summary.durationMs,
        artifactStatus: monitor.artifact.status,
        artifactMessage: monitor.artifact.message,
        refreshedAtEpochMs: input.refreshedAtEpochMs,
        likelyCause: firstAction
            ? report.firstFailure?.message ?? firstAction.likelyCause
            : undefined,
        nextAction: firstAction?.category === 'command'
            ? toVerdictCommandFailureNextAction(report.firstFailure)
            : firstAction?.nextAction,
        primaryEvidence: toRunVerdictEvidenceItems({
            monitor,
            report,
            warningSignalCount: warningSignals.length,
            includeLinkedEvidence: verdict === 'failed'
        }),
        successSignals,
        warningSignals,
        causalTrail: toRunVerdictCausalTrail(report, monitor)
    };
}

interface RunVerdictEvidence {
    readonly monitor: DistributedRunMonitor;
    readonly report: DistributedRunAnalysisReport;
}

/**
 * A supplied monitor is not silently adopted by a separately supplied report; the
 * report keeps deriving from its own distributed-run input in that case.
 */
function computeVerdictEvidence(
    input: Readonly<{
        distributedRun: ControlDistributedRunSnapshot;
        monitor?: DistributedRunMonitor;
        report?: DistributedRunAnalysisReport;
        artifactBundle?: ControlDistributedRunArtifactBundle;
    }>
): RunVerdictEvidence {
    const monitorWasDerivedForVerdict = input.monitor === undefined;
    const monitor = input.monitor ?? deriveDistributedRunMonitor({
        distributedRun: input.distributedRun,
        artifactBundle: input.artifactBundle
    });
    const report = input.report ?? deriveDistributedRunAnalysisReport({
        distributedRun: input.distributedRun,
        artifactBundle: input.artifactBundle,
        ...(monitorWasDerivedForVerdict ? { monitor } : {})
    });
    return { monitor, report };
}

function toNoRunVerdictView(refreshedAtEpochMs: number | undefined): RunVerdictView {
    return {
        verdict: 'no-run',
        tone: 'muted',
        title: 'No run selected',
        summary: 'Start or select a distributed run to inspect recipe evidence.',
        artifactStatus: 'not-loaded',
        artifactMessage: 'No distributed artifact bundle was loaded.',
        refreshedAtEpochMs,
        primaryEvidence: [
            { label: 'Evidence', value: 'No run loaded', tone: 'muted' }
        ],
        successSignals: [],
        warningSignals: [],
        causalTrail: []
    };
}

function toRunVerdictEvidenceItems(
    input: Readonly<{
        monitor: DistributedRunMonitor;
        report: DistributedRunAnalysisReport;
        warningSignalCount: number;
        includeLinkedEvidence: boolean;
    }>
): readonly RunVerdictEvidenceItem[] {
    const { monitor, report } = input;
    const linkedFailureCount = report.firstFailure ? 1 : report.rawEvidence.failureKeys.length;
    const linkedEvidence = `${linkedFailureCount} failure${
        linkedFailureCount === 1 ? '' : 's'
    } / ${report.rawEvidence.diagnosticIds.length} diagnostic${
        report.rawEvidence.diagnosticIds.length === 1 ? '' : 's'
    } / ${monitor.events.length} event${monitor.events.length === 1 ? '' : 's'}`;

    return [
        {
            label: 'Commands',
            value: `${monitor.resultCounts.ok}/${Math.max(monitor.commandCounts.total, monitor.resultCounts.total)} ok`,
            tone: monitor.resultCounts.failed > 0 ? 'warn' : 'good',
            detail: `${monitor.commandCounts.completed} completed, ${monitor.commandCounts.pending} pending`
        },
        {
            label: 'Evidence',
            value: `${monitor.resultCounts.total} results / ${monitor.events.length} events`,
            tone: monitor.events.length > 0 || monitor.resultCounts.total > 0 ? 'active' : 'muted',
            detail: `${monitor.runtimeDiagnostics.length} runtime diagnostics`
        },
        {
            label: 'Evidence warnings',
            value: String(input.warningSignalCount),
            tone: input.warningSignalCount > 0 ? 'warn' : 'good'
        },
        {
            label: 'Slowest',
            value: monitor.latency.maxMs !== undefined ? `${Math.round(monitor.latency.maxMs)} ms` : '-',
            tone: monitor.latency.maxMs !== undefined ? 'active' : 'muted'
        },
        {
            label: 'Artifact',
            value: monitor.artifact.status,
            tone: monitor.artifact.status === 'valid' ? 'good' : 'warn',
            detail: monitor.artifact.message
        },
        ...(input.includeLinkedEvidence
            ? [
                {
                    label: 'Linked evidence',
                    value: linkedEvidence,
                    tone: report.rawEvidence.failureKeys.length > 0 ? 'bad' : 'warn'
                } as const
            ]
            : [])
    ];
}

function toRunVerdictKind(
    run: ControlDistributedRunSnapshot,
    report: DistributedRunAnalysisReport
): RunVerdictKind {
    if (report.summary.ok || run.state === 'passed') {
        return 'passed';
    }
    if (run.state === 'failed' || run.state === 'timed-out' || report.firstFailure) {
        return 'failed';
    }
    if (
        run.state === 'running' || run.state === 'waiting-for-ack' || run.state === 'waiting-for-barrier' ||
        run.state === 'staging'
    ) {
        return 'running';
    }
    return 'attention';
}

function toRunVerdictTone(verdict: RunVerdictKind, hasWarnings: boolean): RunVerdictTone {
    if (verdict === 'failed') {
        return 'bad';
    }
    if (verdict === 'running') {
        return 'active';
    }
    if (verdict === 'passed') {
        return hasWarnings ? 'warn' : 'good';
    }
    if (verdict === 'attention') {
        return 'warn';
    }
    return 'muted';
}

function toRunVerdictTitle(verdict: RunVerdictKind, hasWarnings: boolean): string {
    if (verdict === 'passed') {
        return hasWarnings ? 'Outcome passed; evidence needs review' : 'Outcome passed';
    }
    if (verdict === 'failed') {
        return 'Outcome failed';
    }
    if (verdict === 'running') {
        return 'Outcome still running';
    }
    if (verdict === 'attention') {
        return 'Outcome needs attention';
    }
    return 'No run selected';
}

function toVerdictCommandFailureNextAction(
    failure?: DistributedRunAnalysisReport['firstFailure']
): string {
    const command = failure?.commandId ? `Open command ${failure.commandId}` : 'Open the affected command';
    const agent = failure?.agentId ? ` on agent ${failure.agentId}` : '';
    return `${command}${agent}, inspect the command payload/result, and compare sibling agents running the same recipe.`;
}
