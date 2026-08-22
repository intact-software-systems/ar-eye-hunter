import type {
    DistributedArtifactEvidenceCatalog,
    DistributedArtifactEvidenceWindow
} from '@shared-test/rallar-bb-test/mod.ts';
import {
    AnalyzeArtifactModelError,
    prepareAnalyzeArtifactModel,
    type AnalyzeArtifactModel
} from './analyze-artifact-model.ts';
import {
    ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE,
    type AnalyzeWorkerErrorProjection,
    type AnalyzeWorkerTelemetry
} from './analyze-worker-contract.ts';

export type AnalyzeWorkerActiveModel = Readonly<{
    generation: number;
    model: AnalyzeArtifactModel;
    catalog: DistributedArtifactEvidenceCatalog;
    sourceFileCount: number;
    sourceBytes: number;
    parseDurationMs: number;
    pipelineTelemetry: ReturnType<typeof prepareAnalyzeArtifactModel>['pipelineTelemetry'];
}>;

export class AnalyzeControlEnvelopeIdentityError extends Error {}

export function analyzeWorkerTelemetry(
    active: AnalyzeWorkerActiveModel,
    window: DistributedArtifactEvidenceWindow | undefined,
    durationMs: number
): AnalyzeWorkerTelemetry {
    return {
        durationMs,
        parseDurationMs: active.parseDurationMs,
        sourceFileCount: active.sourceFileCount,
        sourceBytes: active.sourceBytes,
        pipelinePassCount: active.pipelineTelemetry.pipelinePassCount,
        sourceCollectionPassCount: active.pipelineTelemetry.sourceCollectionPassCount,
        sourceFileVisitCount: active.pipelineTelemetry.sourceFileVisitCount,
        documentParseCount: active.pipelineTelemetry.jsonDocumentParseCount,
        jsonlFilePassCount: active.pipelineTelemetry.jsonlFilePassCount,
        jsonlRowParseCount: active.pipelineTelemetry.jsonlRowParseCount,
        totalEntryCount: active.catalog.totalEntries,
        retainedEntryCount: active.catalog.retainedEntryCount,
        indexOmittedEntryCount: active.catalog.indexOmittedEntryCount,
        matchedEntryCount: window?.counts.retainedMatches ?? 0,
        projectedEntryCount: Math.min(
            window?.entries.length ?? 0,
            ANALYZE_WORKER_EVIDENCE_WINDOW_SIZE
        )
    };
}

export function analyzeWorkerDuration(endedAt: number, startedAt: number): number {
    const value = endedAt - startedAt;
    return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function analyzeWorkerModelError(
    error: unknown
): AnalyzeWorkerErrorProjection {
    if (error instanceof AnalyzeControlEnvelopeIdentityError) {
        return { code: 'identity-mismatch', stage: 'model', recoverable: true };
    }
    if (error instanceof AnalyzeArtifactModelError) {
        return {
            code: error.code === 'generic-artifact-unsupported'
                ? 'unsupported-artifact'
                : error.code === 'unusable-distributed-artifact'
                ? 'unusable-artifact'
                : 'invalid-artifact',
            stage: 'model',
            recoverable: true
        };
    }
    return { code: 'invalid-artifact', stage: 'parse', recoverable: true };
}
