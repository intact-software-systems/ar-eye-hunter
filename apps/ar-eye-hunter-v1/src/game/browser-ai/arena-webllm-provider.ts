import {
    createWebLlmRallarAiProvider,
    type RallarAiWebLlmRuntime
} from '@shared-web/browser/ai/providers/webllm-rallar-ai-provider.ts';
import {
    defineRallarAiProviderGovernanceMetadata,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest
} from '@shared/rallar-ai/mod.ts';

import { DEFAULT_ARENA_WEBLLM_MODEL_ID } from './arena-browser-ai-config.ts';

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
            initProgressCallback?: (progress: object) => void;
        }>
    ): Promise<WebLlmEngine>;
}>;

export type CreateArenaWebLlmProviderOptions = Readonly<{
    modelId: string;
    providerId?: string;
    loadWebLlm?: () => Promise<WebLlmModule>;
    hasWebGpu?: () => boolean;
    onProgress?: (progress: object) => void;
}>;

/** Adapts AR Eye's WebLLM engine loader to the canonical shared-web provider. */
export function createArenaWebLlmProvider(
    options: CreateArenaWebLlmProviderOptions
): RallarAiJsonProvider {
    return createWebLlmRallarAiProvider({
        modelId: options.modelId,
        providerId: options.providerId ?? ARENA_WEBLLM_PROVIDER_ID,
        supportsJsonSchema: true,
        maxOutputTokens: ARENA_WEBLLM_PROVIDER_GOVERNANCE.knownLimits?.maxOutputTokens,
        loadRuntime: async () => {
            if (!(options.hasWebGpu ?? browserHasWebGpu)()) {
                throw new Error('WebGPU is unavailable in this browser.');
            }
            const webLlm = await (options.loadWebLlm ?? loadDefaultWebLlm)();
            const engine = await webLlm.CreateMLCEngine(options.modelId, {
                initProgressCallback: options.onProgress
            });
            return createArenaWebLlmRuntime(engine);
        }
    });
}

function createArenaWebLlmRuntime(engine: WebLlmEngine): RallarAiWebLlmRuntime {
    return {
        generateJson: async (input) =>
            await engine.chat.completions.create(
                createArenaWebLlmChatRequest(input.request)
            )
    };
}

function createArenaWebLlmChatRequest<TContext>(
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
