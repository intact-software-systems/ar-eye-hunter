import { createRallarAiJsonResult } from './rallar-ai-envelope.ts';
import type { RallarAiJsonProvider, RallarAiJsonRequest, RallarAiJsonResult } from './rallar-ai-types.ts';

export type CreateRallarAiMockProviderOptions = Readonly<{
    providerId?: string;
    modelId?: string;
    value?: unknown | ((request: RallarAiJsonRequest) => unknown);
    createdAtEpochMs?: number;
}>;

export function createRallarAiMockProvider(
    options: CreateRallarAiMockProviderOptions = {}
): RallarAiJsonProvider {
    return {
        providerId: options.providerId ?? 'mock',
        source: 'mock',
        modelId: options.modelId ?? 'mock-json',
        capabilities: {
            supportsJsonSchema: true,
            supportsStreaming: false,
            supportsCancellation: true,
            target: 'shared'
        },
        async generateJson<TValue = unknown, TContext = unknown>(
            request: RallarAiJsonRequest<TContext>
        ): Promise<RallarAiJsonResult<TValue>> {
            if (request.signal?.aborted) {
                throw request.signal.reason instanceof Error
                    ? request.signal.reason
                    : new Error('RallarAI mock generation cancelled.');
            }
            const startedAtEpochMs = options.createdAtEpochMs ?? Date.now();
            const value = typeof options.value === 'function'
                ? options.value(request)
                : options.value ?? {};
            return createRallarAiJsonResult<TValue>({
                request,
                provider: this,
                value: value as TValue,
                rawText: JSON.stringify(value),
                startedAtEpochMs,
                completedAtEpochMs: startedAtEpochMs,
                createdAtEpochMs: startedAtEpochMs,
                generationId: request.requestId
                    ? `mock:${request.requestId}`
                    : undefined
            });
        }
    };
}
