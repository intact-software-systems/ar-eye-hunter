import {
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    toPublicRelicSnapshot,
    toRelicRoomGroupRef,
    type RelicCommand
} from '@relic-hunters/mod.ts';
import type { RelicGameMutationService } from '@relic-hunters/server/relic-game-mutation-service.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { installRelicHunterGame, type RelicHunterServer } from '../src/relic-game-service.ts';

const SESSION = { sessionId: 'alice-session', clientId: 'alice', username: 'Alice', issuedAtEpochMs: 1_000 };
const REF = toRelicRoomGroupRef('room-1');
const JOIN: RelicCommand = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    kind: 'join-expedition',
    gameId: REF.groupId,
    username: 'untrusted name',
    characterId: 'nyra-vale'
};

function createTransportFixture() {
    const commands: RelicGameMutationService.CommandInput[] = [];
    const current = toPublicRelicSnapshot(createRelicGame(REF.groupId, REF.groupId, 2_000));
    const state: {
        topic: Parameters<RelicHunterServer['ws']['defineTopic']>[0] | null;
        handler: Parameters<RelicHunterServer['ws']['on']>[1] | null;
    } = { topic: null, handler: null };
    const rallar: RelicHunterServer = {
        ws: {
            serverPeerId: 'default-qbox-server',
            defineTopic: (definition) => {
                state.topic = definition;
            },
            on: (_selector, handler) => {
                state.handler = handler;
            }
        }
    };
    const options: Parameters<typeof installRelicHunterGame>[1] = {
        mode: 'authenticated',
        createInitialState: async (gameId) => createRelicGame(gameId, gameId, 1_000),
        readSession: async (sessionId) => sessionId === SESSION.sessionId ? SESSION : undefined,
        inbox: {
            execute: async (command) => {
                commands.push(command);
                return { status: command.operation === 'ensure' ? 'initialized' : 'applied', gameId: command.gameId };
            },
            enqueue: async (command) => {
                commands.push(command);
                return {
                    key: { topicId: 'RELIC_GAME_MUTATE', contextId: command.gameId, resourceId: command.requestId },
                    enqueue: { type: 'RELIC_GAME_MUTATE', contextId: command.gameId, data: null },
                    winner: true
                };
            }
        },
        mutations: { readCurrentSnapshot: async () => current }
    };
    return { state, rallar, options, commands, current };
}

describe('Relic transport admission', () => {
    it('returns a fresh save after each durable initialization acknowledgement using each HTTP read identity', async () => {
        const fixture = createTransportFixture();
        const service = installRelicHunterGame(fixture.rallar, fixture.options);
        const first = await service.ensureSnapshot(REF.groupId, SESSION, 'read-first');
        const second = await service.ensureSnapshot(REF.groupId, SESSION, 'read-second');
        expect(first).toBe(fixture.current);
        expect(second.createdAtEpochMs).toBe(2_000);
        expect(fixture.commands[0]).toMatchObject({
            operation: 'ensure',
            actor: {
                clientId: SESSION.clientId,
                sessionId: SESSION.sessionId,
                issuedAtEpochMs: SESSION.issuedAtEpochMs
            }
        });
        expect(fixture.commands.map((command) => command.requestId)).toEqual(['read-first', 'read-second']);
    });

    it('keeps REST request identity and issued username for command/reset admission', async () => {
        const fixture = createTransportFixture();
        const service = installRelicHunterGame(fixture.rallar, fixture.options);
        await service.applyCommand(JOIN, SESSION, 'rest-command-1');
        await service.reset(REF.groupId, SESSION, 'rest-reset-1');
        expect(fixture.commands.map((command) => command.requestId)).toEqual(['rest-command-1', 'rest-reset-1']);
        expect(fixture.commands[0]).toMatchObject({ operation: 'command', authorization: 'authenticated', move: { username: SESSION.username } });
    });

    it('admits the WS message ID under its issued sender and rejects another room scope or absent session', async () => {
        const fixture = createTransportFixture();
        installRelicHunterGame(fixture.rallar, fixture.options);
        expect(fixture.state.topic).toMatchObject({ topicId: RELIC_TOPICS.command, typeId: RELIC_TYPES.command, scope: 'room', fanout: 'none' });
        const raw = newALBroadcastMessage(SESSION.sessionId, newALRoute(RELIC_TOPICS.command, REF.groupId, 'move'), 'room', RELIC_TYPES.command, JOIN, {
            groupRef: REF
        });
        if (fixture.state.handler === null) {
            throw new Error('Expected the installed command handler');
        }
        const message = { payload: JOIN, raw, receivedAtEpochMs: 3_000 };
        await fixture.state.handler(message, { senderId: SESSION.sessionId, roomId: REF.groupId, roomRef: REF });
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.commands[0]).toMatchObject({ requestId: raw.id.msgId, authorization: 'group-policy', move: { username: SESSION.username } });
        await fixture.state.handler(message, { senderId: SESSION.sessionId, roomId: REF.groupId, roomRef: { ...REF, workspaceId: 'other' } });
        await fixture.state.handler(message, { senderId: 'unknown-session', roomId: REF.groupId, roomRef: REF });
        expect(fixture.commands).toHaveLength(1);
    });

    it('refuses adoption after a durable acknowledgement if the current room is unavailable', async () => {
        const fixture = createTransportFixture();
        const service = installRelicHunterGame(fixture.rallar, {
            ...fixture.options,
            mutations: {
                readCurrentSnapshot: async () => {
                    throw new Error('room unavailable');
                }
            }
        });
        await expect(service.ensureSnapshot(REF.groupId, SESSION, 'unavailable-read')).rejects.toThrow('room unavailable');
    });
});
