import { RallarAiError, type RallarAiJsonSchema, type RallarAiJsonValue } from '@shared/rallar-ai/mod.ts';
import { type JsonWireObject, type JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';

const RALLAR_SERVER_AI_JSON_REQUEST_FIELDS = new Set([
    'requestId',
    'schemaId',
    'schemaVersion',
    'schema',
    'prompt',
    'context',
    'baseStateRevision',
    'dedupeKey',
    'maxOutputTokens',
    'temperature',
    'timeoutMs'
]);

export interface RallarServerAiJsonRequest {
    readonly requestId?: string;
    readonly schemaId: string;
    readonly schemaVersion: string;
    readonly schema: RallarAiJsonSchema;
    readonly prompt: string;
    readonly context?: RallarAiJsonValue;
    readonly baseStateRevision?: string;
    readonly dedupeKey?: string;
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

export function decodeRallarServerAiJsonRequest(
    value: JsonWireValue
): RallarServerAiJsonRequest {
    try {
        return decodeRallarServerAiJsonRequestValue(value);
    }
    catch (error) {
        if (error instanceof RallarAiError) {
            throw error;
        }
        throw new RallarAiError(
            'invalid-json',
            error instanceof Error
                ? error.message
                : 'RallarAI generation request is malformed.'
        );
    }
}

function decodeRallarServerAiJsonRequestValue(
    value: JsonWireValue
): RallarServerAiJsonRequest {
    const request = requireJsonObject(value);
    rejectUnexpectedFields(request);
    if (
        typeof request.schemaId !== 'string' || request.schemaId.length === 0 ||
        typeof request.schemaVersion !== 'string' || request.schemaVersion.length === 0 ||
        typeof request.prompt !== 'string' ||
        !isJsonObject(request.schema) ||
        !isOptionalString(request.requestId) ||
        !isOptionalString(request.baseStateRevision) ||
        !isOptionalString(request.dedupeKey) ||
        !isOptionalNumber(request.maxOutputTokens) ||
        !isOptionalNumber(request.temperature) ||
        !isOptionalNumber(request.timeoutMs)
    ) {
        throw new TypeError('RallarAI generation request is malformed.');
    }

    return {
        ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        schemaId: request.schemaId,
        schemaVersion: request.schemaVersion,
        schema: request.schema as RallarAiJsonSchema,
        prompt: request.prompt,
        ...(request.context === undefined ? {} : { context: request.context }),
        ...(request.baseStateRevision === undefined
            ? {}
            : { baseStateRevision: request.baseStateRevision }),
        ...(request.dedupeKey === undefined ? {} : { dedupeKey: request.dedupeKey }),
        ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs })
    };
}

export function isRallarServerAiJsonRequest(
    value: JsonWireValue
): boolean {
    try {
        decodeRallarServerAiJsonRequest(value);
        return true;
    }
    catch {
        return false;
    }
}

function requireJsonObject(value: JsonWireValue): JsonWireObject {
    if (!isJsonObject(value)) {
        throw new TypeError('RallarAI generation request must be an object.');
    }
    return value;
}

function rejectUnexpectedFields(request: JsonWireObject): void {
    const unexpectedField = Object.keys(request)
        .find((field) => !RALLAR_SERVER_AI_JSON_REQUEST_FIELDS.has(field));
    if (unexpectedField !== undefined) {
        throw new TypeError(`RallarAI generation request contains unexpected field ${unexpectedField}.`);
    }
}

function isJsonObject(value: JsonWireValue | undefined): value is JsonWireObject {
    return value !== undefined &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value);
}

function isOptionalString(value: JsonWireValue | undefined): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: JsonWireValue | undefined): value is number | undefined {
    return value === undefined || typeof value === 'number';
}
