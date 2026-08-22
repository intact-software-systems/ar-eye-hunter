import { RECIPE_CONSOLE_URL_STRING_MAX_BYTES } from '../routing/url-state-contract.ts';
import { isAnalyzeControlIdentityDigest } from './analyze-control-identity-digest.ts';
import {
    ANALYZE_ARTIFACT_MAX_FILE_BYTES,
    ANALYZE_ARTIFACT_MAX_FILE_COUNT,
    ANALYZE_ARTIFACT_MAX_TOTAL_BYTES
} from './analyze-file-boundary.ts';
import type {
    AnalyzeWorkerArtifactOffer,
    AnalyzeWorkerErrorProjection,
    AnalyzeWorkerRequest
} from './analyze-worker-contract.ts';

export const ANALYZE_WORKER_MAX_LABEL_BYTES = 1_024;
export const ANALYZE_WORKER_MAX_REQUEST_TEXT_BYTES = RECIPE_CONSOLE_URL_STRING_MAX_BYTES;
const ANALYZE_WORKER_MAX_FILE_NAME_BYTES = 1_024;
const ANALYZE_WORKER_MAX_CONTROL_ENVELOPE_BYTES = 64 * 1_024 * 1_024;

export function isAnalyzeWorkerArtifactOffer(
    value: unknown
): value is AnalyzeWorkerArtifactOffer {
    if (
        !isRecord(value) || !onlyKeys(value, [
            'source',
            'label',
            'generatedAtEpochMs',
            'artifactSchemaVersion',
            'files',
            'controlEnvelope',
            'ignoredFiles',
            'expectedControlIdentity'
        ])
    ) {
        return false;
    }
    if (
        (value.source !== 'local-files' && value.source !== 'control') ||
        !boundedString(value.label, ANALYZE_WORKER_MAX_LABEL_BYTES) ||
        !optionalFiniteNumber(value.generatedAtEpochMs) ||
        !optionalSafeInteger(value.artifactSchemaVersion) ||
        !Array.isArray(value.files) ||
        value.files.length > ANALYZE_ARTIFACT_MAX_FILE_COUNT ||
        !validIgnoredFiles(value.ignoredFiles)
    ) {
        return false;
    }
    let totalBytes = 0;
    for (const file of value.files) {
        if (
            !isRecord(file) || !onlyKeys(file, ['name', 'bytes']) ||
            !boundedString(file.name, ANALYZE_WORKER_MAX_FILE_NAME_BYTES) ||
            !(file.bytes instanceof ArrayBuffer) ||
            file.bytes.byteLength > ANALYZE_ARTIFACT_MAX_FILE_BYTES
        ) {
            return false;
        }
        totalBytes += file.bytes.byteLength;
        if (totalBytes > ANALYZE_ARTIFACT_MAX_TOTAL_BYTES) {
            return false;
        }
    }
    if (value.source === 'control') {
        return value.files.length === 0 &&
            value.controlEnvelope instanceof ArrayBuffer &&
            value.controlEnvelope.byteLength <= ANALYZE_WORKER_MAX_CONTROL_ENVELOPE_BYTES &&
            isAnalyzeControlIdentityDigest(value.expectedControlIdentity);
    }
    return value.controlEnvelope === undefined &&
        value.expectedControlIdentity === undefined;
}

export function isAnalyzeWorkerRequest(value: unknown): value is AnalyzeWorkerRequest {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return false;
    }
    if (value.type === 'dispose') {
        return onlyKeys(value, ['type', 'reason']) &&
            ['clear', 'replacement', 'unmount', 'crash'].includes(String(value.reason));
    }
    if (value.type === 'offer') {
        return onlyKeys(value, ['type', 'operationGeneration', 'artifact']) &&
            generation(value.operationGeneration) &&
            isAnalyzeWorkerArtifactOffer(value.artifact);
    }
    if (value.type === 'start') {
        return onlyKeys(value, ['type', 'operationGeneration']) &&
            generation(value.operationGeneration);
    }
    if (!generation(value.modelGeneration) || !generation(value.requestId)) {
        return false;
    }
    if (value.type === 'search') {
        return onlyKeys(value, [
            'type',
            'modelGeneration',
            'queryGeneration',
            'requestId',
            'query',
            'windowSize'
        ]) && generation(value.queryGeneration) && evidenceQuery(value.query) &&
            positiveSafeInteger(value.windowSize);
    }
    if (value.type === 'window') {
        return onlyKeys(value, [
            'type',
            'modelGeneration',
            'queryGeneration',
            'windowGeneration',
            'requestId',
            'query',
            'cursor',
            'windowSize'
        ]) && generation(value.queryGeneration) &&
            generation(value.windowGeneration) && evidenceQuery(value.query) &&
            boundedString(value.cursor, ANALYZE_WORKER_MAX_REQUEST_TEXT_BYTES) &&
            positiveSafeInteger(value.windowSize);
    }
    if (value.type === 'select') {
        return onlyKeys(value, [
            'type',
            'modelGeneration',
            'selectionGeneration',
            'requestId',
            'evidenceId'
        ]) && generation(value.selectionGeneration) &&
            optionalBoundedString(value.evidenceId);
    }
    if (value.type === 'tune') {
        return onlyKeys(value, [
            'type',
            'modelGeneration',
            'tuneGeneration',
            'requestId',
            'focusRunId',
            'compareLeft',
            'compareRight',
            'timingMetric'
        ]) && generation(value.tuneGeneration) && [
            value.focusRunId,
            value.compareLeft,
            value.compareRight,
            value.timingMetric
        ].every(optionalBoundedString);
    }
    return false;
}

export function analyzeWorkerRequestStage(
    request: Exclude<AnalyzeWorkerRequest, { type: 'dispose'; }>
): AnalyzeWorkerErrorProjection['stage'] {
    if (request.type === 'offer') {
        return 'offer';
    }
    if (request.type === 'start') {
        return 'model';
    }
    if (request.type === 'select') {
        return 'selection';
    }
    return request.type;
}

export function analyzeWorkerRequestIdentity(
    request: Exclude<AnalyzeWorkerRequest, { type: 'dispose'; }>
): Readonly<{ operationGeneration?: number; requestId?: number; }> {
    return {
        ...('operationGeneration' in request
            ? { operationGeneration: request.operationGeneration }
            : {}),
        ...('requestId' in request ? { requestId: request.requestId } : {})
    };
}

export function invalidAnalyzeWorkerRequestStage(
    value: unknown
): AnalyzeWorkerErrorProjection['stage'] {
    if (!isRecord(value)) {
        return 'offer';
    }
    if (value.type === 'search') {
        return 'search';
    }
    if (value.type === 'window') {
        return 'window';
    }
    if (value.type === 'select') {
        return 'selection';
    }
    if (value.type === 'tune') {
        return 'tune';
    }
    if (value.type === 'start') {
        return 'model';
    }
    return 'offer';
}

function evidenceQuery(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    const stringFields = [
        'query',
        'agentId',
        'recipeId',
        'commandId',
        'status',
        'severity',
        'transport',
        'category'
    ] as const;
    const numberFields = ['fromEpochMs', 'toEpochMs'] as const;
    return onlyKeys(value, [...stringFields, ...numberFields]) &&
        stringFields.every((key) => optionalBoundedString(value[key])) &&
        numberFields.every((key) => optionalFiniteNumber(value[key]));
}

function validIgnoredFiles(value: unknown): boolean {
    return value === undefined || (Array.isArray(value) &&
        value.length <= ANALYZE_ARTIFACT_MAX_FILE_COUNT && value.every((file) =>
            isRecord(file) && onlyKeys(file, ['basename', 'sourcePath', 'reason']) &&
            boundedString(file.basename, ANALYZE_WORKER_MAX_FILE_NAME_BYTES) &&
            boundedString(file.sourcePath, ANALYZE_WORKER_MAX_REQUEST_TEXT_BYTES) &&
            boundedString(file.reason, ANALYZE_WORKER_MAX_REQUEST_TEXT_BYTES)
        ));
}

function boundedString(value: unknown, maxBytes: number): value is string {
    return typeof value === 'string' && value.length <= maxBytes &&
        new TextEncoder().encode(value).byteLength <= maxBytes;
}

function optionalBoundedString(value: unknown): value is string | undefined {
    return value === undefined || boundedString(value, ANALYZE_WORKER_MAX_REQUEST_TEXT_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    const keys = new Set(allowed);
    return Object.keys(value).every((key) => keys.has(key));
}

function generation(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
    return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function optionalSafeInteger(value: unknown): value is number | undefined {
    return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value));
}
