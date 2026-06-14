import {
    createRallarAiJsonResult,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult,
} from '@shared/rallar-ai/mod.ts';

export type WebLlmChatMessage = Readonly<{
    role: 'system' | 'user';
    content: string;
}>;

export type WebLlmChatRequest = Readonly<{
    messages: readonly WebLlmChatMessage[];
    temperature: number;
    max_tokens: number;
    response_format: Readonly<{ type: 'json_object' }>;
}>;

export type WebLlmChatResponse = Readonly<{
    choices?: readonly Readonly<{
        message?: Readonly<{
            content?: string | null;
        }>;
    }>[];
}>;

export type WebLlmEngine = Readonly<{
    chat: Readonly<{
        completions: Readonly<{
            create(input: WebLlmChatRequest): Promise<WebLlmChatResponse>;
        }>;
    }>;
}>;

export type WebLlmModule = Readonly<{
    CreateMLCEngine(
        modelId: string,
        options?: Readonly<{
            initProgressCallback?: (progress: unknown) => void;
        }>,
    ): Promise<WebLlmEngine>;
}>;

export type CreateWebLlmRallarAiProviderOptions = Readonly<{
    modelId: string;
    providerId?: string;
    loadWebLlm?: () => Promise<WebLlmModule>;
    hasWebGpu?: () => boolean;
    onProgress?: (progress: unknown) => void;
}>;

export function createWebLlmRallarAiProvider(
    options: CreateWebLlmRallarAiProviderOptions,
): RallarAiJsonProvider {
    let enginePromise: Promise<WebLlmEngine> | undefined;
    const provider: RallarAiJsonProvider = {
        providerId: options.providerId ?? 'ar-eye-hunter-webllm',
        source: 'browser',
        modelId: options.modelId,
        capabilities: {
            supportsJsonSchema: true,
            supportsStreaming: false,
            supportsCancellation: true,
            target: 'browser',
        },
        async generateJson<TValue = unknown, TContext = unknown>(
            request: RallarAiJsonRequest<TContext>,
        ): Promise<RallarAiJsonResult<TValue>> {
            throwIfAborted(request.signal);
            const startedAtEpochMs = Date.now();
            const engine = await withAbort(getEngine(), request.signal);
            throwIfAborted(request.signal);
            const response = await withAbort(
                engine.chat.completions.create(createChatRequest(request)),
                request.signal,
            );
            const rawText = response.choices?.[0]?.message?.content?.trim() ?? '';
            let value: unknown;
            try {
                value = JSON.parse(rawText);
            } catch (error) {
                throw new Error('WebLLM returned malformed JSON.', { cause: error });
            }

            return createRallarAiJsonResult<TValue>({
                request,
                provider,
                value: value as TValue,
                rawText,
                startedAtEpochMs,
                completedAtEpochMs: Date.now(),
            });
        },
    };

    const getEngine = (): Promise<WebLlmEngine> => {
        if (!(options.hasWebGpu ?? browserHasWebGpu)()) {
            return Promise.reject(new Error('WebGPU is unavailable in this browser.'));
        }
        enginePromise ??= (options.loadWebLlm ?? loadDefaultWebLlm)()
            .then((module) =>
                module.CreateMLCEngine(options.modelId, {
                    initProgressCallback: options.onProgress,
                })
            );
        return enginePromise;
    };

    return provider;
}

function createChatRequest<TContext>(
    request: RallarAiJsonRequest<TContext>,
): WebLlmChatRequest {
    return {
        messages: [
            {
                role: 'system',
                content: [
                    'You are RallarAI running inside AR Eye Hunter.',
                    'Return only one valid JSON object.',
                    'The JSON must match the provided schema.',
                    'Do not include markdown, code fences, comments, or prose.',
                ].join(' '),
            },
            {
                role: 'user',
                content: [
                    request.prompt,
                    '',
                    `Schema: ${JSON.stringify(request.schema)}`,
                    `Context: ${JSON.stringify(request.context ?? {})}`,
                ].join('\n'),
            },
        ],
        temperature: request.temperature ?? 0.6,
        max_tokens: request.maxOutputTokens ?? 512,
        response_format: { type: 'json_object' },
    };
}

async function loadDefaultWebLlm(): Promise<WebLlmModule> {
    return await import('@mlc-ai/web-llm') as WebLlmModule;
}

function browserHasWebGpu(): boolean {
    return Boolean(globalThis.navigator && 'gpu' in globalThis.navigator);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error('WebLLM generation was cancelled.');
}

async function withAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    if (!signal) {
        return await promise;
    }
    throwIfAborted(signal);
    return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            const abort = () => {
                reject(signal.reason instanceof Error
                    ? signal.reason
                    : new Error('WebLLM generation was cancelled.'));
            };
            signal.addEventListener('abort', abort, { once: true });
            promise.finally(() => signal.removeEventListener('abort', abort));
        }),
    ]);
}
