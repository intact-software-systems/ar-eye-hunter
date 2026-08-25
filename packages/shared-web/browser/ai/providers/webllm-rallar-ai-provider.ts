import { createWebLlmJsonResult } from '@shared-web/browser/ai/providers/create-web-llm-json-result.ts';
import {
    RallarAiError,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult
} from '@shared/rallar-ai/mod.ts';

export type RallarAiWebLlmMessage = Readonly<{
    role: 'system' | 'user' | 'assistant';
    content: string;
}>;

export type RallarAiWebLlmBoundaryValue = object | string | number | boolean | null;

export type RallarAiWebLlmChatCompletionInput = Readonly<{
    model: string;
    messages: readonly RallarAiWebLlmMessage[];
    response_format: Readonly<{
        type: 'json_schema';
        json_schema: Readonly<{
            name: string;
            schema: RallarAiWebLlmBoundaryValue;
        }>;
    }>;
    temperature?: number;
    max_tokens?: number;
    signal?: AbortSignal;
}>;

export type RallarAiWebLlmGenerateInput<TContext = RallarAiWebLlmBoundaryValue> = Readonly<{
    modelId: string;
    request: RallarAiJsonRequest<TContext>;
    messages: readonly RallarAiWebLlmMessage[];
    schema: RallarAiWebLlmBoundaryValue;
    signal?: AbortSignal;
}>;

export type RallarAiWebLlmRuntime = Readonly<{
    generateJson?: <TContext = RallarAiWebLlmBoundaryValue>(
        input: RallarAiWebLlmGenerateInput<TContext>
    ) => Promise<RallarAiWebLlmBoundaryValue>;
    chat?: Readonly<{
        completions?: Readonly<{
            create(
                input: RallarAiWebLlmChatCompletionInput
            ): Promise<RallarAiWebLlmBoundaryValue>;
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

/** Owns lazy WebLLM runtime loading, cancellation, execution, and result validation. */
export function createWebLlmRallarAiProvider(
    options: CreateWebLlmRallarAiProviderOptions
): RallarAiJsonProvider {
    let runtimePromise = options.runtime === undefined
        ? undefined
        : Promise.resolve(options.runtime);

    const provider: RallarAiJsonProvider = {
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
            target: 'browser'
        },
        async generateJson<TValue, TContext>(
            request: RallarAiJsonRequest<TContext>
        ): Promise<RallarAiJsonResult<TValue>> {
            throwIfWebLlmAborted(request.signal);
            const startedAtEpochMs = Date.now();
            const runtime = await withWebLlmAbort(
                loadRuntime(),
                request.signal
            );
            const response = await withWebLlmAbort(
                runWebLlmRuntime(runtime, {
                    modelId: options.modelId,
                    request,
                    messages: toWebLlmMessages(request, options.systemPrompt),
                    schema: request.schema as RallarAiWebLlmBoundaryValue,
                    signal: request.signal
                }),
                request.signal
            );
            return createWebLlmJsonResult<TValue, TContext>(
                request,
                provider,
                response,
                startedAtEpochMs,
                Date.now()
            );
        }
    };

    function loadRuntime(): Promise<RallarAiWebLlmRuntime> {
        if (runtimePromise !== undefined) {
            return runtimePromise;
        }
        if (!options.loadRuntime) {
            return Promise.reject(
                new RallarAiError(
                    'invalid-configuration',
                    'A WebLLM runtime or lazy runtime loader is required.'
                )
            );
        }
        runtimePromise = options.loadRuntime();
        return runtimePromise;
    }

    return provider;
}

async function runWebLlmRuntime<TContext>(
    runtime: RallarAiWebLlmRuntime,
    input: RallarAiWebLlmGenerateInput<TContext>
): Promise<RallarAiWebLlmBoundaryValue> {
    if (runtime.generateJson) {
        return await runtime.generateJson(input);
    }
    if (runtime.chat?.completions?.create) {
        return await runtime.chat.completions.create({
            model: input.modelId,
            messages: input.messages,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: input.request.schemaId,
                    schema: input.schema
                }
            },
            temperature: input.request.temperature,
            max_tokens: input.request.maxOutputTokens,
            signal: input.signal
        });
    }

    throw new RallarAiError(
        'invalid-configuration',
        'WebLLM runtime must expose generateJson(...) or chat.completions.create(...).'
    );
}

function toWebLlmMessages<TContext>(
    request: RallarAiJsonRequest<TContext>,
    systemPrompt?: string
): readonly RallarAiWebLlmMessage[] {
    return [
        {
            role: 'system',
            content: [
                systemPrompt,
                'Return only JSON that conforms to the provided JSON schema.',
                `Schema JSON: ${JSON.stringify(request.schema)}`
            ].filter((part): part is string => Boolean(part)).join('\n\n')
        },
        {
            role: 'user',
            content: [
                request.prompt,
                request.context === undefined
                    ? undefined
                    : `Context JSON: ${JSON.stringify(request.context)}`
            ].filter((part): part is string => Boolean(part)).join('\n\n')
        }
    ];
}

function throwIfWebLlmAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason instanceof Error
        ? signal.reason
        : new RallarAiError(
            'provider-cancelled',
            'WebLLM generation was cancelled.'
        );
}

async function withWebLlmAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined
): Promise<T> {
    if (!signal) {
        return await promise;
    }
    throwIfWebLlmAborted(signal);

    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => {
            reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new RallarAiError(
                        'provider-cancelled',
                        'WebLLM generation was cancelled.'
                    )
            );
        };
        signal.addEventListener('abort', abort, { once: true });
    });

    try {
        return await Promise.race([promise, aborted]);
    }
    finally {
        if (abort) {
            signal.removeEventListener('abort', abort);
        }
    }
}
