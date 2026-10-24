import {
    applyRelicCommand,
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    type RelicCommand,
    type RelicExpeditionSetupMetadata
} from '@relic-hunters/mod.ts';
import { decodeRelicGameStateAppData } from '@relic-hunters/server/decode-relic-game-state-app-data.ts';
import { encodeRelicGameStateAppData } from '@relic-hunters/server/encode-relic-game-state-app-data.ts';
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';

import { requireRelicCommandApplied } from '../../../packages/tests/relic-hunters/require-relic-command-applied.ts';

describe('Relic game state storage', () => {
    it('round-trips a joined lobby through JSON without inventing a round start', () => {
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), joinCommand('room-1'), {
            senderId: 'alice-session',
            now: 2
        })).state;
        const encoded = encodeRelicGameStateAppData(game);
        const stored = decodeRelicGameStateAppData(JSON.parse(JSON.stringify(encoded)));
        expect(stored.players.map((player) => player.playerId)).toEqual(['alice-session']);
        expect(stored.phase).toBe('lobby');
        expect(stored.adminPlayerId).toBe('alice-session');
        expect('roundStartedAtEpochMs' in stored).toBe(false);
        expect(stored.createdAtEpochMs).toBe(1);
        expect(stored.updatedAtEpochMs).toBe(2);
    });

    it('round-trips a fresh expedition with no administrator', () => {
        const encoded = encodeRelicGameStateAppData(createRelicGame('room-2', 'room-2', 1));
        const stored = decodeRelicGameStateAppData(JSON.parse(JSON.stringify(encoded)));
        expect(stored).toMatchObject({ gameId: 'room-2', phase: 'lobby', players: [] });
        expect(stored.adminPlayerId).toBeUndefined();
    });

    it('leaves out only undefined plain properties: a non-plain value and a cycle still reach the JSON-safety check', () => {
        const game = createRelicGame('room-3', 'room-3', 1);
        class ProceduralSetup {
            readonly schemaVersion = 1;
            readonly source = 'procedural';
        }
        const cyclicSetup: RelicExpeditionSetupMetadata & { self: object | undefined; } = {
            schemaVersion: 1,
            source: 'procedural',
            self: undefined
        };
        cyclicSetup.self = cyclicSetup;

        expect(() => encodeRelicGameStateAppData({ ...game, setup: new ProceduralSetup() }))
            .toThrow('uses a non-plain object');
        expect(() => encodeRelicGameStateAppData({ ...game, setup: cyclicSetup })).toThrow('contains a cycle');
    });
});

function joinCommand(gameId: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId,
        username: 'Alice',
        characterId: 'nyra-vale'
    };
}
