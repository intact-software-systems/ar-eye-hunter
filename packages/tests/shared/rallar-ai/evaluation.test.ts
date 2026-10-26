import {
    createRallarAiMockProvider,
    runRallarAiEvaluationSuite
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';
import { GAME_EVENT_SCHEMA_FIXTURE } from './game-event-schema-fixture.ts';

describe('RallarAI evaluation', () => {
    it('runs deterministic mock-provider evaluations without live AI', async () => {
        const provider = createRallarAiMockProvider({
            value: { kind: 'spawn', amount: 1 }
        });

        const report = await runRallarAiEvaluationSuite({
            suiteId: 'game-event-smoke',
            provider,
            cases: [
                {
                    caseId: 'spawn-event',
                    request: {
                        schemaId: 'game-event',
                        schemaVersion: '1',
                        schema: GAME_EVENT_SCHEMA_FIXTURE,
                        prompt: 'Generate a spawn.'
                    },
                    expectedValue: { amount: 1, kind: 'spawn' },
                    validateResult: (result) =>
                        result.promptHash.startsWith('rallar-ai-fnv1a32:')
                            ? []
                            : ['missing prompt hash']
                }
            ]
        });

        expect(report).toMatchObject({
            suiteId: 'game-event-smoke',
            providerId: 'mock',
            passed: 1,
            failed: 0,
            results: [
                expect.objectContaining({
                    providerId: 'mock',
                    validationOk: true
                })
            ]
        });
    });
});
