import type {
    DistributedRunAnalysis,
    DistributedRunFailedAnalysis
} from '../distributed-artifact-analysis.ts';
import type { DistributedArtifactEvidenceEntry } from '../distributed-artifact-evidence-contracts.ts';
import type {
    DistributedRunEventRow,
    DistributedRunFailureRow,
    DistributedRunRuntimeDiagnosticRow
} from '../distributed-run-observation/distributed-run-row-contracts.ts';
import { toBoundedEvidenceEntry } from './distributed-artifact-evidence-bounds.ts';
import { toEventEvidenceKey, toStableEvidenceId } from './distributed-artifact-evidence-identity.ts';
import { resolveDistributedArtifactEvidenceSourceFile } from './resolve-distributed-artifact-evidence-source-file.ts';
import {
    toControlRunEventRows,
    toControlRunResultRows,
    toEvidenceCommandLinks,
    type ControlRunEvidenceRowsInput
} from './to-control-run-evidence-rows.ts';

export interface DistributedArtifactEvidenceRowsInput extends Omit<ControlRunEvidenceRowsInput, 'commandLinks'> {
    readonly analysis: DistributedRunAnalysis;
    readonly summaryLimit: number;
    readonly payloadSummaryLimit: number;
}

/**
 * Every evidence row of an artifact, with its texts bounded, in source order: the analysis failure, the monitor's
 * failures, control run results, the monitor's events and diagnostics, then control run events the monitor does not
 * show. Rows are not deduplicated; the same evidence can appear from more than one source.
 */
export function toDistributedArtifactEvidenceRows(
    input: DistributedArtifactEvidenceRowsInput
): DistributedArtifactEvidenceEntry[] {
    const controlRunInput: ControlRunEvidenceRowsInput = {
        ...input,
        commandLinks: toEvidenceCommandLinks(input.snapshots.distributedRun)
    };
    return [
        ...toAnalysisFailureRows(input.analysis),
        ...toMonitorFailureRows(input),
        ...toControlRunResultRows(controlRunInput),
        ...toMonitorEventRows(controlRunInput),
        ...toControlRunEventRows(controlRunInput)
    ].map((entry) => toBoundedEvidenceEntry(entry, input.summaryLimit, input.payloadSummaryLimit));
}

function toAnalysisFailureRows(analysis: DistributedRunAnalysis): DistributedArtifactEvidenceEntry[] {
    return analysis.ok ? [] : [toAnalysisFailureRow(analysis)];
}

function toAnalysisFailureRow(analysis: DistributedRunFailedAnalysis): DistributedArtifactEvidenceEntry {
    const { failure } = analysis;
    return {
        id: toStableEvidenceId(['failure', 'analysis', failure.category, failure.commandId, failure.evidenceFile]),
        kind: 'failure',
        sourceFile: failure.evidenceFile,
        atEpochMs: analysis.spa?.report.firstFailure?.atEpochMs,
        agentId: failure.affectedAgents[0],
        agentIds: failure.affectedAgents,
        recipeId: failure.recipeId,
        commandId: failure.commandId,
        status: 'failed',
        category: failure.category,
        summary: `${failure.title} ${failure.likelyCause}`,
        payloadSummary: [
            failure.nextAction,
            failure.affectedAgents.length > 0 ? `Affected agents: ${failure.affectedAgents.join(', ')}` : undefined,
            failure.affectedRegions.length > 0 ? `Affected regions: ${failure.affectedRegions.join(', ')}` : undefined,
            `Verification: ${failure.verificationCommand}`
        ].filter(Boolean).join(' · ')
    };
}

function toMonitorFailureRows(input: DistributedArtifactEvidenceRowsInput): DistributedArtifactEvidenceEntry[] {
    return input.monitor.failures.map((failure) => toMonitorFailureRow(failure, input.analysis));
}

function toMonitorFailureRow(
    failure: DistributedRunFailureRow,
    analysis: DistributedRunAnalysis
): DistributedArtifactEvidenceEntry {
    const explanation = analysis.spa?.report.nextActions.find((candidate) => candidate.evidence.includes(failure.key));
    return {
        id: toStableEvidenceId([
            'failure',
            'monitor',
            failure.key,
            failure.agentId,
            failure.recipeId,
            failure.commandId,
            failure.atEpochMs
        ]),
        kind: 'failure',
        sourceFile: 'distributed-run.json',
        atEpochMs: failure.atEpochMs,
        agentId: failure.agentId,
        agentIds: failure.agentId ? [failure.agentId] : [],
        recipeId: failure.recipeId,
        commandId: failure.commandId,
        status: 'failed',
        category: explanation?.category ?? failure.kind,
        summary: failure.message,
        payloadSummary: [failure.code, explanation?.likelyCause, explanation?.nextAction].filter(Boolean).join(' · ')
    };
}

/** A monitor event that is also a runtime diagnostic appears once, as the diagnostic. */
function toMonitorEventRows(input: ControlRunEvidenceRowsInput): DistributedArtifactEvidenceEntry[] {
    const diagnosticKeys = new Set(input.monitor.runtimeDiagnostics.map(toEventEvidenceKey));
    const sourceFile = resolveDistributedArtifactEvidenceSourceFile(input, 'events', 'events.jsonl');
    const { recipeByCommandId } = input.commandLinks;
    return [
        ...input.monitor.events
            .filter((event) => !diagnosticKeys.has(toEventEvidenceKey(event)))
            .map((event) => toMonitorEventRow(event, sourceFile, recipeByCommandId)),
        ...input.monitor.runtimeDiagnostics
            .map((diagnostic) => toMonitorDiagnosticRow(diagnostic, sourceFile, recipeByCommandId))
    ];
}

function toMonitorEventRow(
    event: DistributedRunEventRow,
    sourceFile: string,
    recipeByCommandId: ReadonlyMap<string, string | undefined>
): DistributedArtifactEvidenceEntry {
    return {
        id: toStableEvidenceId(['event', event.eventId, event.agentId, event.commandId, event.atEpochMs]),
        kind: 'event',
        sourceFile,
        atEpochMs: event.atEpochMs,
        agentId: event.agentId,
        agentIds: [event.agentId],
        recipeId: event.commandId ? recipeByCommandId.get(event.commandId) : undefined,
        commandId: event.commandId,
        topic: event.topic,
        status: event.kind,
        category: 'event',
        summary: event.summary,
        payloadSummary: event.payloadSummary
    };
}

function toMonitorDiagnosticRow(
    diagnostic: DistributedRunRuntimeDiagnosticRow,
    sourceFile: string,
    recipeByCommandId: ReadonlyMap<string, string | undefined>
): DistributedArtifactEvidenceEntry {
    return {
        id: toStableEvidenceId([
            'diagnostic',
            diagnostic.eventId,
            diagnostic.agentId,
            diagnostic.commandId,
            diagnostic.atEpochMs
        ]),
        kind: 'diagnostic',
        sourceFile,
        atEpochMs: diagnostic.atEpochMs,
        agentId: diagnostic.agentId,
        agentIds: [diagnostic.agentId],
        recipeId: diagnostic.commandId ? recipeByCommandId.get(diagnostic.commandId) : undefined,
        commandId: diagnostic.commandId,
        topic: diagnostic.topic,
        diagnosticType: diagnostic.diagnosticTypeId,
        severity: diagnostic.severity,
        transport: diagnostic.transport,
        status: 'diagnostic',
        category: 'diagnostic',
        summary: diagnostic.summary,
        payloadSummary: diagnostic.payloadSummary
    };
}
