import { createRallarAiMockProvider, type RallarAiJsonProvider, type RallarAiJsonRequest } from '@shared/rallar-ai/mod.ts';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ARENA_WEBLLM_MODEL_ID, type ArenaBrowserAiConfig } from '../../../../apps/ar-eye-hunter-v1/src/game/browser-ai/arena-browser-ai-config.ts';
import { createArenaBrowserAiProvider } from '../../../../apps/ar-eye-hunter-v1/src/game/browser-ai/arena-browser-ai-provider.ts';

describe('AR Eye Hunter browser AI provider selection', () => {
    it('selects WebLLM when configured and WebGPU is available', () => {
        const webLlmProvider = fakeProvider('webllm-provider');
        const selection = createArenaBrowserAiProvider({
            config: webLlmConfig(),
            createMockProvider: () => fakeProvider('mock-provider'),
            createWebLlmProvider: vi.fn(() => webLlmProvider),
            hasWebGpu: () => true
        });

        expect(selection.status).toBe('ready');
        expect(selection.mode).toBe('webllm');
        expect(selection.provider?.providerId).toBe(webLlmProvider.providerId);
    });

    it('keeps WebLLM generation failures visible without switching providers', async () => {
        const createMockProvider = vi.fn(() => fakeProvider('mock-provider'));
        const request: RallarAiJsonRequest = {
            requestId: 'selection-failure',
            schemaId: 'ar-eye-hunter.selection-test',
            schemaVersion: '1',
            schema: { type: 'object' },
            prompt: 'Return JSON.'
        };
        const selection = createArenaBrowserAiProvider({
            config: webLlmConfig(),
            createMockProvider,
            createWebLlmProvider: vi.fn(() => throwingProvider('webllm-provider')),
            hasWebGpu: () => true
        });

        expect(selection.status).toBe('ready');
        if (selection.status !== 'ready') {
            throw new Error('The browser AI selection did not become ready.');
        }
        await expect(selection.provider.generateJson(request)).rejects.toThrow(
            'model failed'
        );
        expect(createMockProvider).not.toHaveBeenCalled();
    });

    it('returns unavailable when WebGPU is unavailable', () => {
        const selection = createArenaBrowserAiProvider({
            config: webLlmConfig(),
            createMockProvider: () => fakeProvider('mock-provider'),
            createWebLlmProvider: vi.fn(() => fakeProvider('webllm-provider')),
            hasWebGpu: () => false
        });

        expect(selection).toEqual({
            status: 'unavailable',
            mode: 'webllm',
            provider: undefined,
            reason: 'WebGPU is unavailable in this browser.'
        });
    });

    it('selects the mock provider only when mock mode is explicit', () => {
        const mockProvider = createRallarAiMockProvider({
            providerId: 'mock-provider'
        });
        const selection = createArenaBrowserAiProvider({
            config: {
                enabled: true,
                mode: 'mock',
                modelId: DEFAULT_ARENA_WEBLLM_MODEL_ID
            },
            createMockProvider: () => mockProvider,
            hasWebGpu: () => false
        });

        expect(selection).toMatchObject({
            status: 'ready',
            mode: 'mock',
            provider: mockProvider
        });
    });
});

function webLlmConfig(): ArenaBrowserAiConfig {
    return {
        enabled: true,
        mode: 'webllm',
        modelId: DEFAULT_ARENA_WEBLLM_MODEL_ID
    };
}

function fakeProvider(providerId: string): RallarAiJsonProvider {
    return {
        ...createRallarAiMockProvider({ providerId }),
        providerId
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
            target: 'browser'
        },
        async generateJson(request) {
            void request;
            throw new Error('model failed');
        }
    };
}
