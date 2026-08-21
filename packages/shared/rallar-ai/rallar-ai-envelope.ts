import { hashRallarAiPrompt, hashRallarAiSchema } from './rallar-ai-hashing.ts';
import {
    RALLAR_AI_PROTOCOL_VERSION,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult
} from './rallar-ai-types.ts';
import { validateRallarAiJsonSchemaValue } from './rallar-ai-validation.ts';

export type CreateRallarAiJsonResultInput<TValue = unknown> = Readonly<{
    request: RallarAiJsonRequest;
    provider: Pick<RallarAiJsonProvider, 'providerId' | 'source' | 'modelId'>;
    value: TValue;
    rawText?: string;
    generationId?: string;
    createdAtEpochMs?: number;
    startedAtEpochMs?: number;
    completedAtEpochMs?: number;
    supersedesGenerationId?: string;
}>;

export function createRallarAiJsonResult<TValue = unknown>(
    input: CreateRallarAiJsonResultInput<TValue>
): RallarAiJsonResult<TValue> {
    const createdAtEpochMs = input.createdAtEpochMs ?? Date.now();
    const completedAtEpochMs = input.completedAtEpochMs ?? createdAtEpochMs;
    return {
        protocolVersion: RALLAR_AI_PROTOCOL_VERSION,
        requestId: input.request.requestId,
        generationId: input.generationId ?? createRallarAiGenerationId(),
        dedupeKey: input.request.dedupeKey,
        supersedesGenerationId: input.supersedesGenerationId,
        source: input.provider.source,
        providerId: input.provider.providerId,
        modelId: input.provider.modelId,
        schemaId: input.request.schemaId,
        schemaVersion: input.request.schemaVersion,
        schemaHash: hashRallarAiSchema(input.request.schema),
        promptHash: hashRallarAiPrompt(input.request),
        baseStateRevision: input.request.baseStateRevision,
        createdAtEpochMs,
        value: input.value,
        rawText: input.rawText,
        validation: validateRallarAiJsonSchemaValue(
            input.request.schema,
            input.value
        ),
        timing: input.startedAtEpochMs === undefined
            ? undefined
            : {
                startedAtEpochMs: input.startedAtEpochMs,
                completedAtEpochMs
            },
        lifecycle: 'draft'
    };
}

export function createRallarAiGenerationId(): string {
    if (globalThis.crypto?.randomUUID) {
        return `rallar-ai:${globalThis.crypto.randomUUID()}`;
    }
    return `rallar-ai:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}
