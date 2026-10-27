import {
    decodeRelicPlanningAiSuggestion,
    RELIC_PLANNING_AI_SCHEMA_ID,
    RELIC_PLANNING_AI_SCHEMA_VERSION,
    type RelicPlanningAiContext,
    type RelicPlanningAiSuggestion
} from '@relic-hunters/mod.ts';
import {
    okRallarAiValidation,
    RALLAR_AI_PROTOCOL_VERSION,
    validateRallarAiJsonSchemaValue,
    type RallarAiJsonResult,
    type RallarAiJsonSchema
} from '@shared/rallar-ai/mod.ts';
import { Either } from '@shared/resilience/Either.ts';

export interface RelicPlanningAiReplyExpectation {
    readonly requestId: string;
    readonly baseStateRevision: string;
    readonly context: RelicPlanningAiContext;
}

const TEXT: RallarAiJsonSchema = { type: 'string' };

/** The envelope fields the browser keeps of a server result; a result the server's own validation refused is no answer. */
const PLANNING_REPLY_SCHEMA: RallarAiJsonSchema = {
    type: 'object',
    required: [
        'protocolVersion',
        'requestId',
        'generationId',
        'source',
        'providerId',
        'schemaId',
        'schemaVersion',
        'schemaHash',
        'promptHash',
        'baseStateRevision',
        'createdAtEpochMs',
        'value',
        'validation'
    ],
    properties: {
        protocolVersion: { const: RALLAR_AI_PROTOCOL_VERSION },
        requestId: TEXT,
        generationId: TEXT,
        dedupeKey: TEXT,
        source: { type: 'string', enum: ['browser', 'server', 'mock'] },
        providerId: TEXT,
        modelId: TEXT,
        schemaId: TEXT,
        schemaVersion: TEXT,
        schemaHash: TEXT,
        promptHash: TEXT,
        baseStateRevision: TEXT,
        createdAtEpochMs: { type: 'number' },
        validation: { type: 'object', required: ['ok'], properties: { ok: { const: true } } }
    }
};

/** The server's answer to this request, for this turn and draft, carrying a suggestion legal in the asked context. */
export function decodeRelicPlanningAiReply(
    value: unknown,
    expected: RelicPlanningAiReplyExpectation
): Either<string, RallarAiJsonResult<RelicPlanningAiSuggestion>> {
    if (!validateRallarAiJsonSchemaValue(PLANNING_REPLY_SCHEMA, value).ok) {
        return Either.ofLeft('The planning reply is not a RallarAI result.');
    }
    const result = value as RallarAiJsonResult;
    if (
        result.requestId !== expected.requestId ||
        result.schemaId !== RELIC_PLANNING_AI_SCHEMA_ID ||
        result.schemaVersion !== RELIC_PLANNING_AI_SCHEMA_VERSION
    ) {
        return Either.ofLeft('The planning reply answers another request.');
    }
    if (result.baseStateRevision !== expected.baseStateRevision) {
        return Either.ofLeft('The planning reply is for a turn or draft that has moved on.');
    }
    const suggestion = decodeRelicPlanningAiSuggestion(result.value, expected.context);
    return suggestion.right === undefined
        ? Either.ofLeft(suggestion.left!)
        : Either.ofRight(toRelicPlanningAiResult(result, suggestion.right));
}

function toRelicPlanningAiResult(
    result: RallarAiJsonResult,
    suggestion: RelicPlanningAiSuggestion
): RallarAiJsonResult<RelicPlanningAiSuggestion> {
    return {
        protocolVersion: RALLAR_AI_PROTOCOL_VERSION,
        requestId: result.requestId,
        generationId: result.generationId,
        ...(result.dedupeKey === undefined ? {} : { dedupeKey: result.dedupeKey }),
        source: result.source,
        providerId: result.providerId,
        ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
        schemaId: result.schemaId,
        schemaVersion: result.schemaVersion,
        schemaHash: result.schemaHash,
        promptHash: result.promptHash,
        baseStateRevision: result.baseStateRevision,
        createdAtEpochMs: result.createdAtEpochMs,
        value: suggestion,
        validation: okRallarAiValidation()
    };
}
