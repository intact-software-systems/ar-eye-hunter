import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createRelicGame,
    isRelicHunterEvent,
    isRelicSnapshot,
    RELIC_PROTOCOL_VERSION,
    type RelicCommand
} from '@relic-hunters/mod.ts';
import { createDefaultPSqlALOutboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { WsOutboxProvenanceReader } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALOutboundAdmissionNamespace } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { toALOutboundOrderingMessageKey } from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createAppInboxTestResilience } from '../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createTestAuthSession } from '../shared-server/rallar-system/group-state/group-state-test-runtime.ts';
import { replayALOrderingObservation } from '../shared-web/al-runtime/al-ordering-frame-replay-test-support.ts';
import { TestWebSocket } from '../shared/websocket/test-web-socket.ts';
import { connectGameSession } from './relic-game-database-fixture.ts';
import { createInboxFixture } from './relic-game-inbox-fixture.ts';

describe('Relic committed notifications', () => {
    it('delivers round ordering metadata and private hunter events with durable repair evidence', async () => {
        const admissionNamespace = toALOutboundAdmissionNamespace('relic-publication-test');
        const fixture = await createInboxFixture({ wsOutboundAdmissionNamespace: admissionNamespace });
        const engine = new InboxOutboxEngine();
        const sockets = new JsonWebSocketServer();
        const owner = fixture.owner;
        const guest = createTestAuthSession('guest');
        // Connected to the game after `round-started` and before `round-resolved`: in the second's audience alone.
        const joiner = createTestAuthSession('joiner');
        const peers = new Map([owner, guest].map((session) => [session.sessionId, openSocket(sockets, session.sessionId)]));
        const joinerSocket = openSocket(sockets, joiner.sessionId);
        const principalIds = new Map([owner, guest, joiner].map((session) => [session.sessionId, session.clientId]));
        const stores = createDefaultPSqlALOutboundRuntimeStores({
            repository: fixture.runtime,
            namespace: 'relic-publication-test',
            decodePrepared: decodeWsQueueBoxServerPreparedMessage
        });
        expect(stores.admissionStore.namespace).toBe(admissionNamespace);
        const provenance = new WsOutboxProvenanceReader({ repository: fixture.runtime, nowMs: Date.now, readPrincipalSessionIds: async () => [] });
        const transport = createDefaultWsQueueBoxServerService({
            inboundVolatileStores: undefined,
            name: 'default-qbox-server',
            socket: sockets,
            outbox: stores.workQueue,
            outboundStores: stores,
            queueEngine: engine,
            readProducerProvenance: (message, entry) => provenance.readProducerProvenance(message, entry),
            readAuthenticatedConnectionScope: (connection) => ({
                scope: fixture.ref,
                principalId: principalIds.get(connection.id) ?? owner.clientId,
                expiresAtEpochMs: Date.now() + 60_000
            })
        });
        try {
            await connectGameSession(fixture, owner);
            await connectGameSession(fixture, guest);
            const initial = { ...createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs), maxRounds: 2 };
            const ensure = await fixture.inbox.enqueue(fixture.command, async () => initial);
            await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.inbox.wait(ensure)).status).toBe('initialized');
            const moves: readonly [typeof owner, RelicCommand][] = [
                [owner, move('join-expedition')],
                [guest, move('join-expedition')],
                [owner, move('start-expedition')],
                [owner, move('submit-action')],
                [guest, move('submit-action')],
                [owner, move('continue-review')],
                [owner, move('submit-action')],
                [guest, move('submit-action')],
                [owner, move('continue-review')]
            ];
            for (const [session, command] of moves) {
                fixture.nowEpochMs += 1;
                const queued = await fixture.inbox.enqueue({
                    ...fixture.command,
                    operation: 'command',
                    requestId: `move-${fixture.nowEpochMs}`,
                    move: command,
                    actor: { clientId: session.clientId, sessionId: session.sessionId, issuedAtEpochMs: session.issuedAtEpochMs }
                }, async () => initial);
                await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                expect(await fixture.inbox.wait(queued)).toEqual({ status: 'applied', gameId: fixture.ref.groupId });
                if (command.kind === 'start-expedition') {
                    await connectGameSession(fixture, joiner);
                }
            }
            const rows = await fixture.storage.sql<ResourceInboxRow[]>`select * from resource_inbox where ri_type_id = 'WS_OUTBOX'`;
            const entries = rows.map(toDomain);
            const messages = entries.map((entry) => decodePersistedALMessage(entry.resource));
            const transitions = messages.filter((message) => message.payload.typeId === 'relic.event.v1')
                .sort((left, right) => left.id.ts - right.id.ts);
            expect(transitions.map((message) => [JSON.parse(message.payload.resource).transition, message.ordering?.epoch, message.ordering?.seq]))
                .toEqual([['round-started', 1, 1], ['round-resolved', 1, 2], ['review-continued', 2, 1], ['round-resolved', 2, 2], ['finished', 3, 1]]);
            // Each transition's index row is written by its producer's transaction, before any dequeue sends it.
            for (const transition of transitions) {
                const track = toALOrderingTrackKey(transition);
                const sequence = transition.ordering?.seq;
                const outbox = entries.find((entry) => entry.key.resourceId === transition.id.msgId);
                if (track === undefined || sequence === undefined || outbox === undefined) {
                    throw new Error('Round transitions require an ordering track and an outbox row');
                }
                const indexed = await fixture.runtime.findEntry(
                    admissionNamespace,
                    toALOutboundOrderingMessageKey(admissionNamespace, track, sequence)
                );
                expect(indexed?.value).toBe(JSON.stringify(transition.id.msgId));
                expect(indexed?.expireAtTimestamp).toBe(outbox.audit.expiryTs.epochMilliseconds);
                expect(await stores.admissionStore.readSentMessageByOrdering(track, sequence)).toBeUndefined();
            }
            // A same-principal socket arriving after commit is not part of the private event's fixed audience.
            const lateSocket = new TestWebSocket('ws://late-owner-session');
            lateSocket.open();
            sockets.addConnection(new ConnectionContext({ id: 'late-owner-session', socket: lateSocket }));
            expect(peers.get(owner.sessionId)?.sent).toEqual([]);
            await engine.executeOnce();
            await expect.poll(async () => {
                await engine.executeOnce();
                return (await stores.admissionStore.readSentMessage(transitions[0].id.msgId))?.msg.id.msgId;
            }, { timeout: 5_000 })
                .toBe(transitions[0].id.msgId);
            for (const transition of transitions) {
                const track = toALOrderingTrackKey(transition);
                const sequence = transition.ordering?.seq;
                if (track === undefined || sequence === undefined) {
                    throw new Error('Round transitions require an ordering track');
                }
                await expect.poll(async () => {
                    await engine.executeOnce();
                    return (await stores.admissionStore.readSentMessageByOrdering(track, sequence))?.msg.id.msgId;
                }, { timeout: 5_000 })
                    .toBe(transition.id.msgId);
                expect(await stores.admissionStore.readPendingAck({ originPeerId: 'default-qbox-server', msgId: transition.id.msgId }))
                    .toBeDefined();
            }
            for (const [sessionId, socket] of peers) {
                // Raw WebSocket delivery is at least once; ordered application is a receiver responsibility.
                await expect.poll(async () => {
                    await engine.executeOnce();
                    const received = socket.sent.map((frame) => decodePersistedALMessage(frame));
                    const transitionIds = received.filter((message) => message.payload.typeId === 'relic.event.v1')
                        .map((message) => message.id.msgId);
                    const privateEventIds = received.filter((message) => message.payload.typeId === 'relic.hunter.v1')
                        .map((message) => message.id.msgId);
                    return {
                        transitionIds: [...new Set(transitionIds)].sort(),
                        privateEventCount: new Set(privateEventIds).size
                    };
                }, { timeout: 5_000 }).toEqual({
                    transitionIds: transitions.map((message) => message.id.msgId).sort(),
                    privateEventCount: 2
                });
                const frames = socket.sent.map((frame) => decodePersistedALMessage(frame));
                const delivered = [...new Map(frames.map((message) => [message.id.msgId, message])).values()];
                for (const transition of delivered.filter((message) => message.payload.typeId === 'relic.event.v1')) {
                    const committed = transitions.find((message) => message.id.msgId === transition.id.msgId);
                    expect(transition.payload).toEqual(committed?.payload);
                }
                // A member present from each track's first sequence enters nowhere and skips nothing.
                for (const transition of frames.filter((message) => message.payload.typeId === 'relic.event.v1')) {
                    const committed = transitions.find((message) => message.id.msgId === transition.id.msgId);
                    expect(transition.ordering).toEqual({ ...committed?.ordering, priorSeqByRecipient: {} });
                }
                const snapshots = delivered.filter((message) => message.payload.typeId === 'relic.snapshot.v1');
                expect(snapshots.length).toBeGreaterThan(0);
                for (const message of snapshots) {
                    const payload = JSON.parse(message.payload.resource);
                    expect(message.route.topicId).toBe('room.relic.snapshot');
                    expect(payload.gameId).toBe(fixture.ref.groupId);
                    expect(isRelicSnapshot(payload.snapshot)).toBe(true);
                }
                const privateEvents = delivered.filter((message) => message.payload.typeId === 'relic.hunter.v1')
                    .map((message) => JSON.parse(message.payload.resource));
                expect(lateSocket.sent).toEqual([]);
                expect(privateEvents).toHaveLength(2);
                expect(privateEvents.every(isRelicHunterEvent)).toBe(true);
                expect(privateEvents.every((event) => event.playerId === sessionId && event.kind === 'action-recorded')).toBe(true);
                // Every transition was committed before any dequeue: each track's rows still arrive in sequence order.
                expect(toTrackSequences(delivered)).toEqual({ '1': [1, 2], '2': [1, 2], '3': [1] });
            }
            const readJoinerTransitionFrames = () => joinerSocket.sent.filter((frame) => decodePersistedALMessage(frame).payload.typeId === 'relic.event.v1');
            await expect.poll(async () => {
                await engine.executeOnce();
                return [...new Set(readJoinerTransitionFrames().map((frame) => decodePersistedALMessage(frame).id.msgId))].sort();
            }, { timeout: 5_000 }).toEqual(transitions.slice(1).map((message) => message.id.msgId).sort());
            const joinerTransitionFrames = readJoinerTransitionFrames();
            const joinerTransitions = joinerTransitionFrames.map((frame) => decodePersistedALMessage(frame));
            expect(joinerTransitions[0]?.id.msgId).toBe(transitions[1].id.msgId);
            expect(joinerTransitions[0]?.ordering).toEqual({
                ...transitions[1].ordering,
                epoch: 1,
                seq: 2,
                priorSeqByRecipient: { [joiner.sessionId]: 0 }
            });
            expect(joinerTransitions.map((message) => message.id.msgId)).not.toContain(transitions[0].id.msgId);
            expect(toTrackSequences([...new Map(joinerTransitions.map((message) => [message.id.msgId, message])).values()]))
                .toEqual({ '1': [2], '2': [1, 2], '3': [1] });
            // The joiner enters the round's track at sequence 2 with no range missing below it: no resync.
            const replay = replayALOrderingObservation(joinerTransitionFrames, joiner.sessionId);
            expect(replay.statuses[0]).toBe('entered');
            expect(replay.missingRanges).toEqual([]);
        }
        finally {
            await transport.dispose();
            await engine.stop();
            await fixture.storage.close();
        }
    }, 30_000);
});

/**
 * Each round track's transition sequences, by epoch, in the order their first frames arrived; the order across tracks
 * is not pinned, since the track wait orders a track's rows only.
 */
function toTrackSequences(messages: readonly ALMessage[]): Readonly<Record<string, readonly (number | undefined)[]>> {
    const byEpoch: Record<string, (number | undefined)[]> = {};
    for (const message of messages.filter((candidate) => candidate.payload.typeId === 'relic.event.v1')) {
        const epoch = String(message.ordering?.epoch);
        byEpoch[epoch] = [...(byEpoch[epoch] ?? []), message.ordering?.seq];
    }
    return byEpoch;
}

function openSocket(sockets: JsonWebSocketServer, sessionId: string): TestWebSocket {
    const socket = new TestWebSocket(`ws://${sessionId}`);
    socket.open();
    sockets.addConnection(new ConnectionContext({ id: sessionId, socket }));
    return socket;
}

function move(kind: 'join-expedition' | 'start-expedition' | 'continue-review' | 'submit-action'): RelicCommand {
    const base = { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: 'expedition-1', username: 'ignored-issued-name' };
    return kind === 'submit-action' ? { ...base, kind, action: { kind: 'search' } } : { ...base, kind };
}
