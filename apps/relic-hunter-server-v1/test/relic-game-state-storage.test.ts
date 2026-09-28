import {
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    type RelicCommand,
    type RelicGameState
} from '@relic-hunters/mod.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { installRelicHunterGame } from '../src/relic-game-service.ts';

type RelicServer = Parameters<typeof installRelicHunterGame>[0];
type CommandHandler = Parameters<RelicServer['ws']['on']>[1];

// A lobby game has no administrator and no round running, which the rules express as undefined fields. The stored
// value must be JSON-safe, as the SQL-backed app-data store encodes it (pre-existing: the codec refused them).
describe('Relic game state storage', () => {
    it('stores a joined lobby game whose round has not started and reads it back', async () => {
        const store = createEncodingStore();
        const handlers: CommandHandler[] = [];
        await installRelicHunterGame(createServer(store, handlers), {
            createInitialState: (gameId) => Promise.resolve(createRelicGame(gameId, gameId, 1)),
            readSessionUsername: () => Promise.resolve('Alice')
        });

        await handlers[0]({ payload: joinCommand('room-1') }, { senderId: 'alice-session' });

        const stored = store.read('room-1');
        expect(stored?.players.map((player) => player.playerId)).toEqual(['alice-session']);
        expect(stored?.phase).toBe('lobby');
        expect(stored !== undefined && 'roundStartedAtEpochMs' in stored).toBe(false);
    });

    it('stores a fresh expedition that has no administrator yet', async () => {
        const store = createEncodingStore();
        const service = await installRelicHunterGame(createServer(store, []), {
            createInitialState: (gameId) => Promise.resolve(createRelicGame(gameId, gameId, 1)),
            readSessionUsername: () => Promise.resolve(undefined)
        });

        await expect(service.ensureSnapshot('room-2')).resolves.toMatchObject({ gameId: 'room-2', phase: 'lobby' });
        expect(store.read('room-2')?.adminPlayerId).toBeUndefined();
    });
});

interface EncodingStore {
    readonly codec: { encode?: (value: RelicGameState) => JsonWireValue; decode?: (value: JsonWireValue) => RelicGameState; };
    read(key: string): RelicGameState | undefined;
}

function createEncodingStore(): EncodingStore & { rows: Map<string, string>; } {
    const rows = new Map<string, string>();
    const codec: EncodingStore['codec'] = {};
    return {
        rows,
        codec,
        read: (key) => {
            const row = rows.get(key);
            return row === undefined || codec.decode === undefined ? undefined : codec.decode(JSON.parse(row));
        }
    };
}

function createServer(
    store: ReturnType<typeof createEncodingStore>,
    handlers: CommandHandler[]
): RelicServer {
    return {
        appData: {
            open: (_name, options) => {
                store.codec.encode = options.codec.encode;
                store.codec.decode = options.codec.decode;
                return Promise.resolve({
                    get: (key: string) => Promise.resolve(store.read(key)),
                    set: (key: string, value: RelicGameState) => {
                        store.rows.set(key, JSON.stringify(options.codec.encode(value)));
                        return Promise.resolve();
                    },
                    setIfAbsent: () => Promise.reject(new Error('Relic does not use setIfAbsent.'))
                });
            }
        },
        ws: {
            serverPeerId: 'relic-server',
            defineTopic: () => {},
            on: (_selector, handler) => {
                handlers.push(handler);
            },
            publish: () => Promise.resolve()
        }
    };
}

function joinCommand(gameId: string): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId,
        username: 'Alice',
        characterId: 'nyra-vale'
    };
}
