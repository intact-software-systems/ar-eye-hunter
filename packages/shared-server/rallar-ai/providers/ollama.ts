import {
    createRallarAiJsonResult,
    parseRallarAiJson,
    RallarAiError,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult
} from '@shared/rallar-ai/mod.ts';

export type RallarAiOllamaFetch = (
    input: RequestInfo | URL,
    init?: RequestInit
) => Promise<Response>;

export type CreateRallarAiOllamaProviderOptions = Readonly<{
    model: string;
    providerId?: string;
    baseUrl?: string;
    endpointPath?: string;
    fetch?: RallarAiOllamaFetch;
    allowedBaseUrls?: readonly string[];
    systemPrompt?: string;
}>;

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_ENDPOINT_PATH = '/api/generate';
const DEFAULT_ALLOWED_OLLAMA_BASE_URLS = [
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    'http://[::1]:11434'
] as const;

export function createRallarAiOllamaProvider(
    options: CreateRallarAiOllamaProviderOptions
): RallarAiJsonProvider {
    const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
    assertAllowedBaseUrl(
        baseUrl,
        options.allowedBaseUrls ?? DEFAULT_ALLOWED_OLLAMA_BASE_URLS
    );
    const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetchImpl) {
        throw new RallarAiError(
            'invalid-configuration',
            'A fetch implementation is required for the Ollama provider.'
        );
    }

    return {
        providerId: options.providerId ?? 'ollama',
        source: 'server',
        modelId: options.model,
        capabilities: {
            supportsJsonSchema: true,
            supportsStreaming: false,
            supportsCancellation: true,
            target: 'server'
        },
        async generateJson<TValue = unknown, TContext = unknown>(
            request: RallarAiJsonRequest<TContext>
        ): Promise<RallarAiJsonResult<TValue>> {
            const startedAtEpochMs = Date.now();
            const response = await fetchImpl(
                new URL(options.endpointPath ?? DEFAULT_OLLAMA_ENDPOINT_PATH, baseUrl),
                {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: options.model,
                        prompt: toOllamaPrompt(request, options.systemPrompt),
                        stream: false,
                        format: request.schema,
                        options: {
                            temperature: request.temperature,
                            num_predict: request.maxOutputTokens
                        }
                    }),
                    signal: request.signal
                }
            );

            if (!response.ok) {
                throw new RallarAiError(
                    'provider-failed',
                    `Ollama failed with HTTP ${response.status}.`
                );
            }

            const payload = await response.json() as Record<string, unknown>;
            const rawText = typeof payload.response === 'string'
                ? payload.response
                : JSON.stringify(payload.response ?? payload);
            const parsed = parseRallarAiJson(rawText);
            if (!parsed.ok) {
                throw new RallarAiError(
                    'invalid-json',
                    'Ollama returned a response that was not valid JSON.',
                    parsed.validation
                );
            }

            return createRallarAiJsonResult<TValue>({
                request,
                provider: this,
                value: parsed.value as TValue,
                rawText,
                startedAtEpochMs,
                completedAtEpochMs: Date.now()
            });
        }
    };
}

function normalizeBaseUrl(baseUrl: string): URL {
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('unsupported protocol');
        }
        return url;
    }
    catch {
        throw new RallarAiError(
            'invalid-configuration',
            `Invalid Ollama base URL: ${baseUrl}.`
        );
    }
}

function assertAllowedBaseUrl(
    baseUrl: URL,
    allowedBaseUrls: readonly string[]
): void {
    const normalizedAllowed = allowedBaseUrls.map((allowed) => normalizeAllowedBaseUrl(allowed));
    if (!normalizedAllowed.includes(baseUrl.origin)) {
        throw new RallarAiError(
            'invalid-configuration',
            `Ollama base URL is not allowed: ${baseUrl.origin}.`
        );
    }
}

function normalizeAllowedBaseUrl(baseUrl: string): string {
    try {
        return new URL(baseUrl).origin;
    }
    catch {
        throw new RallarAiError(
            'invalid-configuration',
            `Invalid allowed Ollama base URL: ${baseUrl}.`
        );
    }
}

function toOllamaPrompt(
    request: RallarAiJsonRequest,
    systemPrompt?: string
): string {
    const parts = [
        systemPrompt,
        'Return only JSON that conforms to the provided JSON schema.',
        request.prompt,
        request.context === undefined
            ? undefined
            : `Context JSON: ${JSON.stringify(request.context)}`
    ];
    return parts.filter((part): part is string => Boolean(part)).join('\n\n');
}
