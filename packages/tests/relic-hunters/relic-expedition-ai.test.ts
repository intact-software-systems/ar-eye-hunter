import { describe, expect, it, vi } from 'vitest';
import {
    createProceduralRelicExpeditionBlueprint,
    type RelicExpeditionBlueprint,
} from '@relic-hunters/mod.ts';
import type {
    RallarAiJsonProvider,
    RallarAiJsonRequest,
    RallarAiJsonResult,
} from '@shared/rallar-ai/mod.ts';
import type { RallarServerAiRallar } from '@shared-server/rallar-ai/mod.ts';
import {
    createRelicExpeditionInitialStateFactory,
    readRelicAiExpeditionEnv,
} from '../../../apps/relic-hunter-server-v1/src/relic-expedition-ai.ts';

describe('Relic expedition AI factory', () => {
    it('keeps the current static game when disabled', async () => {
        const factory = createRelicExpeditionInitialStateFactory({
            mode: 'off',
            now: () => 1,
        });

        const state = await factory('room-1', 'ensure');

        expect(state.setup).toMatchObject({
            source: 'default',
            blueprintId: 'relic-static-v1',
        });
        expect(state.map.map((room) => room.id)).toEqual([
            'entrance',
            'hallway',
            'storage',
            'shrine',
            'trap',
            'treasure',
            'monster',
            'exit',
        ]);
    });

    it('creates a mock RallarAI blueprint when mock mode is enabled', async () => {
        const factory = createRelicExpeditionInitialStateFactory({
            rallar: fakeRallar(),
            mode: 'mock',
            now: () => 2,
        });

        const state = await factory('room-1', 'reset');

        expect(state.setup).toMatchObject({
            source: 'mock',
            seed: 'room-1:reset:2',
        });
        expect(state.map.length).toBeGreaterThanOrEqual(8);
        expect(state.relics.length).toBeGreaterThanOrEqual(4);
    });

    it('falls back to procedural setup when generated output is invalid', async () => {
        const fallback = vi.fn();
        const factory = createRelicExpeditionInitialStateFactory({
            rallar: fakeRallar(),
            mode: 'mock',
            now: () => 3,
            mockBlueprint: { schemaVersion: 1 } as unknown as RelicExpeditionBlueprint,
            onFallback: fallback,
        });

        const state = await factory('room-1', 'ensure');

        expect(state.setup).toMatchObject({
            source: 'procedural',
            seed: 'room-1:ensure:3',
        });
        expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
            gameId: 'room-1',
            mode: 'mock',
            reason: 'ensure',
        }));
    });

    it('falls back to procedural setup when a provider times out', async () => {
        const provider = createAbortAwareProvider();
        const factory = createRelicExpeditionInitialStateFactory({
            rallar: fakeRallar(),
            mode: 'mock',
            provider,
            timeoutMs: 1,
            now: () => 4,
        });

        const state = await factory('room-1', 'command');

        expect(state.setup).toMatchObject({
            source: 'procedural',
            seed: 'room-1:command:4',
        });
    });

    it('reads Relic-specific environment defaults and overrides', () => {
        expect(readRelicAiExpeditionEnv(env({}))).toEqual({
            mode: 'off',
            timeoutMs: 15_000,
            ollamaBaseUrl: 'http://127.0.0.1:11434',
            ollamaModel: 'llama-test',
        });
        expect(readRelicAiExpeditionEnv(env({
            RELIC_AI_EXPEDITION_MODE: 'ollama',
            RELIC_AI_EXPEDITION_TIMEOUT_MS: '250',
            RELIC_AI_EXPEDITION_OLLAMA_BASE_URL: 'http://localhost:11434',
            RELIC_AI_EXPEDITION_OLLAMA_MODEL: 'llama3.2',
        }))).toEqual({
            mode: 'ollama',
            timeoutMs: 250,
            ollamaBaseUrl: 'http://localhost:11434',
            ollamaModel: 'llama3.2',
        });
    });
});

function fakeRallar(): RallarServerAiRallar {
    return {
        ws: {
            defineTopic: vi.fn(),
            on: vi.fn(),
            publish: vi.fn(),
        },
    } as unknown as RallarServerAiRallar;
}

function env(values: Readonly<Record<string, string | undefined>>) {
    return {
        get: (name: string) => values[name],
    };
}

function createAbortAwareProvider(): RallarAiJsonProvider {
    return {
        providerId: 'abort-aware',
        source: 'mock',
        modelId: 'abort-aware',
        capabilities: {
            supportsJsonSchema: true,
            supportsStreaming: false,
            supportsCancellation: true,
            target: 'shared',
        },
        generateJson<TValue = unknown, TContext = unknown>(
            request: RallarAiJsonRequest<TContext>,
        ): Promise<RallarAiJsonResult<TValue>> {
            return new Promise((resolve, reject) => {
                const abort = () => reject(request.signal?.reason ?? new Error('aborted'));
                request.signal?.addEventListener('abort', abort, { once: true });
                setTimeout(() => {
                    request.signal?.removeEventListener('abort', abort);
                    resolve({
                        protocolVersion: 1,
                        generationId: 'late',
                        source: 'mock',
                        providerId: 'abort-aware',
                        modelId: 'abort-aware',
                        schemaId: request.schemaId,
                        schemaVersion: request.schemaVersion,
                        schemaHash: 'test',
                        promptHash: 'test',
                        createdAtEpochMs: 1,
                        value: createProceduralRelicExpeditionBlueprint({
                            seed: 'late',
                        }) as TValue,
                        validation: { ok: true, errors: [], issues: [] },
                    });
                }, 50);
            });
        },
    };
}
