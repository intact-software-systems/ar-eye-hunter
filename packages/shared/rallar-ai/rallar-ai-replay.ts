import type {
    RallarAiJsonResult,
    RallarAiJsonSource,
    RallarAiResultLifecycleState,
} from './rallar-ai-types.ts';
import { getRallarAiResultDedupeId } from './rallar-ai-proposals.ts';

export type RallarAiReplayEnvelopeSummary = Readonly<{
    generationId: string;
    requestId?: string;
    dedupeId: string;
    providerId: string;
    modelId?: string;
    source: RallarAiJsonSource;
    schemaId: string;
    schemaVersion: string;
    schemaHash: string;
    lifecycle: RallarAiResultLifecycleState;
    validationOk: boolean;
    createdAtEpochMs: number;
    baseStateRevision?: string;
    supersedesGenerationId?: string;
}>;

export type RallarAiReplayLogSummary = Readonly<{
    total: number;
    accepted: number;
    rejected: number;
    expired: number;
    superseded: number;
    validationFailed: number;
    duplicateDedupeIds: readonly string[];
    entries: readonly RallarAiReplayEnvelopeSummary[];
}>;

export function summarizeRallarAiReplayEnvelope(
    result: RallarAiJsonResult,
): RallarAiReplayEnvelopeSummary {
    return {
        generationId: result.generationId,
        requestId: result.requestId,
        dedupeId: getRallarAiResultDedupeId(result),
        providerId: result.providerId,
        modelId: result.modelId,
        source: result.source,
        schemaId: result.schemaId,
        schemaVersion: result.schemaVersion,
        schemaHash: result.schemaHash,
        lifecycle: result.lifecycle ?? 'draft',
        validationOk: result.validation.ok,
        createdAtEpochMs: result.createdAtEpochMs,
        baseStateRevision: result.baseStateRevision,
        supersedesGenerationId: result.supersedesGenerationId,
    };
}

export function summarizeRallarAiReplayLog(
    results: readonly RallarAiJsonResult[],
): RallarAiReplayLogSummary {
    const entries = results.map(summarizeRallarAiReplayEnvelope);
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const entry of entries) {
        if (seen.has(entry.dedupeId)) {
            duplicates.add(entry.dedupeId);
        }
        seen.add(entry.dedupeId);
    }

    return {
        total: entries.length,
        accepted: entries.filter((entry) => entry.lifecycle === 'accepted').length,
        rejected: entries.filter((entry) => entry.lifecycle === 'rejected').length,
        expired: entries.filter((entry) => entry.lifecycle === 'expired').length,
        superseded: entries.filter((entry) => entry.lifecycle === 'superseded')
            .length,
        validationFailed: entries.filter((entry) => !entry.validationOk).length,
        duplicateDedupeIds: Array.from(duplicates).sort(),
        entries,
    };
}
