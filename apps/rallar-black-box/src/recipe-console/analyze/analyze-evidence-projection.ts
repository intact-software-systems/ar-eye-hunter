import type {
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceWindow,
} from '@shared-test/rallar-bb-test/mod.ts';
import type { AnalyzeEvidenceWindowProjection } from './analyze-worker-contract.ts';
import { ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE } from './analyze-worker-contract.ts';
import {
    boundedText,
    finiteNumber,
    MAX_EVIDENCE_AGENT_IDS,
    MAX_METADATA_BYTES,
    MAX_SUMMARY_BYTES,
    projectOpaqueIdentifier,
    withinSerializedLimit,
} from './analyze-projection-bounds.ts';

/**
 * Normal IDs remain compatible. Oversized IDs become deterministic opaque
 * handles that the worker resolves against its private catalog.
 */
export function projectAnalyzeEvidenceEntry(
    entry: DistributedArtifactEvidenceEntry,
): DistributedArtifactEvidenceEntry {
    return {
        id: projectOpaqueIdentifier(entry.id),
        kind: entry.kind,
        sourceFile: boundedText(entry.sourceFile, MAX_METADATA_BYTES),
        ...(entry.atEpochMs !== undefined
            ? { atEpochMs: finiteNumber(entry.atEpochMs) }
            : {}),
        ...(entry.agentId
            ? { agentId: projectOpaqueIdentifier(entry.agentId) }
            : {}),
        ...(entry.agentIds
            ? {
                  agentIds: entry.agentIds.slice(0, MAX_EVIDENCE_AGENT_IDS)
                      .map(value => projectOpaqueIdentifier(value)),
              }
            : {}),
        ...(entry.recipeId
            ? { recipeId: projectOpaqueIdentifier(entry.recipeId) }
            : {}),
        ...(entry.commandId
            ? { commandId: projectOpaqueIdentifier(entry.commandId) }
            : {}),
        ...(entry.topic
            ? { topic: boundedText(entry.topic, MAX_METADATA_BYTES) }
            : {}),
        ...(entry.diagnosticType
            ? {
                  diagnosticType: boundedText(
                      entry.diagnosticType,
                      MAX_METADATA_BYTES,
                  ),
              }
            : {}),
        ...(entry.severity
            ? { severity: boundedText(entry.severity, MAX_METADATA_BYTES) }
            : {}),
        ...(entry.transport
            ? { transport: boundedText(entry.transport, MAX_METADATA_BYTES) }
            : {}),
        ...(entry.status
            ? { status: boundedText(entry.status, MAX_METADATA_BYTES) }
            : {}),
        ...(entry.category
            ? { category: boundedText(entry.category, MAX_METADATA_BYTES) }
            : {}),
        summary: boundedText(entry.summary, MAX_SUMMARY_BYTES),
        payloadSummary: boundedText(entry.payloadSummary),
    };
}

export function projectAnalyzeEvidenceWindow(
    window: DistributedArtifactEvidenceWindow,
): AnalyzeEvidenceWindowProjection {
    const entries = window.entries
        .slice(0, ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE)
        .map(projectAnalyzeEvidenceEntry);
    const candidate = evidenceWindowProjection(window, entries);
    return withinSerializedLimit(candidate, () => evidenceWindowProjection(
        window,
        entries.map(projectMinimalEvidenceEntry),
    ));
}

/** Resolve a projected evidence handle without exposing raw catalog IDs. */
export function analyzeEvidenceEntryMatchesProjectedId(
    entry: DistributedArtifactEvidenceEntry,
    projectedId: string,
): boolean {
    return projectOpaqueIdentifier(entry.id) === projectedId;
}

function evidenceWindowProjection(
    source: DistributedArtifactEvidenceWindow,
    entries: readonly DistributedArtifactEvidenceEntry[],
): AnalyzeEvidenceWindowProjection {
    return {
        entries,
        rangeStart: entries.length === 0 ? 0 : finiteNumber(source.rangeStart),
        rangeEnd: entries.length === 0
            ? 0
            : finiteNumber(source.rangeStart) + entries.length - 1,
        // Worker-generated HMAC cursors are already bounded authority and must
        // round-trip byte-for-byte.
        ...(source.previousCursor ? { previousCursor: source.previousCursor } : {}),
        ...(source.nextCursor ? { nextCursor: source.nextCursor } : {}),
        counts: {
            totalEntries: finiteNumber(source.counts.totalEntries),
            indexedEntries: finiteNumber(source.counts.indexedEntries),
            indexOmittedEntries: finiteNumber(source.counts.indexOmittedEntries),
            retainedMatches: finiteNumber(source.counts.retainedMatches),
            queryExcludedEntries: finiteNumber(source.counts.queryExcludedEntries),
            renderedMatches: entries.length,
            renderOmittedMatches: Math.max(
                0,
                finiteNumber(source.counts.retainedMatches) - entries.length,
            ),
        },
        totalMatchesIsComplete: source.totalMatchesIsComplete,
        windowSize: ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
    };
}

function projectMinimalEvidenceEntry(
    entry: DistributedArtifactEvidenceEntry,
): DistributedArtifactEvidenceEntry {
    return {
        id: entry.id,
        kind: entry.kind,
        sourceFile: boundedText(entry.sourceFile, 128),
        summary: boundedText(entry.summary, 256),
        payloadSummary: '',
    };
}
