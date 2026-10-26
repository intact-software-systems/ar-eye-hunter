import {
    createRallarAiSchemaRegistry,
    validateRallarAiJsonSchemaValue
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';
import { GAME_EVENT_SCHEMA_FIXTURE } from './game-event-schema-fixture.ts';

describe('RallarAI schema contracts', () => {
    it('validates the supported JSON schema subset', () => {
        expect(
            validateRallarAiJsonSchemaValue(GAME_EVENT_SCHEMA_FIXTURE, {
                kind: 'spawn',
                amount: 2
            }).ok
        ).toBe(true);

        const invalid = validateRallarAiJsonSchemaValue(GAME_EVENT_SCHEMA_FIXTURE, {
            kind: 'spawn',
            amount: 0,
            extra: true
        });

        expect(invalid.ok).toBe(false);
        expect(invalid.issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining(['minimum', 'additional-property'])
        );
    });

    it('registers schemas with stable hashes and compatibility metadata', () => {
        const registry = createRallarAiSchemaRegistry()
            .register({
                schemaId: 'game-event',
                schemaVersion: '1',
                schema: GAME_EVENT_SCHEMA_FIXTURE
            })
            .register({
                schemaId: 'game-event',
                schemaVersion: '2',
                schema: GAME_EVENT_SCHEMA_FIXTURE,
                compatibleWith: ['1']
            });

        expect(registry.require('game-event', '1').schemaHash).toMatch(
            /^rallar-ai-fnv1a32:/
        );
        expect(registry.isCompatible('game-event', '1', '2')).toBe(true);
        expect(registry.isCompatible('game-event', '2', '1')).toBe(false);
    });
});
