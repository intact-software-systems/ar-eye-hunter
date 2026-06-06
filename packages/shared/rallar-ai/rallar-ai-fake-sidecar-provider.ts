import type {
    RallarAiJsonProvider,
    RallarAiJsonRequest,
    RallarAiJsonResult,
} from './rallar-ai-types.ts';
import { RallarAiError } from './rallar-ai-types.ts';
import { createRallarAiJsonResult } from './rallar-ai-envelope.ts';
import { parseRallarAiJson } from './rallar-ai-validation.ts';

export type RallarAiSidecarFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export type CreateRallarAiFakeSidecarProviderOptions = Readonly<{
    providerId?: string;
    modelId?: string;
    baseUrl: string;
    fetch?: RallarAiSidecarFetch;
}>;

export function createRallarAiFakeSidecarProvider(
    options: CreateRallarAiFakeSidecarProviderOptions,
): RallarAiJsonProvider {
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) {
        throw new RallarAiError(
            'invalid-configuration',
            'A fetch implementation is required for the fake sidecar provider.',
        );
    }

    return {
        providerId: options.providerId ?? 'fake-sidecar-http',
        source: 'server',
        modelId: options.modelId ?? 'fake-sidecar-json',
        capabilities: {
            supportsJsonSchema: true,
            supportsStreaming: false,
            supportsCancellation: true,
            target: 'server',
        },
        async generateJson<TValue = unknown, TContext = unknown>(
            request: RallarAiJsonRequest<TContext>,
        ): Promise<RallarAiJsonResult<TValue>> {
            const startedAtEpochMs = Date.now();
            const response = await fetchImpl(new URL('/generate-json', options.baseUrl), {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    schema: request.schema,
                    schemaId: request.schemaId,
                    schemaVersion: request.schemaVersion,
                    prompt: request.prompt,
                    context: request.context,
                }),
                signal: request.signal,
            });

            if (!response.ok) {
                throw new RallarAiError(
                    'provider-failed',
                    `Fake sidecar failed with HTTP ${response.status}.`,
                );
            }

            const rawText = await response.text();
            const parsed = parseRallarAiJson(rawText);
            if (!parsed.ok) {
                throw new RallarAiError(
                    'invalid-json',
                    'Fake sidecar returned invalid JSON.',
                    parsed.validation,
                );
            }

            return createRallarAiJsonResult<TValue>({
                request,
                provider: this,
                value: parsed.value as TValue,
                rawText,
                startedAtEpochMs,
                completedAtEpochMs: Date.now(),
            });
        },
    };
}
