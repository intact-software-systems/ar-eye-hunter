import { createRallarAiOllamaProvider } from '@shared-server/rallar-ai/mod.ts';
import {
    createRallarAiMockProvider,
    isRallarAiLiveEvaluationEnabled,
    runRallarAiEvaluationSuiteIfEnabled,
    type RallarAiJsonProvider,
    type RallarAiLiveEvaluationEnvironment
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

describe('RallarAI live Ollama evaluation harness', () => {
    const gameEventSchema = {
        type: 'object',
        required: ['kind'],
        properties: {
            kind: { type: 'string' }
        },
        additionalProperties: false
    } as const;

    it('skips by default and runs only when RALLAR_AI_LIVE_OLLAMA is enabled', async () => {
        const env = readProcessEnv();
        const liveEnabled = isRallarAiLiveEvaluationEnabled(
            env,
            'RALLAR_AI_LIVE_OLLAMA'
        );
        const provider: RallarAiJsonProvider = liveEnabled
            ? createRallarAiOllamaProvider({
                model: env.RALLAR_AI_OLLAMA_MODEL ?? 'llama-test',
                baseUrl: env.RALLAR_AI_OLLAMA_BASE_URL ??
                    'http://127.0.0.1:11434',
                allowedBaseUrls: [
                    env.RALLAR_AI_OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
                    'http://127.0.0.1:11434',
                    'http://localhost:11434'
                ]
            })
            : createRallarAiMockProvider({
                value: { kind: 'spawn' }
            });

        const result = await runRallarAiEvaluationSuiteIfEnabled({
            suiteId: 'ollama-live-game-event-smoke',
            provider,
            cases: [
                {
                    caseId: 'spawn-event',
                    request: {
                        schemaId: 'game-event',
                        schemaVersion: '1',
                        schema: gameEventSchema,
                        prompt: 'Return JSON for a spawn event.',
                        timeoutMs: 20_000
                    },
                    validateResult: (generated) => generated.validation.ok ? [] : ['schema validation failed']
                }
            ],
            env,
            gate: 'RALLAR_AI_LIVE_OLLAMA',
            providerLabel: 'Ollama'
        });

        if (!liveEnabled) {
            expect(result).toEqual(
                expect.objectContaining({
                    status: 'skipped',
                    gate: 'RALLAR_AI_LIVE_OLLAMA'
                })
            );
            return;
        }

        expect(result).toEqual(
            expect.objectContaining({
                status: 'ran',
                report: expect.objectContaining({
                    suiteId: 'ollama-live-game-event-smoke',
                    providerId: 'ollama',
                    failed: 0
                })
            })
        );
    });
});

function readProcessEnv(): RallarAiLiveEvaluationEnvironment {
    const maybeProcess = globalThis as unknown as {
        process?: { env?: Record<string, string | undefined>; };
    };
    return maybeProcess.process?.env ?? {};
}
