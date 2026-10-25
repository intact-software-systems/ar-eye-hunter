import {
    createRallarAiMockProvider,
    runRallarAiEvaluationSuiteIfEnabled
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';
import { GAME_EVENT_SCHEMA_FIXTURE } from './game-event-schema-fixture.ts';

describe('RallarAI live evaluation gate', () => {
    it('gates optional live evaluation runs behind environment variables', async () => {
        const provider = createRallarAiMockProvider({
            value: { kind: 'spawn', amount: 1 }
        });
        const cases = [
            {
                caseId: 'spawn-event',
                request: {
                    schemaId: 'game-event',
                    schemaVersion: '1',
                    schema: GAME_EVENT_SCHEMA_FIXTURE,
                    prompt: 'Generate a spawn.'
                },
                expectedValue: { kind: 'spawn', amount: 1 }
            }
        ];

        await expect(
            runRallarAiEvaluationSuiteIfEnabled({
                suiteId: 'ollama-live-smoke',
                provider,
                cases,
                env: {},
                gate: 'RALLAR_AI_LIVE_OLLAMA',
                providerLabel: 'Ollama'
            })
        ).resolves.toEqual(
            expect.objectContaining({
                status: 'skipped',
                gate: 'RALLAR_AI_LIVE_OLLAMA'
            })
        );

        await expect(
            runRallarAiEvaluationSuiteIfEnabled({
                suiteId: 'ollama-live-smoke',
                provider,
                cases,
                env: { RALLAR_AI_LIVE_OLLAMA: '1' },
                gate: 'RALLAR_AI_LIVE_OLLAMA',
                providerLabel: 'Ollama'
            })
        ).resolves.toEqual(
            expect.objectContaining({
                status: 'ran',
                report: expect.objectContaining({
                    suiteId: 'ollama-live-smoke',
                    passed: 1,
                    failed: 0
                })
            })
        );
    });
});
