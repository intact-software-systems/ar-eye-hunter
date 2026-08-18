import { describe, expect, it, vi } from 'vitest';
import {
    createRallarAiJsonResult,
    createRallarAiMockProvider,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
} from '@shared/rallar-ai/mod.ts';

import {
    DEFAULT_ARENA_WEBLLM_MODEL_ID,
    type ArenaBrowserAiConfig,
} from '../../../apps/ar-eye-hunter-v1/src/game/browserAiConfig.ts';
import {
    createArenaBrowserAiProvider,
} from '../../../apps/ar-eye-hunter-v1/src/game/browserAiProvider.ts';

describe('AR Eye Hunter browser AI provider selection', () => {
    it('selects WebLLM when configured and WebGPU is available', () => {
        const webLlmProvider = fakeProvider('webllm-provider');
        const selection = createArenaBrowserAiProvider({
            config: webLlmConfig('mock'),
            createMockProvider: () => fakeProvider('mock-provider'),
            createWebLlmProvider: vi.fn(() => webLlmProvider),
            hasWebGpu: () => true,
        });

        expect(selection.status).toBe('ready');
        expect(selection.mode).toBe('webllm');
        expect(selection.provider?.providerId).toBe(webLlmProvider.providerId);
        expect(selection.reason).toBeUndefined();
    });

    it('falls back to mock when WebLLM generation fails after selection', async () => {
        const fallbackSpy = vi.fn();
        const request: RallarAiJsonRequest = {
            requestId: 'selection-fallback',
            schemaId: 'ar-eye-hunter.selection-test',
            schemaVersion: '1',
            schema: { type: 'object' },
            prompt: 'Return JSON.',
        };
        const selection = createArenaBrowserAiProvider({
            config: webLlmConfig('mock'),
            createMockProvider: () => createRallarAiMockProvider({
                providerId: 'mock-provider',
                value: { fallback: true },
            }),
            createWebLlmProvider: vi.fn(() => throwingProvider('webllm-provider')),
            hasWebGpu: () => true,
            onFallback: fallbackSpy,
        });

        expect(selection.status).toBe('ready');
        if (selection.status !== 'ready') {
            throw new Error('The browser AI selection did not become ready.');
        }
        const result = await selection.provider.generateJson(request);

        expect(result.value).toEqual({ fallback: true });
        expect(result.providerId).toBe('mock-provider');
        expect(fallbackSpy).toHaveBeenCalledWith('model failed');
    });

    it('falls back to mock when WebGPU is unavailable and fallback is enabled', () => {
        const mockProvider = fakeProvider('mock-provider');
        const selection = createArenaBrowserAiProvider({
            config: webLlmConfig('mock'),
            createMockProvider: () => mockProvider,
            createWebLlmProvider: vi.fn(() => fakeProvider('webllm-provider')),
            hasWebGpu: () => false,
        });

        expect(selection.status).toBe('ready');
        expect(selection.mode).toBe('mock');
        expect(selection.provider).toBe(mockProvider);
        expect(selection.fallback).toBe(true);
        expect(selection.reason).toContain('WebGPU');
    });

    it('returns unavailable when WebGPU is unavailable and fallback is disabled', () => {
        const selection = createArenaBrowserAiProvider({
            config: webLlmConfig('off'),
            createMockProvider: () => fakeProvider('mock-provider'),
            createWebLlmProvider: vi.fn(() => fakeProvider('webllm-provider')),
            hasWebGpu: () => false,
        });

        expect(selection).toEqual({
            status: 'unavailable',
            mode: 'webllm',
            provider: undefined,
            fallback: false,
            reason: 'WebGPU is unavailable in this browser.',
        });
    });
});

function webLlmConfig(fallbackMode: 'mock' | 'off'): ArenaBrowserAiConfig {
    return {
        enabled: true,
        mode: 'webllm',
        modelId: DEFAULT_ARENA_WEBLLM_MODEL_ID,
        fallbackMode,
    };
}

function fakeProvider(providerId: string): RallarAiJsonProvider {
    return {
        ...createRallarAiMockProvider({ providerId }),
        providerId,
    };
}

function throwingProvider(providerId: string): RallarAiJsonProvider {
    return {
        providerId,
        source: 'browser',
        modelId: 'throwing-model',
        capabilities: {
            supportsJsonSchema: true,
            supportsStreaming: false,
            supportsCancellation: true,
            target: 'browser',
        },
        async generateJson(request) {
            void createRallarAiJsonResult({
                request,
                provider: this,
                value: {},
            });
            throw new Error('model failed');
        },
    };
}
