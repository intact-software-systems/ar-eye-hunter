import type { RallarAiJsonProvider } from '@shared/rallar-ai/mod.ts';

import { type ArenaBrowserAiConfig } from './arena-browser-ai-config.ts';
import { createArenaWebLlmProvider, type CreateArenaWebLlmProviderOptions } from './arena-webllm-provider.ts';

export type ArenaBrowserAiProviderMode = 'mock' | 'webllm';

export type ArenaBrowserAiProviderSelection =
    | Readonly<{
        status: 'ready';
        mode: ArenaBrowserAiProviderMode;
        provider: RallarAiJsonProvider;
    }>
    | Readonly<{
        status: 'unavailable';
        mode: ArenaBrowserAiConfig['mode'];
        provider?: undefined;
        reason: string;
    }>;

export type CreateArenaBrowserAiProviderOptions = Readonly<{
    config: ArenaBrowserAiConfig;
    createMockProvider: () => RallarAiJsonProvider;
    createWebLlmProvider?: (
        options: CreateArenaWebLlmProviderOptions
    ) => RallarAiJsonProvider;
    hasWebGpu?: () => boolean;
    onWebLlmProgress?: (progress: object) => void;
}>;

export function createArenaBrowserAiProvider(
    options: CreateArenaBrowserAiProviderOptions
): ArenaBrowserAiProviderSelection {
    const config = options.config;
    if (!config.enabled || config.mode === 'off') {
        return {
            status: 'unavailable',
            mode: 'off',
            reason: 'Browser RallarAI is disabled.'
        };
    }
    if (config.mode === 'mock') {
        return {
            status: 'ready',
            mode: 'mock',
            provider: options.createMockProvider()
        };
    }

    const hasWebGpu = (options.hasWebGpu ?? browserHasWebGpu)();
    if (!hasWebGpu) {
        return {
            status: 'unavailable',
            mode: 'webllm',
            provider: undefined,
            reason: 'WebGPU is unavailable in this browser.'
        };
    }

    const provider = (options.createWebLlmProvider ?? createArenaWebLlmProvider)({
        modelId: config.modelId,
        hasWebGpu: () => hasWebGpu,
        onProgress: options.onWebLlmProgress
    });

    return {
        status: 'ready',
        mode: 'webllm',
        provider
    };
}

function browserHasWebGpu(): boolean {
    return Boolean(globalThis.navigator && 'gpu' in globalThis.navigator);
}
