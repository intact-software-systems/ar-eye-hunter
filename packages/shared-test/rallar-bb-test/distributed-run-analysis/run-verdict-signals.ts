import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunMonitor } from '../distributed-run-monitor.ts';
import { uniqueSortedValues } from '../distributed/unique-sorted-values.ts';
import { compactStrings } from './compact-strings.ts';
import type { DistributedRunAnalysisReport } from './distributed-run-analysis-report.ts';

export function toRunVerdictWarnings(
    monitor: DistributedRunMonitor,
    report: DistributedRunAnalysisReport
): readonly string[] {
    const warnings = [
        ...report.summary.snapshotWarnings.map((warning) => `Evidence warning: snapshot ${warning}`),
        ...(monitor.artifact.status === 'valid'
            ? []
            : [`Evidence warning: artifact ${
                monitor.artifact.status === 'not-loaded' ? 'not loaded' : monitor.artifact.status
            }: ${monitor.artifact.message}`]),
        ...(monitor.resultCounts.failed > 0
            ? [`Evidence warning: ${monitor.resultCounts.failed} failed command result${
                monitor.resultCounts.failed === 1 ? '' : 's'
            } remained in evidence.`]
            : []),
        ...(report.diagnostics.warnings > 0
            ? [`Evidence warning: ${report.diagnostics.warnings} runtime warning diagnostic${
                report.diagnostics.warnings === 1 ? '' : 's'
            }.`]
            : []),
        ...(report.diagnostics.errors > 0
            ? [`Evidence warning: ${report.diagnostics.errors} runtime error diagnostic${
                report.diagnostics.errors === 1 ? '' : 's'
            }.`]
            : [])
    ];
    return uniqueSortedValues(warnings);
}

export function toRunVerdictSuccessSignals(
    monitor: DistributedRunMonitor,
    report: DistributedRunAnalysisReport
): readonly string[] {
    const okResults = monitor.resultCounts.ok;
    const completed = okResults > 0 ? okResults : monitor.commandCounts.completed;
    const signals = [
        completed > 0 ? `${completed} completed command${completed === 1 ? '' : 's'}` : undefined,
        monitor.events.length > 0
            ? `${monitor.events.length} received evidence event${monitor.events.length === 1 ? '' : 's'}`
            : undefined,
        report.summary.artifactStatus === 'valid' ? 'Artifact bundle is valid.' : undefined,
        report.summary.failedCommandCount === 0 && report.summary.failedResultCount === 0
            ? 'No failed command results in the loaded snapshot.'
            : undefined
    ];
    return compactStrings(signals);
}

export function toRunVerdictSummary(
    run: ControlDistributedRunSnapshot,
    report: DistributedRunAnalysisReport,
    monitor: DistributedRunMonitor
): string {
    if (report.firstFailure) {
        return [
            report.firstFailure.category,
            report.firstFailure.agentId ? `agent ${report.firstFailure.agentId}` : undefined,
            report.firstFailure.commandId ? `command ${report.firstFailure.commandId}` : undefined,
            report.firstFailure.message
        ].filter(Boolean).join(' - ');
    }
    if (report.summary.ok || run.state === 'passed') {
        return `${report.summary.completedCommandCount} commands completed across ${report.summary.targetCount} target${
            report.summary.targetCount === 1 ? '' : 's'
        }; ${monitor.events.length} event${monitor.events.length === 1 ? '' : 's'} linked.`;
    }
    return `Run state is ${run.state}; ${monitor.commandCounts.pending} command${
        monitor.commandCounts.pending === 1 ? '' : 's'
    } still pending.`;
}
