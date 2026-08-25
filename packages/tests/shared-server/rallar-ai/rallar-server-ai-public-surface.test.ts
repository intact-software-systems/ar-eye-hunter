import {
    createRallarAiOllamaProvider,
    createRallarServerAi,
    createRallarServerAiResultPersistence,
    createRallarServerAiResultPublisher,
    installRallarServerAiHttpRoute,
    installRallarServerAiWebSocketTopic,
    type RallarServerAi
} from '@shared-server/mod.ts';
import { describe, expect, expectTypeOf, it } from 'vitest';

describe('shared-server Rallar AI public surface', () => {
    it('exports the current generation and side-effect entry owners', () => {
        const entryOwners = [
            createRallarAiOllamaProvider,
            createRallarServerAi,
            createRallarServerAiResultPersistence,
            createRallarServerAiResultPublisher,
            installRallarServerAiHttpRoute,
            installRallarServerAiWebSocketTopic
        ];

        expect(entryOwners.every((entry) => typeof entry === 'function')).toBe(true);
        expectTypeOf<RallarServerAi['generateJson']>().returns.resolves.toHaveProperty(
            'value'
        );
    });
});
