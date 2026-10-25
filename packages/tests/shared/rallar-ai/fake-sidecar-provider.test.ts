import { createRallarAiFakeSidecarProvider } from '@shared/rallar-ai/mod.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { GAME_EVENT_SCHEMA_FIXTURE } from './game-event-schema-fixture.ts';

describe('RallarAI fake sidecar provider', () => {
    it('uses the fake sidecar provider without a real model', async () => {
        const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toMatchObject({
                schemaId: 'game-event',
                prompt: 'Generate a spawn.'
            });
            return new Response(JSON.stringify({ kind: 'spawn', amount: 1 }), {
                status: 200
            });
        };
        const provider = createRallarAiFakeSidecarProvider({
            baseUrl: 'http://127.0.0.1:11434',
            fetch
        });

        const result = await provider.generateJson({
            schemaId: 'game-event',
            schemaVersion: '1',
            schema: GAME_EVENT_SCHEMA_FIXTURE,
            prompt: 'Generate a spawn.'
        });

        expect(result).toMatchObject({
            source: 'server',
            providerId: 'fake-sidecar-http',
            value: { kind: 'spawn', amount: 1 },
            validation: { ok: true }
        });
    });
});
