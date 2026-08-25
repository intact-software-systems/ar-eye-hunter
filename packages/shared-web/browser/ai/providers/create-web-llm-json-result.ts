import {
    createRallarAiJsonResult,
    parseRallarAiJson,
    RallarAiError,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult
} from '@shared/rallar-ai/mod.ts';
import type { RallarAiWebLlmBoundaryValue } from './webllm-rallar-ai-provider.ts';

/** Converts one live WebLLM response into the validated shared result envelope. */
export function createWebLlmJsonResult<TValue, TContext>(
    request: RallarAiJsonRequest<TContext>,
    provider: Pick<RallarAiJsonProvider, 'providerId' | 'source' | 'modelId'>,
    response: RallarAiWebLlmBoundaryValue,
    startedAtEpochMs: number,
    completedAtEpochMs: number
): RallarAiJsonResult<TValue> {
    const rawText = extractWebLlmText(response).trim();
    const parsed = parseRallarAiJson(rawText);
    if (!parsed.ok) {
        throw new RallarAiError(
            'invalid-json',
            'WebLLM returned malformed JSON.',
            parsed.validation
        );
    }

    return createRallarAiJsonResult<TValue>({
        request,
        provider,
        value: parsed.value as TValue,
        rawText,
        startedAtEpochMs,
        completedAtEpochMs
    });
}

function extractWebLlmText(value: RallarAiWebLlmBoundaryValue): string {
    if (typeof value === 'string') {
        return value;
    }
    if (!isRecord(value)) {
        return JSON.stringify(value) ?? '';
    }

    if (typeof value.rawText === 'string') {
        return value.rawText;
    }
    if (typeof value.response === 'string') {
        return value.response;
    }
    if (typeof value.text === 'string') {
        return value.text;
    }
    if ('json' in value) {
        return JSON.stringify(value.json) ?? '';
    }

    const firstChoice = Array.isArray(value.choices)
        ? value.choices[0]
        : undefined;
    if (isRecord(firstChoice)) {
        if (typeof firstChoice.text === 'string') {
            return firstChoice.text;
        }
        const message = firstChoice.message;
        if (isRecord(message) && typeof message.content === 'string') {
            return message.content;
        }
    }

    return JSON.stringify(value) ?? '';
}

function isRecord(
    value: RallarAiWebLlmBoundaryValue
): value is Record<string, RallarAiWebLlmBoundaryValue> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
