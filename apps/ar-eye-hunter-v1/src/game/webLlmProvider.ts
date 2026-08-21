import {
    createRallarAiJsonResult,
    defineRallarAiProviderGovernanceMetadata,
    isRallarAiLiveEvaluationEnabled,
    runRallarAiEvaluationSuite,
    runRallarAiEvaluationSuiteIfEnabled,
    type RallarAiEvaluationCase,
    type RallarAiEvaluationSuiteResult,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonResult,
    type RallarAiLiveEvaluationEnvironment,
    type RallarAiLiveEvaluationRunResult
} from '@shared/rallar-ai/mod.ts';

import {
    createAiDirectorMockProvider,
    createAiDirectorRequest,
    validateAiDirectorProposalValue
} from './aiDirector.ts';
import { DEFAULT_ARENA_WEBLLM_MODEL_ID } from './browserAiConfig.ts';
import { createInitialArenaState, toArenaSnapshot } from './simulation.ts';

export const ARENA_WEBLLM_PROVIDER_ID = 'ar-eye-hunter-webllm';
export const ARENA_WEBLLM_LIVE_EVALUATION_GATE = 'RALLAR_AI_LIVE_WEBLLM';
export const ARENA_WEBLLM_PROVIDER_GOVERNANCE = defineRallarAiProviderGovernanceMetadata({
    providerId: ARENA_WEBLLM_PROVIDER_ID,
    adapterVersion: 'ar-eye-hunter-v1/webllm-provider:1',
    modelId: DEFAULT_ARENA_WEBLLM_MODEL_ID,
    target: 'browser',
    licenseNotes: 'Runs the selected WebLLM model in the browser; model license follows VITE_RALLAR_WEBLLM_MODEL.',
    productionAllowed: false,
    structuredOutput: true,
    knownLimits: {
        maxOutputTokens: 1_200,
        recommendedTimeoutMs: 4_000
    }
});

export type WebLlmChatMessage = Readonly<{
    role: 'system' | 'user';
    content: string;
}>;

export type WebLlmChatRequest = Readonly<{
    messages: readonly WebLlmChatMessage[];
    temperature: number;
    max_tokens: number;
    response_format: Readonly<{ type: 'json_object'; }>;
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
        }>
    ): Promise<WebLlmEngine>;
}>;

export type CreateWebLlmRallarAiProviderOptions = Readonly<{
    modelId: string;
    providerId?: string;
    loadWebLlm?: () => Promise<WebLlmModule>;
    hasWebGpu?: () => boolean;
    onProgress?: (progress: unknown) => void;
}>;

export type ArenaWebLlmEvaluationOptions = Readonly<{
    nowEpochMs?: number;
    roomId?: string;
    seed?: number;
}>;

export type RunArenaWebLlmLiveEvaluationOptions =
    & ArenaWebLlmEvaluationOptions
    & Readonly<{
        env: RallarAiLiveEvaluationEnvironment;
        gate?: string;
        modelId?: string;
        createProvider?: () => RallarAiJsonProvider;
        loadWebLlm?: () => Promise<WebLlmModule>;
        hasWebGpu?: () => boolean;
        onProgress?: (progress: unknown) => void;
    }>;

export function createArenaWebLlmEvaluationCases(
    options: ArenaWebLlmEvaluationOptions = {}
): readonly RallarAiEvaluationCase[] {
    const nowEpochMs = options.nowEpochMs ?? 18_000;
    const roomId = options.roomId ?? 'arena-webllm-evaluation';
    const state = createInitialArenaState(options.seed ?? 7_331, nowEpochMs);
    const snapshot = toArenaSnapshot(state, roomId, nowEpochMs);

    return [
        {
            caseId: 'ai-director-chaos-event',
            request: createAiDirectorRequest(state, roomId),
            validateResult: (result) => {
                const validation = validateAiDirectorProposalValue(
                    result.value,
                    snapshot
                );
                return validation.ok ? [] : [validation.reason];
            }
        }
    ];
}

export async function runArenaWebLlmDeterministicEvaluation(
    options: ArenaWebLlmEvaluationOptions = {}
): Promise<RallarAiEvaluationSuiteResult> {
    return await runRallarAiEvaluationSuite({
        suiteId: 'ar-eye-hunter-webllm-ci',
        provider: createAiDirectorMockProvider(),
        cases: createArenaWebLlmEvaluationCases(options)
    });
}

export async function runArenaWebLlmLiveEvaluationIfEnabled(
    options: RunArenaWebLlmLiveEvaluationOptions
): Promise<RallarAiLiveEvaluationRunResult> {
    const gate = options.gate ?? ARENA_WEBLLM_LIVE_EVALUATION_GATE;
    if (!isRallarAiLiveEvaluationEnabled(options.env, gate)) {
        return {
            status: 'skipped',
            gate,
            reason: `AR Eye Hunter WebLLM live evaluation requires ${gate}=1.`
        };
    }

    const provider = options.createProvider?.() ?? createWebLlmRallarAiProvider({
        modelId: options.modelId ?? DEFAULT_ARENA_WEBLLM_MODEL_ID,
        loadWebLlm: options.loadWebLlm,
        hasWebGpu: options.hasWebGpu,
        onProgress: options.onProgress
    });

    return await runRallarAiEvaluationSuiteIfEnabled({
        suiteId: 'ar-eye-hunter-webllm-live',
        provider,
        cases: createArenaWebLlmEvaluationCases(options),
        env: options.env,
        gate,
        providerLabel: 'AR Eye Hunter WebLLM'
    });
}

export function createWebLlmRallarAiProvider(
    options: CreateWebLlmRallarAiProviderOptions
): RallarAiJsonProvider {
    let enginePromise: Promise<WebLlmEngine> | undefined;
    const provider: RallarAiJsonProvider = {
        providerId: options.providerId ?? ARENA_WEBLLM_PROVIDER_ID,
        source: 'browser',
        modelId: options.modelId,
        capabilities: {
            supportsJsonSchema: true,
            supportsStreaming: false,
            supportsCancellation: true,
            target: 'browser'
        },
        async generateJson<TValue = unknown, TContext = unknown>(
            request: RallarAiJsonRequest<TContext>
        ): Promise<RallarAiJsonResult<TValue>> {
            throwIfAborted(request.signal);
            const startedAtEpochMs = Date.now();
            const engine = await withAbort(getEngine(), request.signal);
            throwIfAborted(request.signal);
            const response = await withAbort(
                engine.chat.completions.create(createChatRequest(request)),
                request.signal
            );
            const rawText = response.choices?.[0]?.message?.content?.trim() ?? '';
            let value: unknown;
            try {
                value = JSON.parse(rawText);
            }
            catch (error) {
                throw new Error('WebLLM returned malformed JSON.', { cause: error });
            }

            return createRallarAiJsonResult<TValue>({
                request,
                provider,
                value: value as TValue,
                rawText,
                startedAtEpochMs,
                completedAtEpochMs: Date.now()
            });
        }
    };

    const getEngine = (): Promise<WebLlmEngine> => {
        if (!(options.hasWebGpu ?? browserHasWebGpu)()) {
            return Promise.reject(new Error('WebGPU is unavailable in this browser.'));
        }
        enginePromise ??= (options.loadWebLlm ?? loadDefaultWebLlm)()
            .then((module) =>
                module.CreateMLCEngine(options.modelId, {
                    initProgressCallback: options.onProgress
                })
            );
        return enginePromise;
    };

    return provider;
}

function createChatRequest<TContext>(
    request: RallarAiJsonRequest<TContext>
): WebLlmChatRequest {
    return {
        messages: [
            {
                role: 'system',
                content: [
                    'You are RallarAI running inside AR Eye Hunter.',
                    'Return only one valid JSON object.',
                    'The JSON must match the provided schema.',
                    'Do not include markdown, code fences, comments, or prose.'
                ].join(' ')
            },
            {
                role: 'user',
                content: [
                    request.prompt,
                    '',
                    `Schema: ${JSON.stringify(request.schema)}`,
                    `Context: ${JSON.stringify(request.context ?? {})}`
                ].join('\n')
            }
        ],
        temperature: request.temperature ?? 0.6,
        max_tokens: request.maxOutputTokens ?? 512,
        response_format: { type: 'json_object' }
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
    signal: AbortSignal | undefined
): Promise<T> {
    if (!signal) {
        return await promise;
    }
    throwIfAborted(signal);
    return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            const abort = () => {
                reject(
                    signal.reason instanceof Error
                        ? signal.reason
                        : new Error('WebLLM generation was cancelled.')
                );
            };
            signal.addEventListener('abort', abort, { once: true });
            promise.finally(() => signal.removeEventListener('abort', abort));
        })
    ]);
}
