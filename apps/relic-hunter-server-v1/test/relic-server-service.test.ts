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
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';

import { createApiV1TestQueueResilience } from '@api-v1/test/api-v1-test-queue-resilience.ts';
import { withPGliteSql } from '@api-v1/test/db/pglite-auth-test-harness.ts';
import { installRelicHunterGame, type RelicHunterServer } from '../src/relic-game-service.ts';
import {
    createRelicTestStack,
    drainRelicTestInbox,
    readRelicPublicationTraces,
    RELIC_TEST_GAME_ID
} from './relic-game-test-runtime.ts';

const SESSION = { sessionId: 'alice-session', clientId: 'alice', username: 'Alice', issuedAtEpochMs: 1_000 };
const REST_TRACE_ID = 'trace-relic-rest-request';
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
                return { wait: () => Promise.reject(new Error('WS admission must not wait for completion')) };
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
        const first = await service.ensureSnapshot(REF.groupId, { session: SESSION, requestId: 'read-first', traceId: REST_TRACE_ID });
        const second = await service.ensureSnapshot(REF.groupId, { session: SESSION, requestId: 'read-second', traceId: REST_TRACE_ID });
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
        expect(fixture.commands.map((command) => command.traceId)).toEqual([REST_TRACE_ID, REST_TRACE_ID]);
    });

    it('keeps REST request identity and issued username for command/reset admission', async () => {
        const fixture = createTransportFixture();
        const service = installRelicHunterGame(fixture.rallar, fixture.options);
        await service.applyCommand(JOIN, { session: SESSION, requestId: 'rest-command-1', traceId: REST_TRACE_ID });
        await service.reset(REF.groupId, { session: SESSION, requestId: 'rest-reset-1', traceId: REST_TRACE_ID });
        expect(fixture.commands.map((command) => command.requestId)).toEqual(['rest-command-1', 'rest-reset-1']);
        expect(fixture.commands[0]).toMatchObject({ operation: 'command', authorization: 'authenticated', move: { username: SESSION.username } });
    });

    it('admits the WS message ID under its issued sender and rejects another room scope or absent session', async () => {
        const fixture = createTransportFixture();
        installRelicHunterGame(fixture.rallar, fixture.options);
        expect(fixture.state.topic).toMatchObject({ topicId: RELIC_TOPICS.command, typeId: RELIC_TYPES.command, scope: 'room', fanout: 'none' });
        const raw = newALBroadcastMessage(SESSION.sessionId, newALRoute(RELIC_TOPICS.command, REF.groupId, 'move'), 'room', RELIC_TYPES.command, JOIN, {
            groupRef: REF,
            traceId: 'trace-relic-ws-command'
        });
        if (fixture.state.handler === null) {
            throw new Error('Expected the installed command handler');
        }
        const message = { payload: JOIN, raw, receivedAtEpochMs: 3_000 };
        await fixture.state.handler(message, { senderId: SESSION.sessionId, roomId: REF.groupId, roomRef: REF });
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.commands[0]).toMatchObject({
            requestId: raw.id.msgId,
            traceId: raw.id.traceId,
            authorization: 'group-policy',
            move: { username: SESSION.username }
        });
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
        await expect(service.ensureSnapshot(REF.groupId, { session: SESSION, requestId: 'unavailable-read', traceId: REST_TRACE_ID }))
            .rejects.toThrow('room unavailable');
    });
});

Deno.test('a Relic WS command publishes under the trace of the envelope that carried it', async () => {
    await withPGliteSql(async (database) => {
        const stack = await createRelicTestStack(database);
        const ref = toRelicRoomGroupRef(RELIC_TEST_GAME_ID);
        const installed: { handler: Parameters<RelicHunterServer['ws']['on']>[1] | null; } = { handler: null };
        installRelicHunterGame({
            ws: {
                serverPeerId: 'default-qbox-server',
                defineTopic: () => {},
                on: (_selector, handler) => {
                    installed.handler = handler;
                }
            }
        }, {
            mode: 'authenticated',
            inbox: stack.services.relicGameInboxService,
            mutations: stack.services.relicGameMutations,
            createInitialState: async (gameId) => createRelicGame(gameId, gameId, Date.now()),
            readSession: (sessionId) => stack.sessions.findBySessionId(sessionId)
        });
        const join: RelicCommand = { ...JOIN, gameId: ref.groupId };
        const raw = newALBroadcastMessage(stack.owner.sessionId, newALRoute(RELIC_TOPICS.command, ref.groupId, 'move'), 'room', RELIC_TYPES.command, join, {
            groupRef: ref,
            traceId: 'trace-relic-ws-join'
        });
        const handler = installed.handler;
        if (handler === null) {
            throw new Error('Expected the installed command handler');
        }

        await drainRelicTestInbox(
            stack.reader,
            Promise.resolve(handler({ payload: join, raw, receivedAtEpochMs: Date.now() }, {
                senderId: stack.owner.sessionId,
                roomId: ref.groupId,
                roomRef: ref
            }))
        );
        await stack.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());

        const traces = await readRelicPublicationTraces(database);
        expect(traces.length).toBeGreaterThan(0);
        expect(new Set(traces)).toEqual(new Set(['trace-relic-ws-join']));
    });
});
