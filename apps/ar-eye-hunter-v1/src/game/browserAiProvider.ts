import type { RallarAiJsonProvider, RallarAiJsonRequest, RallarAiJsonResult } from '@shared/rallar-ai/mod.ts';

import { type ArenaBrowserAiConfig } from './browserAiConfig.ts';
import { createWebLlmRallarAiProvider, type CreateWebLlmRallarAiProviderOptions } from './webLlmProvider.ts';

export type ArenaBrowserAiProviderMode = 'mock' | 'webllm';

export type ArenaBrowserAiProviderSelection =
    | Readonly<{
        status: 'ready';
        mode: ArenaBrowserAiProviderMode;
        provider: RallarAiJsonProvider;
        fallback: boolean;
        reason?: string;
    }>
    | Readonly<{
        status: 'unavailable';
        mode: ArenaBrowserAiConfig['mode'];
        provider?: undefined;
        fallback: false;
        reason: string;
    }>;

export type CreateArenaBrowserAiProviderOptions = Readonly<{
    config: ArenaBrowserAiConfig;
    createMockProvider: () => RallarAiJsonProvider;
    createWebLlmProvider?: (options: CreateWebLlmRallarAiProviderOptions) => RallarAiJsonProvider;
    hasWebGpu?: () => boolean;
    onFallback?: (reason: string) => void;
    onWebLlmProgress?: (progress: unknown) => void;
}>;

export function createArenaBrowserAiProvider(
    options: CreateArenaBrowserAiProviderOptions
): ArenaBrowserAiProviderSelection {
    const config = options.config;
    if (!config.enabled || config.mode === 'off') {
        return {
            status: 'unavailable',
            mode: 'off',
            fallback: false,
            reason: 'Browser RallarAI is disabled.'
        };
    }
    if (config.mode === 'mock') {
        return {
            status: 'ready',
            mode: 'mock',
            provider: options.createMockProvider(),
            fallback: false
        };
    }

    const hasWebGpu = (options.hasWebGpu ?? browserHasWebGpu)();
    if (!hasWebGpu) {
        if (config.fallbackMode === 'mock') {
            return {
                status: 'ready',
                mode: 'mock',
                provider: options.createMockProvider(),
                fallback: true,
                reason: 'WebGPU is unavailable in this browser.'
            };
        }
        return {
            status: 'unavailable',
            mode: 'webllm',
            provider: undefined,
            fallback: false,
            reason: 'WebGPU is unavailable in this browser.'
        };
    }

    const webLlmProvider = (options.createWebLlmProvider ?? createWebLlmRallarAiProvider)({
        modelId: config.modelId,
        hasWebGpu: () => hasWebGpu,
        onProgress: options.onWebLlmProgress
    });
    const provider = config.fallbackMode === 'mock'
        ? createProviderWithMockFallback(
            webLlmProvider,
            options.createMockProvider(),
            options.onFallback
        )
        : webLlmProvider;

    return {
        status: 'ready',
        mode: 'webllm',
        provider,
        fallback: false
    };
}

function createProviderWithMockFallback(
    primary: RallarAiJsonProvider,
    fallback: RallarAiJsonProvider,
    onFallback: ((reason: string) => void) | undefined
): RallarAiJsonProvider {
    return {
        providerId: primary.providerId,
        source: primary.source,
        modelId: primary.modelId,
        capabilities: primary.capabilities,
        async generateJson<TValue = unknown, TContext = unknown>(
            request: RallarAiJsonRequest<TContext>
        ): Promise<RallarAiJsonResult<TValue>> {
            try {
                return await primary.generateJson<TValue, TContext>(request);
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                onFallback?.(reason);
                return await fallback.generateJson<TValue, TContext>(request);
            }
        }
    };
}

function browserHasWebGpu(): boolean {
    return Boolean(globalThis.navigator && 'gpu' in globalThis.navigator);
}
