import {
    createRallarAiMockProvider
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';
import { GAME_EVENT_SCHEMA_FIXTURE } from './game-event-schema-fixture.ts';

describe('RallarAI mock provider', () => {
    it('creates deterministic mock provider envelopes', async () => {
        const provider = createRallarAiMockProvider({
            value: { kind: 'reward', amount: 3 },
            createdAtEpochMs: 1_000
        });

        const result = await provider.generateJson({
            requestId: 'request-1',
            schemaId: 'game-event',
            schemaVersion: '1',
            schema: GAME_EVENT_SCHEMA_FIXTURE,
            prompt: 'Generate a reward.',
            dedupeKey: 'turn-1'
        });

        expect(result).toMatchObject({
            protocolVersion: 1,
            requestId: 'request-1',
            generationId: 'mock:request-1',
            dedupeKey: 'turn-1',
            source: 'mock',
            providerId: 'mock',
            validation: { ok: true },
            lifecycle: 'draft'
        });
        expect(result.schemaHash).toMatch(/^rallar-ai-fnv1a32:/);
        expect(result.promptHash).toMatch(/^rallar-ai-fnv1a32:/);
    });
});
