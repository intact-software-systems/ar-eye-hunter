import type {
    DistributedRunArtifactFiles,
    DistributedRunArtifactSnapshots,
} from './distributed-artifact-analysis.ts';
import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceKind,
} from './distributed-artifact-evidence-contracts.ts';
import {
    boundedEvidenceEntry,
    deduplicateArtifactEvidenceEntries,
    diagnosticArtifactEventKey,
    evidenceRecord,
    evidenceStringField,
    payloadReferencesDistributedRun,
    stableEvidenceId,
    summarizeEvidenceValue,
    transportFromCommandKind,
} from './distributed-artifact-evidence-utils.ts';
import type {
    DistributedRunAnalysis,
} from './distributed-artifact-analysis.ts';
import type { DistributedRunMonitor } from './distributed-run-monitor.ts';
import { distributedArtifactEvidenceSourceFile } from './distributed-artifact-evidence-provenance.ts';

export function distributedArtifactEvidenceRows(input: Readonly<{
    analysis: DistributedRunAnalysis;
    snapshots: DistributedRunArtifactSnapshots;
    monitor: DistributedRunMonitor;
    sourceFileNames: ReadonlySet<string>;
    sourceFiles?: DistributedRunArtifactFiles;
    parsedControlRun?: Readonly<Record<string, unknown>>;
    summaryLimit: number;
    payloadSummaryLimit: number;
    deduplicate?: boolean;
}>): DistributedArtifactEvidenceEntry[] {
    const rows: DistributedArtifactEvidenceEntry[] = [];
    const recipeByCommandId = new Map(
        input.snapshots.distributedRun.commandLinks.map(link => [
            link.commandId,
            link.recipeId,
        ]),
    );
    addAnalysisFailure(rows, input);
    addMonitorFailures(rows, input);
    const linkedCommandIds = new Set(
        input.snapshots.distributedRun.commandLinks.map(link => link.commandId),
    );
    addResults(rows, input, recipeByCommandId, linkedCommandIds);
    addMonitorEvents(rows, input, recipeByCommandId);
    addRawFallbackEvents(rows, input, recipeByCommandId, linkedCommandIds);
    return input.deduplicate === false
        ? rows
        : deduplicateArtifactEvidenceEntries(rows);
}

function addAnalysisFailure(
    rows: DistributedArtifactEvidenceEntry[],
    input: Parameters<typeof distributedArtifactEvidenceRows>[0],
): void {
    const failure = input.analysis.failure;
    if (!failure) return;
    rows.push(bound(input, {
        id: stableEvidenceId(
            'failure', 'analysis', failure.category,
            failure.commandId, failure.evidenceFile,
        ),
        kind: 'failure',
        sourceFile: failure.evidenceFile,
        atEpochMs: input.analysis.spa?.report.firstFailure?.atEpochMs,
        agentId: failure.affectedAgents[0],
        agentIds: failure.affectedAgents,
        recipeId: failure.recipeId,
        commandId: failure.commandId,
        status: 'failed',
        category: failure.category,
        summary: `${failure.title} ${failure.likelyCause}`,
        payloadSummary: [
            failure.nextAction,
            failure.affectedAgents.length > 0
                ? `Affected agents: ${failure.affectedAgents.join(', ')}`
                : undefined,
            failure.affectedRegions.length > 0
                ? `Affected regions: ${failure.affectedRegions.join(', ')}`
                : undefined,
            `Verification: ${failure.verificationCommand}`,
        ].filter(Boolean).join(' · '),
    }));
}

function addMonitorFailures(
    rows: DistributedArtifactEvidenceEntry[],
    input: Parameters<typeof distributedArtifactEvidenceRows>[0],
): void {
    for (const failure of input.monitor.failures) {
        const explanation = input.analysis.spa?.report.nextActions.find(
            candidate => candidate.evidence.includes(failure.key),
        );
        rows.push(bound(input, {
            id: stableEvidenceId(
                'failure', 'monitor', failure.key, failure.agentId,
                failure.recipeId, failure.commandId, failure.atEpochMs,
            ),
            kind: 'failure', sourceFile: 'distributed-run.json',
            atEpochMs: failure.atEpochMs,
            agentId: failure.agentId,
            agentIds: failure.agentId ? [failure.agentId] : [],
            recipeId: failure.recipeId,
            commandId: failure.commandId,
            status: 'failed',
            category: explanation?.category ?? failure.kind,
            summary: failure.message,
            payloadSummary: [
                failure.code,
                explanation?.likelyCause,
                explanation?.nextAction,
            ].filter(Boolean).join(' · '),
        }));
    }
}

function addResults(
    rows: DistributedArtifactEvidenceEntry[],
    input: Parameters<typeof distributedArtifactEvidenceRows>[0],
    recipeByCommandId: ReadonlyMap<string, string | undefined>,
    linkedCommandIds: ReadonlySet<string>,
): void {
    const sourceFile = distributedArtifactEvidenceSourceFile(
        input,
        'results',
        'results.jsonl',
    );
    for (const result of input.snapshots.controlRun.results) {
        if (linkedCommandIds.size > 0 && !linkedCommandIds.has(result.commandId)) {
            continue;
        }
        const status = result.result?.status ?? (result.ok ? 'ok' : 'failed');
        const kind = result.result?.kind;
        rows.push(bound(input, {
            id: stableEvidenceId(
                'result', result.agentId, result.commandId,
                result.result?.endedAtEpochMs,
            ),
            kind: 'result', sourceFile,
            atEpochMs: result.result?.endedAtEpochMs,
            agentId: result.agentId,
            agentIds: [result.agentId],
            recipeId: recipeByCommandId.get(result.commandId),
            commandId: result.commandId,
            transport: evidenceStringField(
                evidenceRecord(result.result?.value),
                'transport',
            ) ?? transportFromCommandKind(kind),
            status,
            category: 'command',
            summary: result.error?.message ?? result.result?.error?.message ??
                `${kind ?? 'command'} ${status}`,
            payloadSummary: summarizeEvidenceValue(
                result.error?.details ?? result.result?.error?.details ??
                    result.result?.value,
            ),
        }));
    }
}

function addMonitorEvents(
    rows: DistributedArtifactEvidenceEntry[],
    input: Parameters<typeof distributedArtifactEvidenceRows>[0],
    recipeByCommandId: ReadonlyMap<string, string | undefined>,
): void {
    const diagnosticKeys = new Set(
        input.monitor.runtimeDiagnostics.map(diagnosticArtifactEventKey),
    );
    const sourceFile = distributedArtifactEvidenceSourceFile(
        input,
        'events',
        'events.jsonl',
    );
    for (const event of input.monitor.events) {
        if (diagnosticKeys.has(diagnosticArtifactEventKey(event))) continue;
        rows.push(bound(input, {
            id: stableEvidenceId(
                'event', event.eventId, event.agentId,
                event.commandId, event.atEpochMs,
            ),
            kind: 'event', sourceFile,
            atEpochMs: event.atEpochMs,
            agentId: event.agentId,
            agentIds: [event.agentId],
            recipeId: event.commandId
                ? recipeByCommandId.get(event.commandId)
                : undefined,
            commandId: event.commandId,
            topic: event.topic,
            status: event.kind,
            category: 'event',
            summary: event.summary,
            payloadSummary: event.payloadSummary,
        }));
    }
    for (const diagnostic of input.monitor.runtimeDiagnostics) {
        rows.push(bound(input, {
            id: stableEvidenceId(
                'diagnostic', diagnostic.eventId, diagnostic.agentId,
                diagnostic.commandId, diagnostic.atEpochMs,
            ),
            kind: 'diagnostic', sourceFile,
            atEpochMs: diagnostic.atEpochMs,
            agentId: diagnostic.agentId,
            agentIds: [diagnostic.agentId],
            recipeId: diagnostic.commandId
                ? recipeByCommandId.get(diagnostic.commandId)
                : undefined,
            commandId: diagnostic.commandId,
            topic: diagnostic.topic,
            diagnosticType: diagnostic.diagnosticTypeId,
            severity: diagnostic.severity,
            transport: diagnostic.transport,
            status: 'diagnostic',
            category: 'diagnostic',
            summary: diagnostic.summary,
            payloadSummary: diagnostic.payloadSummary,
        }));
    }
}

function addRawFallbackEvents(
    rows: DistributedArtifactEvidenceEntry[],
    input: Parameters<typeof distributedArtifactEvidenceRows>[0],
    recipeByCommandId: ReadonlyMap<string, string | undefined>,
    linkedCommandIds: ReadonlySet<string>,
): void {
    const represented = new Set([
        ...input.monitor.events.map(diagnosticArtifactEventKey),
        ...input.monitor.runtimeDiagnostics.map(diagnosticArtifactEventKey),
    ]);
    const sourceFile = distributedArtifactEvidenceSourceFile(
        input,
        'events',
        'events.jsonl',
    );
    for (const event of input.snapshots.controlRun.events) {
        const eventId = event.eventId ?? `${event.kind}-${event.atEpochMs}`;
        if (represented.has(diagnosticArtifactEventKey({
            eventId, agentId: event.agentId, commandId: event.commandId,
        }))) continue;
        if (
            linkedCommandIds.size > 0 &&
            !(event.commandId && linkedCommandIds.has(event.commandId)) &&
            !payloadReferencesDistributedRun(
                event.payload,
                input.snapshots.distributedRun.distributedRunId,
            )
        ) continue;
        const payload = evidenceRecord(event.payload);
        const nested = evidenceRecord(payload.payload);
        const evidence = Object.keys(nested).length > 0 ? nested : payload;
        const diagnosticType = evidenceStringField(evidence, 'diagnosticTypeId') ??
            evidenceStringField(evidence, 'diagnosticType') ??
            evidenceStringField(evidence, 'typeId');
        const topic = evidenceStringField(evidence, 'topic') ??
            evidenceStringField(payload, 'topic');
        const kind: DistributedArtifactEvidenceKind =
            event.kind === 'diagnostic' || diagnosticType ? 'diagnostic' : 'event';
        rows.push(bound(input, {
            id: stableEvidenceId(
                kind, eventId, event.agentId, event.commandId, event.atEpochMs,
            ),
            kind, sourceFile, atEpochMs: event.atEpochMs,
            agentId: event.agentId, agentIds: [event.agentId],
            recipeId: event.commandId
                ? recipeByCommandId.get(event.commandId)
                : undefined,
            commandId: event.commandId,
            topic,
            diagnosticType,
            severity: evidenceStringField(evidence, 'severity') ??
                evidenceStringField(payload, 'severity'),
            transport: evidenceStringField(evidence, 'transport') ??
                evidenceStringField(payload, 'transport'),
            status: kind === 'diagnostic' ? 'diagnostic' : event.kind,
            category: kind,
            summary: evidenceStringField(evidence, 'message') ??
                evidenceStringField(payload, 'message') ??
                `${event.kind}${topic ? ` · ${topic}` : ''}`,
            payloadSummary: summarizeEvidenceValue(event.payload),
        }));
    }
}

function bound(
    input: Parameters<typeof distributedArtifactEvidenceRows>[0],
    entry: DistributedArtifactEvidenceEntry,
): DistributedArtifactEvidenceEntry {
    return boundedEvidenceEntry(
        entry,
        input.summaryLimit,
        input.payloadSummaryLimit,
    );
}
