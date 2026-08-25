import { createProceduralRelicExpeditionBlueprint, type RelicExpeditionBlueprint } from '@relic-hunters/mod.ts';
import {
    createRallarAiMockProvider,
    isRallarAiProviderAllowedInProduction,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it, vi } from 'vitest';
import {
    createRelicExpeditionAiEvaluationCases,
    createRelicExpeditionInitialStateFactory,
    RELIC_EXPEDITION_LIVE_OLLAMA_EVALUATION_GATE,
    RELIC_EXPEDITION_OLLAMA_PROVIDER_GOVERNANCE,
    runRelicExpeditionDeterministicAiEvaluation,
    runRelicExpeditionOllamaLiveEvaluationIfEnabled
} from '../../../apps/relic-hunter-server-v1/src/relic-expedition-ai.ts';
import type { RelicAiExpeditionConfiguration, RelicAiExpeditionMode } from '../../../apps/relic-hunter-server-v1/src/relic-hunter-server-configuration.ts';

describe('Relic expedition AI factory', () => {
    it('declares app-owned governance metadata for the Ollama expedition provider', () => {
        expect(RELIC_EXPEDITION_OLLAMA_PROVIDER_GOVERNANCE).toMatchObject({
            providerId: 'relic-expedition-ollama',
            adapterVersion: 'relic-hunter-server-v1/ollama-expedition:1',
            modelId: 'llama-test',
            target: 'server',
            structuredOutput: true,
            productionAllowed: false,
            knownLimits: {
                maxOutputTokens: 1_600,
                recommendedTimeoutMs: 15_000
            }
        });
        expect(
            isRallarAiProviderAllowedInProduction(
                RELIC_EXPEDITION_OLLAMA_PROVIDER_GOVERNANCE,
                'server'
            )
        ).toBe(false);
    });

    it('keeps the current static game when disabled', async () => {
        const factory = createRelicExpeditionInitialStateFactory({
            configuration: expeditionAiConfiguration('off'),
            now: () => 1
        });

        const state = await factory('room-1', 'ensure');

        expect(state.setup).toMatchObject({
            source: 'default',
            blueprintId: 'relic-static-v1'
        });
        expect(state.map.map((room) => room.id)).toEqual([
            'entrance',
            'hallway',
            'storage',
            'shrine',
            'trap',
            'treasure',
            'monster',
            'exit'
        ]);
    });

    it('creates a mock RallarAI blueprint when mock mode is enabled', async () => {
        const factory = createRelicExpeditionInitialStateFactory({
            configuration: expeditionAiConfiguration('mock'),
            now: () => 2
        });

        const state = await factory('room-1', 'reset');

        expect(state.setup).toMatchObject({
            source: 'mock',
            seed: 'room-1:reset:2'
        });
        expect(state.map.length).toBeGreaterThanOrEqual(8);
        expect(state.relics.length).toBeGreaterThanOrEqual(4);
    });

    it('falls back to procedural setup when generated output is invalid', async () => {
        const fallback = vi.fn();
        const factory = createRelicExpeditionInitialStateFactory({
            configuration: expeditionAiConfiguration('mock'),
            now: () => 3,
            provider: createRallarAiMockProvider({ value: { schemaVersion: 1 } }),
            onFallback: fallback
        });

        const state = await factory('room-1', 'ensure');

        expect(state.setup).toMatchObject({
            source: 'procedural',
            seed: 'room-1:ensure:3'
        });
        expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
            gameId: 'room-1',
            mode: 'mock',
            reason: 'ensure'
        }));
    });

    it('falls back when generated output is playable but visually out of fit', async () => {
        const fallback = vi.fn();
        const factory = createRelicExpeditionInitialStateFactory({
            configuration: expeditionAiConfiguration('mock'),
            now: () => 6,
            mockBlueprint: createProceduralRelicExpeditionBlueprint({
                seed: 'visually-bad',
                theme: 'Moonlit Keep',
                source: 'mock'
            }),
            onFallback: fallback
        });

        const state = await factory('room-1', 'reset');

        expect(state.setup).toMatchObject({
            source: 'procedural',
            seed: 'room-1:reset:6'
        });
        expect(fallback).toHaveBeenCalledWith(expect.objectContaining({
            gameId: 'room-1',
            mode: 'mock',
            reason: 'reset'
        }));
    });

    it('falls back to procedural setup when a provider times out', async () => {
        const provider = createAbortAwareProvider();
        const factory = createRelicExpeditionInitialStateFactory({
            configuration: expeditionAiConfiguration('mock', 1),
            provider,
            now: () => 4
        });

        const state = await factory('room-1', 'command');

        expect(state.setup).toMatchObject({
            source: 'procedural',
            seed: 'room-1:command:4'
        });
    });

    it('builds deterministic expedition evaluation cases for CI', async () => {
        const report = await runRelicExpeditionDeterministicAiEvaluation({
            gameId: 'room-1',
            reason: 'ensure',
            seed: 'room-1:ensure:ci',
            timeoutMs: 15_000,
            mockBlueprint: createProceduralRelicExpeditionBlueprint({
                seed: 'room-1:ensure:ci',
                source: 'mock'
            })
        });

        expect(report).toMatchObject({
            suiteId: 'relic-expedition-ollama-ci',
            providerId: 'relic-expedition-mock',
            passed: 1,
            failed: 0
        });
        expect(report.results[0]).toEqual(
            expect.objectContaining({
                caseId: 'expedition-blueprint',
                validationOk: true
            })
        );
    });

    it('keeps live Ollama expedition evaluation behind an explicit opt-in gate', async () => {
        const cases = createRelicExpeditionAiEvaluationCases({
            gameId: 'room-1',
            reason: 'ensure',
            seed: 'room-1:ensure:live-test',
            timeoutMs: 250
        });
        const liveProvider = createStaticBlueprintProvider(
            createProceduralRelicExpeditionBlueprint({
                seed: 'room-1:ensure:live-test',
                source: 'mock'
            })
        );

        const skipped = await runRelicExpeditionOllamaLiveEvaluationIfEnabled({
            env: {},
            configuration: expeditionAiConfiguration('ollama'),
            cases,
            provider: liveProvider
        });

        expect(skipped).toEqual(expect.objectContaining({
            status: 'skipped',
            gate: RELIC_EXPEDITION_LIVE_OLLAMA_EVALUATION_GATE
        }));

        const ran = await runRelicExpeditionOllamaLiveEvaluationIfEnabled({
            env: { [RELIC_EXPEDITION_LIVE_OLLAMA_EVALUATION_GATE]: '1' },
            configuration: expeditionAiConfiguration('ollama'),
            cases,
            provider: liveProvider
        });

        expect(ran).toEqual(expect.objectContaining({
            status: 'ran',
            report: expect.objectContaining({
                suiteId: 'relic-expedition-ollama-live',
                providerId: 'relic-expedition-ollama',
                passed: 1,
                failed: 0
            })
        }));
    });
});

function expeditionAiConfiguration(
    mode: RelicAiExpeditionMode,
    timeoutMs = 15_000
): RelicAiExpeditionConfiguration {
    return {
        mode,
        timeoutMs,
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        ollamaModel: 'llama-test'
    };
}

function createAbortAwareProvider(): RallarAiJsonProvider {
    const provider = createRallarAiMockProvider({
        providerId: 'abort-aware',
        modelId: 'abort-aware',
        value: createProceduralRelicExpeditionBlueprint({ seed: 'late' })
    });
    return {
        ...provider,
        generateJson<TValue, TContext>(
            request: RallarAiJsonRequest<TContext>
        ) {
            return new Promise<never>((_resolve, reject) => {
                const abort = () => reject(request.signal?.reason ?? new Error('aborted'));
                request.signal?.addEventListener('abort', abort, { once: true });
            });
        }
    };
}

function createStaticBlueprintProvider(
    blueprint: RelicExpeditionBlueprint
): RallarAiJsonProvider {
    return createRallarAiMockProvider({
        providerId: 'relic-expedition-ollama',
        modelId: 'llama-test',
        value: blueprint,
        createdAtEpochMs: 1
    });
}
