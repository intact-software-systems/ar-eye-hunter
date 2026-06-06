import {
    createRallarAiJsonResult,
    parseRallarAiJson,
    RallarAiError,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult,
} from '@shared/rallar-ai/mod.ts';

export type RallarAiWebLlmMessage = Readonly<{
    role: 'system' | 'user' | 'assistant';
    content: string;
}>;

export type RallarAiWebLlmGenerateInput<TContext = unknown> = Readonly<{
    modelId: string;
    request: RallarAiJsonRequest<TContext>;
    messages: readonly RallarAiWebLlmMessage[];
    schema: unknown;
    signal?: AbortSignal;
}>;

export type RallarAiWebLlmRuntime = Readonly<{
    generateJson?: <TContext = unknown>(
        input: RallarAiWebLlmGenerateInput<TContext>,
    ) => Promise<unknown>;
    chat?: Readonly<{
        completions?: Readonly<{
            create(input: unknown): Promise<unknown>;
        }>;
    }>;
}>;

export type CreateWebLlmRallarAiProviderOptions = Readonly<{
    modelId: string;
    providerId?: string;
    runtime?: RallarAiWebLlmRuntime;
    loadRuntime?: () => Promise<RallarAiWebLlmRuntime>;
    systemPrompt?: string;
    supportsJsonSchema?: boolean;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    typicalColdStartMs?: number;
}>;

export function createWebLlmRallarAiProvider(
    options: CreateWebLlmRallarAiProviderOptions,
): RallarAiJsonProvider {
    return {
        providerId: options.providerId ?? 'webllm',
        source: 'browser',
        modelId: options.modelId,
        capabilities: {
            supportsJsonSchema: options.supportsJsonSchema ?? true,
            supportsStreaming: false,
            supportsCancellation: true,
            maxContextTokens: options.maxContextTokens,
            maxOutputTokens: options.maxOutputTokens,
            typicalColdStartMs: options.typicalColdStartMs,
            target: 'browser',
        },
        async generateJson<TValue = unknown, TContext = unknown>(
            request: RallarAiJsonRequest<TContext>,
        ): Promise<RallarAiJsonResult<TValue>> {
            const runtime = options.runtime ?? await options.loadRuntime?.();
            if (!runtime) {
                throw new RallarAiError(
                    'invalid-configuration',
                    'A WebLLM runtime or lazy runtime loader is required.',
                );
            }

            const startedAtEpochMs = Date.now();
            const rawText = await runWebLlmRuntime(runtime, {
                modelId: options.modelId,
                request,
                messages: toWebLlmMessages(request, options.systemPrompt),
                schema: request.schema,
                signal: request.signal,
            });
            const parsed = parseRallarAiJson(rawText);
            if (!parsed.ok) {
                throw new RallarAiError(
                    'invalid-json',
                    'WebLLM returned a response that was not valid JSON.',
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

async function runWebLlmRuntime<TContext>(
    runtime: RallarAiWebLlmRuntime,
    input: RallarAiWebLlmGenerateInput<TContext>,
): Promise<string> {
    if (runtime.generateJson) {
        return extractWebLlmText(await runtime.generateJson(input));
    }
    if (runtime.chat?.completions?.create) {
        return extractWebLlmText(await runtime.chat.completions.create({
            model: input.modelId,
            messages: input.messages,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: input.request.schemaId,
                    schema: input.schema,
                },
            },
            temperature: input.request.temperature,
            max_tokens: input.request.maxOutputTokens,
            signal: input.signal,
        }));
    }

    throw new RallarAiError(
        'invalid-configuration',
        'WebLLM runtime must expose generateJson(...) or chat.completions.create(...).',
    );
}

function toWebLlmMessages<TContext>(
    request: RallarAiJsonRequest<TContext>,
    systemPrompt?: string,
): readonly RallarAiWebLlmMessage[] {
    return [
        {
            role: 'system',
            content: [
                systemPrompt,
                'Return only JSON that conforms to the provided JSON schema.',
                `Schema JSON: ${JSON.stringify(request.schema)}`,
            ].filter((part): part is string => Boolean(part)).join('\n\n'),
        },
        {
            role: 'user',
            content: [
                request.prompt,
                request.context === undefined
                    ? undefined
                    : `Context JSON: ${JSON.stringify(request.context)}`,
            ].filter((part): part is string => Boolean(part)).join('\n\n'),
        },
    ];
}

function extractWebLlmText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (!isRecord(value)) {
        return JSON.stringify(value);
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
        return JSON.stringify(value.json);
    }

    const firstChoice = Array.isArray(value.choices) ? value.choices[0] : undefined;
    if (isRecord(firstChoice)) {
        if (typeof firstChoice.text === 'string') {
            return firstChoice.text;
        }
        const message = firstChoice.message;
        if (isRecord(message) && typeof message.content === 'string') {
            return message.content;
        }
    }

    return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
