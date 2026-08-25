import {
    RALLAR_AI_PROTOCOL_VERSION,
    type RallarAiJsonResult,
    type RallarAiJsonValue,
    type RallarAiResultLifecycleState,
    type RallarAiValidationIssue,
    type RallarAiValidationResult
} from '@shared/rallar-ai/mod.ts';
import type { AppDataValueCodec } from '../app-data/app-data-value-codec.ts';
import type { JsonWireObject, JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';

export const RALLAR_SERVER_AI_RESULT_APP_DATA_CODEC: AppDataValueCodec<RallarAiJsonResult<RallarAiJsonValue>> = {
    schemaVersion: 1,
    encode: (value) => toJsonWireValue(value),
    decode: decodeRallarAiResult
};

function decodeRallarAiResult(
    value: JsonWireValue
): RallarAiJsonResult<RallarAiJsonValue> {
    const result = requireObject(value, 'RallarAI result');
    if (
        result.protocolVersion !== RALLAR_AI_PROTOCOL_VERSION ||
        typeof result.generationId !== 'string' ||
        !isOptionalString(result.requestId) ||
        !isOptionalString(result.dedupeKey) ||
        !isOptionalString(result.supersedesGenerationId) ||
        !isRallarAiSource(result.source) ||
        typeof result.providerId !== 'string' ||
        !isOptionalString(result.modelId) ||
        typeof result.schemaId !== 'string' ||
        typeof result.schemaVersion !== 'string' ||
        typeof result.schemaHash !== 'string' ||
        typeof result.promptHash !== 'string' ||
        !isOptionalString(result.baseStateRevision) ||
        !isFiniteNumber(result.createdAtEpochMs) ||
        !('value' in result) ||
        !isOptionalString(result.rawText) ||
        !isRallarAiLifecycle(result.lifecycle)
    ) {
        throw new TypeError('RallarAI result metadata is malformed.');
    }

    return {
        protocolVersion: RALLAR_AI_PROTOCOL_VERSION,
        ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
        generationId: result.generationId,
        ...(result.dedupeKey === undefined ? {} : { dedupeKey: result.dedupeKey }),
        ...(result.supersedesGenerationId === undefined
            ? {}
            : { supersedesGenerationId: result.supersedesGenerationId }),
        source: result.source,
        providerId: result.providerId,
        ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
        schemaId: result.schemaId,
        schemaVersion: result.schemaVersion,
        schemaHash: result.schemaHash,
        promptHash: result.promptHash,
        ...(result.baseStateRevision === undefined
            ? {}
            : { baseStateRevision: result.baseStateRevision }),
        createdAtEpochMs: result.createdAtEpochMs,
        value: result.value,
        ...(result.rawText === undefined ? {} : { rawText: result.rawText }),
        validation: decodeValidation(result.validation),
        ...(result.timing === undefined ? {} : { timing: decodeTiming(result.timing) }),
        ...(result.lifecycle === undefined ? {} : { lifecycle: result.lifecycle })
    };
}

function decodeValidation(value: JsonWireValue | undefined): RallarAiValidationResult {
    const validation = requireObject(value, 'RallarAI validation');
    if (
        typeof validation.ok !== 'boolean' ||
        !isStringArray(validation.errors) ||
        !Array.isArray(validation.issues)
    ) {
        throw new TypeError('RallarAI validation result is malformed.');
    }
    return {
        ok: validation.ok,
        errors: validation.errors,
        issues: validation.issues.map(decodeValidationIssue)
    };
}

function decodeValidationIssue(value: JsonWireValue): RallarAiValidationIssue {
    const issue = requireObject(value, 'RallarAI validation issue');
    if (
        typeof issue.path !== 'string' ||
        typeof issue.code !== 'string' ||
        typeof issue.message !== 'string'
    ) {
        throw new TypeError('RallarAI validation issue is malformed.');
    }
    return {
        path: issue.path,
        code: issue.code,
        message: issue.message
    };
}

function decodeTiming(
    value: JsonWireValue
): Readonly<{ startedAtEpochMs: number; completedAtEpochMs: number; }> {
    const timing = requireObject(value, 'RallarAI timing');
    if (
        !isFiniteNumber(timing.startedAtEpochMs) ||
        !isFiniteNumber(timing.completedAtEpochMs)
    ) {
        throw new TypeError('RallarAI timing is malformed.');
    }
    return {
        startedAtEpochMs: timing.startedAtEpochMs,
        completedAtEpochMs: timing.completedAtEpochMs
    };
}

function toJsonWireValue(value: RallarAiJsonResult<RallarAiJsonValue>): JsonWireValue {
    return {
        protocolVersion: value.protocolVersion,
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
        generationId: value.generationId,
        ...(value.dedupeKey === undefined ? {} : { dedupeKey: value.dedupeKey }),
        ...(value.supersedesGenerationId === undefined
            ? {}
            : { supersedesGenerationId: value.supersedesGenerationId }),
        source: value.source,
        providerId: value.providerId,
        ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
        schemaId: value.schemaId,
        schemaVersion: value.schemaVersion,
        schemaHash: value.schemaHash,
        promptHash: value.promptHash,
        ...(value.baseStateRevision === undefined
            ? {}
            : { baseStateRevision: value.baseStateRevision }),
        createdAtEpochMs: value.createdAtEpochMs,
        value: value.value,
        ...(value.rawText === undefined ? {} : { rawText: value.rawText }),
        validation: {
            ok: value.validation.ok,
            errors: value.validation.errors,
            issues: value.validation.issues.map((issue) => ({
                path: issue.path,
                code: issue.code,
                message: issue.message
            }))
        },
        ...(value.timing === undefined
            ? {}
            : {
                timing: {
                    startedAtEpochMs: value.timing.startedAtEpochMs,
                    completedAtEpochMs: value.timing.completedAtEpochMs
                }
            }),
        ...(value.lifecycle === undefined ? {} : { lifecycle: value.lifecycle })
    };
}

function requireObject(value: JsonWireValue | undefined, label: string): JsonWireObject {
    if (value === undefined || !isJsonWireObject(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: JsonWireValue | undefined): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isOptionalString(value: JsonWireValue | undefined): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isFiniteNumber(value: JsonWireValue | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isRallarAiSource(value: JsonWireValue | undefined): value is 'browser' | 'server' | 'mock' {
    return value === 'browser' || value === 'server' || value === 'mock';
}

function isRallarAiLifecycle(
    value: JsonWireValue | undefined
): value is RallarAiResultLifecycleState | undefined {
    return value === undefined ||
        value === 'draft' ||
        value === 'proposed' ||
        value === 'accepted' ||
        value === 'rejected' ||
        value === 'expired' ||
        value === 'superseded';
}
