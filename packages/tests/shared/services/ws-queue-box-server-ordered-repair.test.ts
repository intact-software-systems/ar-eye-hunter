import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest';

import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, newALNackControlMessage, type ALNackReason } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey, type ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { toALOutboundOrderingMessageKey } from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import type { ALOutboundRuntimeDiagnosticsEvent, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsCapturedRecipientEligibilityFilter } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { WsOutboxProducerAuthority } from '@shared/services/ws-queue-box-server/ws-queue-box-server-dequeue-authority.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const SERVER_ID = 'server';
const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'room-1' };
const EVENT_TTL_MS = 60_000;
/** The `at-least-once` receipt window: past it, a receipt still pending retries its unconfirmed peers. */
const ACK_TIMEOUT_MS = 2_000;
const CLOCK_STEP_MS = 250;
const ORDERING = { orderingKey: 'game-1', epoch: 1 };
const TRACK_KEY = 'game-1:server:1';
/** Client `a`'s track on the same key, which the server relays. */
const A_TRACK_KEY = 'game-1:a:1';
/** `a` and `b` were in the room when the events were published; `c` joined afterwards. */
const ADMITTED_AUDIENCE = ['a', 'b'];
/**
 * A ranged retransmit's attempt id names its gap: the requester, the track (still encoded once the send id is decoded)
 * and the sequence.
 */
const REPAIR_GAP_ATTEMPT = /:repair-gap:([^:]+):[^:]+:([0-9]+):/;

type ControlAdmission = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'control-admission'; }>;
type TrackIndexEnd = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'track-index-end'; }>;

interface OrderedServer {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<string, SimulatedWebSocket>>;
    readonly clock: { nowMs: number; };
    readonly controlAdmissions: ControlAdmission[];
    readonly trackIndexEnds: TrackIndexEnd[];
    readonly settlements: ALDeliverySettlement[];
    /** The member count of each dequeue group that committed under one fence. */
    readonly groupCommits: number[];
    /** The rows each dequeue handed on after its admission, in the order it handed them. */
    readonly orderedDispatches: string[];
    readonly outbox: InMemoryQueueBox;
    readonly outboundBackend: InMemoryAdmissionBackend;
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    /**
     * The authority each producer-written row's provenance proves, by message id; `'corrupt'` cannot be read, and
     * `'non-retryable'` fails its dequeue for good.
     */
    readonly producerRows: Map<string, WsOutboxProducerAuthority | 'corrupt' | 'non-retryable'>;
}

interface ProducerRowOptions {
    /** Leaves the row's provenance unreadable (`corrupt`), or fails its dequeue for good (`non-retryable`). */
    readonly provenanceFailure?: 'corrupt' | 'non-retryable';
}

interface OrderedServerOptions {
    /** Registers a cluster publisher, as every default api-v1 composition does. */
    readonly cluster?: boolean;
    /** Re-checks every frozen audience, and cannot read the one of this message the first time, so its row retries. */
    readonly unreadableOnceMsgId?: string;
    /**
     * Re-checks every frozen audience, and holds the re-check of this message's audience until released, so the claim
     * that reads it stays running.
     */
    readonly recheckGate?: Readonly<{ msgId: string; released: Promise<void>; }>;
}

interface NackInput {
    readonly fromPeerId: string;
    readonly msgId: string;
    readonly reason: ALNackReason;
    readonly missingRanges: readonly ALSeqRange[];
    /** The origin of the track the NACK names; the server unless named. */
    readonly toPeerId?: string;
    readonly trackKey?: string;
}

describe('the WS server repairs its own ordered publication', () => {
    it('sequences its keyed publications 1, 2, 3 for the audience it admitted them to', async () => {
        const server = await createOrderedServer();

        const minted = await publishEvents(server, 3);

        expect(minted).toEqual([1, 2, 3].map((seq) => ({ ...ORDERING, seq })));
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3]);
        expect(readSeqs(server.sockets.b)).toEqual([1, 2, 3]);
        expect(readSeqs(server.sockets.c)).toEqual([]);
    });

    it('admits a gap NACK from a peer the receipt expects and retransmits the missing sequence to that requester alone', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 3);

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }] });

        await expect.poll(() => runEngine(server, () => readSeqs(server.sockets.b))).toEqual([1, 2, 3, 2]);
        await settle(server);
        expect(server.controlAdmissions).toEqual([
            expect.objectContaining({ targetMsgId: 'event-3', outcome: 'committed', reason: 'none' })
        ]);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3]);
        expect(readSeqs(server.sockets.c)).toEqual([]);
    });

    it('serves a gap wider than one repair page in two ascending pages, to the requester alone', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 35);
        for (let index = 1; index <= 35; index += 1) {
            await receiveAck(server, `event-${index}`, 'a');
        }

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-35', reason: 'gap', missingRanges: [{ from: 1, to: 34 }] });

        // The readiness probe and the claim read `AL_OUTBOUND_WORK_PAGE_SIZE` (16) rows per status in key order. The
        // thirty-five receipts still waiting on `b` sit ahead of the repair rows, and a page of receipts not yet due
        // hides every row behind it, so the clock moves in the poll: each step lets a page of receipts fall due past
        // its ACK timeout, and more than one pass goes through them before the repair rows are reached.
        await expect.poll(async () => {
            server.clock.nowMs += CLOCK_STEP_MS;
            return await runEngine(server, () => readServedRepairSeqs(server, 'b').length);
        }, { timeout: 5_000 }).toBe(34);
        expect(readServedRepairSeqs(server, 'b')).toEqual(toSeqs(1, 34));
        expect(readSeqs(server.sockets.b).slice(35, 35 + 34)).toEqual(toSeqs(1, 34));
        expect(readSeqs(server.sockets.a)).toEqual(toSeqs(1, 35));
    });

    it('serves the second requester of a spent sequence from the receipt retry, not from ranged repair', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 3, ['a', 'b', 'c']);
        for (const msgId of ['event-1', 'event-2', 'event-3']) {
            await receiveAck(server, msgId, 'a');
        }
        await receiveAck(server, 'event-1', 'b');
        await receiveAck(server, 'event-1', 'c');

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }] });
        await expect.poll(() => runEngine(server, () => readSeqs(server.sockets.b))).toEqual([1, 2, 3, 2]);
        await receiveAck(server, 'event-2', 'b');
        await receiveAck(server, 'event-3', 'b');
        await receiveNack(server, { fromPeerId: 'c', msgId: 'event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }] });

        await expect.poll(() => runEngine(server, () => readRepairExhaustedMsgIds(server))).toEqual(['event-2']);
        await receiveAck(server, 'event-3', 'c');
        await settle(server);
        expect(readSeqs(server.sockets.c)).toEqual([1, 2, 3]);

        server.clock.nowMs += ACK_TIMEOUT_MS + CLOCK_STEP_MS;
        await expect.poll(() => runEngine(server, () => readMsgIds(server.sockets.c))).toEqual([
            'event-1',
            'event-2',
            'event-3',
            'event-2'
        ]);
        await settle(server);
        expect(readSeqs(server.sockets.c)).toEqual([1, 2, 3, 2]);
        expect(readSeqs(server.sockets.b)).toEqual([1, 2, 3, 2]);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3]);
        expect(readRepairExhaustedMsgIds(server)).toEqual(['event-2']);
        expect(readServedRepairSeqs(server, 'b')).toEqual([2]);
        expect(readServedRepairSeqs(server, 'c')).toEqual([]);
    });

    it('retransmits nothing for a gap NACK that arrives after the message deadline', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 3);
        server.clock.nowMs += EVENT_TTL_MS;

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }] });

        await expect.poll(() => runEngine(server, () => server.controlAdmissions)).toEqual([
            expect.objectContaining({ targetMsgId: 'event-3', outcome: 'not-handled' })
        ]);
        await settle(server);
        expect(readSeqs(server.sockets.b)).toEqual([1, 2, 3]);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3]);
    });

    it('resends an unconfirmed copy on the receipt retry with the entry its first dequeue fixed', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 2);
        await publishEvent(server, roundEvent('event-3'), ['a']);
        await publishEvent(server, roundEvent('event-4'), ['a', 'b']);
        for (const msgId of ['event-1', 'event-2', 'event-3', 'event-4']) {
            await receiveAck(server, msgId, 'a');
        }
        await receiveAck(server, 'event-1', 'b');
        await receiveAck(server, 'event-2', 'b');

        server.clock.nowMs += ACK_TIMEOUT_MS + CLOCK_STEP_MS;

        // `b` already stands at 4 when the retry runs; the retry reads the positions the first dequeue fixed, not the row.
        await expect.poll(() => runEngine(server, () => readFrames(server.sockets.b, 'event-4').length)).toBe(2);
        expect(readFrames(server.sockets.b, 'event-4')).toEqual([
            { ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: { b: 2 } }, proof: undefined },
            { ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: { b: 2 } }, proof: undefined }
        ]);
    });

    it('serves the gap NACK a session of the admitted audience sends the origin of a relayed track, and refuses one outside it', async () => {
        const server = await createOrderedServer();
        for (const seq of [1, 2, 3]) {
            await publishEvent(server, browserEvent(seq), ['b']);
        }
        const gap = { msgId: 'a-event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }], toPeerId: 'a', trackKey: A_TRACK_KEY } as const;

        const served = await server.service.acceptIncomingMessage(toNack(server, { ...gap, fromPeerId: 'b' }), 'b');
        const refused = await server.service.acceptIncomingMessage(toNack(server, { ...gap, fromPeerId: 'c' }), 'c');

        expect(served.left).toBeUndefined();
        expect(refused.left).toEqual({ code: 'unauthorized', message: 'AL repair request names no relayed message admitted to its sender' });
        await expect.poll(() => runEngine(server, () => readMsgIds(server.sockets.b))).toEqual(['a-event-1', 'a-event-2', 'a-event-3', 'a-event-2']);
        await settle(server);
        expect(readMsgIds(server.sockets.c)).toEqual([]);
    });

    it('serves a ranged repair of a keyed publication no receipt tracks to a requester of its audience, and refuses one outside', async () => {
        const server = await createOrderedServer();
        for (const seq of [1, 2, 3]) {
            await publishEvent(server, roundEvent(`event-${seq}`, 'none'), ADMITTED_AUDIENCE);
        }
        const gap = { msgId: 'event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }] } as const;

        await receiveNack(server, { ...gap, fromPeerId: 'c' });
        await receiveNack(server, { ...gap, fromPeerId: 'b' });

        await expect.poll(() => runEngine(server, () => readSeqs(server.sockets.b))).toEqual([1, 2, 3, 2]);
        await settle(server);
        expect(server.controlAdmissions.map(({ msgId, outcome }) => [msgId, outcome])).toEqual([
            ['nack-event-3-c', 'not-handled'],
            ['nack-event-3-b', 'committed']
        ]);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3]);
        expect(readSeqs(server.sockets.c)).toEqual([]);
    });

    it('ends the whole receipt of a message one receiver NACKs resync-required, so no recipient is retried', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 3);

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-3', reason: 'resync-required', missingRanges: [] });
        await expect.poll(() => runEngine(server, () => server.settlements)).toContainEqual(expect.objectContaining({
            kind: 'relay-rejected',
            msgId: 'event-3',
            relayRejection: { relay: 'peer', peerId: 'b', reason: 'resync-required' }
        }));
        server.clock.nowMs += ACK_TIMEOUT_MS;

        await expect.poll(() => runEngine(server, () => readSeqs(server.sockets.a))).toEqual([1, 2, 3, 1, 2]);
        await settle(server);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3, 1, 2]);
        expect(readSeqs(server.sockets.b)).toEqual([1, 2, 3, 1, 2]);
        expect(server.settlements).not.toContainEqual(expect.objectContaining({ kind: 'receipt-exhausted', msgId: 'event-3' }));
    });
});

describe.each([
    { cluster: false, path: 'its own send of each dequeued row' },
    { cluster: true, path: 'the live send of each row it publishes to its cluster' }
])('every copy the WS server sends through $path', ({ cluster }) => {
    it('sends a session admitted from event 4 that event with its own entry and nothing below it', async () => {
        const server = await createOrderedServer({ cluster });
        await publishEvents(server, 3);

        await publishEvent(server, roundEvent('event-4'), ['a', 'b', 'c']);
        await settle(server);

        expect(readFrames(server.sockets.c, 'event-4')).toEqual([{ ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: { c: 0 } }, proof: undefined }]);
        expect(readMsgIds(server.sockets.c)).toEqual(['event-4']);
        expect(readFrames(server.sockets.b, 'event-4')).toEqual([{ ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3, 4]);
    });

    it('skips a recipient a later row of its track already reached, and never moves it back', async () => {
        const server = await createOrderedServer({ cluster });
        await publishEvent(server, browserEvent(2), ['b']);

        await publishEvent(server, browserEvent(1), ['b', 'c'], ['c']);
        await settle(server);

        expect(readFrames(server.sockets.b, 'a-event-1')).toEqual([]);
        expect(readFrames(server.sockets.c, 'a-event-1')).toEqual([{ ordering: { ...ORDERING, seq: 1, priorSeqByRecipient: {} }, proof: undefined }]);

        await publishEvent(server, browserEvent(3), ['b', 'c']);

        expect(readFrames(server.sockets.b, 'a-event-3')).toEqual([{ ordering: { ...ORDERING, seq: 3, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readFrames(server.sockets.c, 'a-event-3')).toEqual([{ ordering: { ...ORDERING, seq: 3, priorSeqByRecipient: { c: 1 } }, proof: undefined }]);
    });

    it('sends a handed-over signed frame with the server own entry for each recipient and no proof', async () => {
        const server = await createOrderedServer({ cluster });
        const event = browserEvent(2);
        const handedOver: ALMessage = {
            ...event,
            targets: { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['b', 'c'], snapshotVersion: 1 },
            ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: { c: 0 } },
            proof: { alg: 'ES256', keyId: 'K'.repeat(42) + 'A', signature: 'S'.repeat(85) + 'A' }
        };

        await publishEvent(server, handedOver, ['b', 'c']);

        expect(readFrames(server.sockets.b, 'a-event-2')).toEqual([{ ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: { b: 0 } }, proof: undefined }]);
        expect(readFrames(server.sockets.c, 'a-event-2')).toEqual([{ ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: { c: 0 } }, proof: undefined }]);
    });

    it('holds a row claimed without its track\'s earlier row, admitted first but dequeued later, until it records; both deliver in order', async () => {
        const first = browserEvent(1);
        const second = browserEvent(2);
        const server = await createOrderedServer({ cluster, unreadableOnceMsgId: first.id.msgId });
        // Sequence 1's first dequeue cannot read its audience and retries; sequence 2 is admitted and claimed meanwhile.
        await server.service.enqueueOutboxIfAbsent(first, toAudienceAuthority(['b']));
        await runEngine(server, () => undefined);
        await server.service.enqueueOutboxIfAbsent(second, toAudienceAuthority(['b']));

        await expect.poll(() => runEngineAdvancing(server, () => readMsgIds(server.sockets.b).slice(0, 2)), { timeout: 10_000 })
            .toEqual([first.id.msgId, second.id.msgId]);
        expect(readHeldMsgIds(server)).toEqual([second.id.msgId]);
        expect(readFrames(server.sockets.b, first.id.msgId)[0]).toEqual({ ordering: { ...ORDERING, seq: 1, priorSeqByRecipient: {} }, proof: undefined });
        expect(readFrames(server.sockets.b, second.id.msgId)[0]).toEqual({ ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: {} }, proof: undefined });
    });

    it('leaves a row whose earlier row in the same batch fails its admission to a later pass; both deliver, none skipped', async () => {
        const first = browserEvent(1);
        const second = browserEvent(2);
        const lead = roundEvent('event-1');
        const released = Promise.withResolvers<void>();
        const server = await createOrderedServer({
            cluster,
            unreadableOnceMsgId: first.id.msgId,
            recheckGate: { msgId: lead.id.msgId, released: released.promise }
        });
        // The server's own row holds its claim at its re-check while both rows of `a`'s track commit, so the follow-up
        // claim takes them together, and sequence 1's dequeue there cannot read its audience.
        await server.service.enqueueOutboxIfAbsent(lead, toAudienceAuthority(['c']));
        await server.service.enqueueOutboxIfAbsent(first, toAudienceAuthority(['b']));
        await server.service.enqueueOutboxIfAbsent(second, toAudienceAuthority(['b']));
        released.resolve();

        await expect.poll(() => runEngineAdvancing(server, () => new Set(readMsgIds(server.sockets.b)).size), { timeout: 3_000 }).toBe(2);
        await settle(server);
        expect(readFrames(server.sockets.b, first.id.msgId)).toEqual([{ ordering: { ...ORDERING, seq: 1, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readFrames(server.sockets.b, second.id.msgId)).toEqual([{ ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readHeldMsgIds(server)).toEqual([]);
        expect(server.groupCommits).toEqual([2]);
    });

    it('sends a track\'s rows claimed in one batch against their sequence in sequence order to each recipient', async () => {
        const first = browserEvent(1);
        const second = browserEvent(2);
        const lead = roundEvent('event-1');
        const released = Promise.withResolvers<void>();
        const server = await createOrderedServer({ cluster, recheckGate: { msgId: lead.id.msgId, released: released.promise } });
        // The server's own row holds its claim at its re-check while `a`'s sequence 2 and then its sequence 1 are
        // admitted, so the follow-up claim takes them together in that order.
        await server.service.enqueueOutboxIfAbsent(lead, toAudienceAuthority(['c']));
        await server.service.enqueueOutboxIfAbsent(second, toAudienceAuthority(['b']));
        await server.service.enqueueOutboxIfAbsent(first, toAudienceAuthority(['b']));
        released.resolve();

        await expect.poll(() => runEngineAdvancing(server, () => readMsgIds(server.sockets.b).length), { timeout: 3_000 }).toBe(2);
        await settle(server);
        expect(server.groupCommits).toEqual([2]);
        expect(readHeldMsgIds(server)).toEqual([]);
        expect(readMsgIds(server.sockets.b)).toEqual([first.id.msgId, second.id.msgId]);
        expect(server.orderedDispatches.filter((msgId) => msgId !== lead.id.msgId)).toEqual([first.id.msgId, second.id.msgId]);
        expect(readFrames(server.sockets.b, second.id.msgId)).toEqual([{ ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: {} }, proof: undefined }]);
    });

    it('commits an in-order run of one track claimed in one batch as one chained group, every recipient its entry', async () => {
        const server = await createOrderedServer({ cluster });
        // The first admission's commit starts a claim at once; the other three commit while it runs, and the follow-up
        // claim takes them together, ahead of `b`'s recorded position at sequence 1.
        await Promise.all(
            [['a', 'b'], ['a', 'b'], ['a'], ['a', 'b']].map((audience, index) =>
                server.service.enqueueOutboxIfAbsent(roundEvent(`event-${index + 1}`), toAudienceAuthority(audience))
            )
        );

        await expect.poll(() => runEngine(server, () => readSeqs(server.sockets.a).length)).toBe(4);
        await settle(server);
        expect(server.groupCommits).toEqual([3]);
        expect(readHeldMsgIds(server)).toEqual([]);
        expect(readSeqs(server.sockets.b)).toEqual([1, 2, 4]);
        expect(readFrames(server.sockets.b, 'event-4')).toEqual([{ ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: { b: 2 } }, proof: undefined }]);
        expect(readFrames(server.sockets.a, 'event-4')).toEqual([{ ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: {} }, proof: undefined }]);
    });

    it('sends a burst of more than one page of rows on one track with every recipient\'s entry, the burst\'s groups chained', async () => {
        const server = await createOrderedServer({ cluster });
        await enqueueEvents(server, { from: 1, to: 10, audience: ['a', 'b'] });
        await enqueueEvents(server, { from: 11, to: 20, audience: ['a'] });
        await enqueueEvents(server, { from: 21, to: 21, audience: ['a', 'b'] });

        await expect.poll(() => runEngineTicking(server, () => [readSeqs(server.sockets.a).length, readSeqs(server.sockets.b).length]))
            .toEqual([21, 11]);
        expect(readFrames(server.sockets.b, 'event-21')).toEqual([{ ordering: { ...ORDERING, seq: 21, priorSeqByRecipient: { b: 10 } }, proof: undefined }]);
        expect(readFrames(server.sockets.b, 'event-10')).toEqual([{ ordering: { ...ORDERING, seq: 10, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readFrames(server.sockets.a, 'event-21')).toEqual([{ ordering: { ...ORDERING, seq: 21, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readSeqs(server.sockets.b)).toEqual([...toSeqs(1, 10), 21]);
        expect(Math.max(...server.groupCommits)).toBeGreaterThan(1);
        expect(readHeldMsgIds(server)).toEqual([]);
    });

    it('records a producer row\'s positions at its first dequeue, so a session the producer admitted first at a later sequence enters there', async () => {
        const server = await createOrderedServer({ cluster });
        await writeProducerRow(server, producerEvent(1), ['a', 'b']);
        await expect.poll(() => runEngineTicking(server, () => ['a', 'b'].map((peerId) => readMsgIds(server.sockets[peerId]!))))
            .toEqual([['s-event-1'], ['s-event-1']]);

        await writeProducerRow(server, producerEvent(2), ['a', 'b', 'c']);
        await expect.poll(() => runEngineTicking(server, () => readMsgIds(server.sockets.c))).toEqual(['s-event-2']);
        await settle(server);

        expect(readFrames(server.sockets.c, 's-event-2')).toEqual([{ ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: { c: 0 } }, proof: undefined }]);
        expect(readFrames(server.sockets.b, 's-event-2')).toEqual([{ ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readMsgIds(server.sockets.c)).toEqual(['s-event-2']);
        expect((await server.stores.admissionStore.readStoredMessage('s-event-2'))?.sentPositions).toEqual({ a: 1, b: 1, c: 0 });
    });

    it('records a recipient it skipped below its position on a producer row outside its own receipt, and the receipt completes on the others with no retry attempt spent', async () => {
        const server = await createOrderedServer({ cluster });
        await writeProducerRow(server, producerEvent(2), ['b']);
        await expect.poll(() => runEngineTicking(server, () => readMsgIds(server.sockets.b))).toEqual(['s-event-2']);

        await writeProducerRow(server, producerEvent(1), ['b', 'c']);
        await expect.poll(() => runEngineTicking(server, () => readMsgIds(server.sockets.c))).toEqual(['s-event-1']);
        await settle(server);

        expect(readFrames(server.sockets.c, 's-event-1')).toEqual([{ ordering: { ...ORDERING, seq: 1, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readFrames(server.sockets.b, 's-event-1')).toEqual([]);
        expect((await server.stores.admissionStore.readReceiptState({ originPeerId: SERVER_ID, msgId: 's-event-1' }))?.outsideAudiencePeerIds)
            .toEqual(['b']);

        await server.service.acceptIncomingMessage(toReceiverAck(server, 's-event-1', 'c'), 'c');
        await expect.poll(() => runEngine(server, () => server.stores.admissionStore.readPendingAck({ originPeerId: SERVER_ID, msgId: 's-event-1' })))
            .toBeUndefined();
        await settle(server);
        expect(server.settlements).not.toContainEqual(expect.objectContaining({ kind: 'receipt-exhausted', msgId: 's-event-1' }));
        expect((await server.stores.admissionStore.readReceiptState({ originPeerId: SERVER_ID, msgId: 's-event-1' }))?.attempts).toBe(0);
    });

    it('retries a producer row\'s receipt only for the recipient still unconfirmed, not the one it recorded outside', async () => {
        const server = await createOrderedServer({ cluster });
        const commitBundle = vi.spyOn(server.stores.admissionStore, 'commitBundle');
        await writeProducerRow(server, producerEvent(2), ['b']);
        await expect.poll(() => runEngineTicking(server, () => readMsgIds(server.sockets.b))).toEqual(['s-event-2']);
        await writeProducerRow(server, producerEvent(1), ['b', 'c']);
        await expect.poll(() => runEngineTicking(server, () => readMsgIds(server.sockets.c))).toEqual(['s-event-1']);
        await settle(server);

        await expect.poll(() => runEngineAdvancing(server, () => readRetriedPeerIds(commitBundle, 's-event-1')), { timeout: 4_000 })
            .toEqual([['c']]);
    });

    it('holds a producer row claimed without its track\'s earlier producer row, still unrecorded after a failed re-check, until it records; both deliver in order', async () => {
        const server = await createOrderedServer({ cluster, unreadableOnceMsgId: 's-event-1' });
        // Sequence 1's first dequeue cannot read its audience and retries a millisecond on; sequence 2 is written and
        // claimed alone before then.
        await writeProducerRow(server, producerEvent(1), ['b']);
        await runEngineTicking(server, () => undefined);
        await waitForRetry(server, producerEvent(1));
        await writeProducerRow(server, producerEvent(2), ['b']);
        await runEngine(server, () => undefined);

        await expect.poll(() => runEngineAdvancing(server, () => readMsgIds(server.sockets.b).slice(0, 2)), { timeout: 10_000 })
            .toEqual(['s-event-1', 's-event-2']);
        expect(readHeldMsgIds(server)).toEqual(['s-event-2']);
    });

    it('holds a row on its nearest pending predecessor past a sequence nobody wrote between them', async () => {
        const server = await createOrderedServer({ cluster, unreadableOnceMsgId: 's-event-1' });
        await writeProducerRow(server, producerEvent(1), ['b']);
        await runEngineTicking(server, () => undefined);
        await waitForRetry(server, producerEvent(1));
        await writeProducerRow(server, producerEvent(3), ['b']);
        await runEngine(server, () => undefined);

        await expect.poll(() => runEngineAdvancing(server, () => readSeqs(server.sockets.b).slice(0, 2)), { timeout: 10_000 })
            .toEqual([1, 3]);
        expect(readHoldDetails(server)).toEqual(['WS row waits for sequence 1 of its track to record first']);
    });

    it('releases a row whose predecessor ends unrecorded through the cleared index, long before that predecessor\'s deadline', async () => {
        const server = await createOrderedServer({ cluster });
        const startedAtMs = server.clock.nowMs;
        await writeProducerRow(server, producerEvent(1), ['b'], { provenanceFailure: 'corrupt' });
        await writeProducerRow(server, producerEvent(2), ['b']);

        await expect.poll(() => runEngineTicking(server, () => readMsgIds(server.sockets.b)), { timeout: 5_000 }).toEqual(['s-event-2']);
        expect(server.clock.nowMs - startedAtMs).toBeLessThan(EVENT_TTL_MS);
        expect(await server.stores.admissionStore.listOrderingMessages(TRACK_KEY)).toEqual([{ seq: 2, msgId: 's-event-2' }]);
    });

    it('releases a row whose predecessor fails for good, non-retryably, through the cleared index, not its deadline', async () => {
        const server = await createOrderedServer({ cluster });
        const startedAtMs = server.clock.nowMs;
        await writeProducerRow(server, producerEvent(1), ['b'], { provenanceFailure: 'non-retryable' });
        await writeProducerRow(server, producerEvent(2), ['b']);

        await expect.poll(() => runEngineTicking(server, () => readMsgIds(server.sockets.b)), { timeout: 5_000 }).toEqual(['s-event-2']);
        expect(server.clock.nowMs - startedAtMs).toBeLessThan(EVENT_TTL_MS);
        expect(await server.stores.admissionStore.listOrderingMessages(TRACK_KEY)).toEqual([{ seq: 2, msgId: 's-event-2' }]);
    });

    it('keeps a failed row\'s outcome and reports its unwritten index end as a diagnostic', async () => {
        const server = await createOrderedServer({ cluster });
        vi.spyOn(server.stores.admissionStore, 'commitOrderingMessageEnd').mockRejectedValue(new Error('Index end unavailable'));
        await writeProducerRow(server, producerEvent(1), ['b'], { provenanceFailure: 'corrupt' });

        await expect.poll(async () => {
            await runEngineTicking(server, () => undefined);
            return (await server.outbox.getItem(producerEvent(1).route))?.status;
        }).toBe(EntityStatus.NON_RETRYABLE);
        expect(server.trackIndexEnds).toEqual([expect.objectContaining({ kind: 'track-index-end', msgId: 's-event-1', outcome: 'failed' })]);
    });

    it('never waits for a sequence nobody wrote: 3 then 5 deliver in order with no hold on 4', async () => {
        const server = await createOrderedServer({ cluster });
        await writeProducerRow(server, producerEvent(3), ['b']);
        await writeProducerRow(server, producerEvent(5), ['b']);

        await expect.poll(() => runEngineTicking(server, () => readSeqs(server.sockets.b))).toEqual([3, 5]);
        await settle(server);
        expect(readSeqs(server.sockets.b)).toEqual([3, 5]);
        expect(readHoldDetails(server).filter((detail) => detail.includes('sequence 4 '))).toEqual([]);
    });
});

/**
 * One instance whose clock moves only when a test moves it, so no receipt window passes unasked; `cluster` registers a
 * cluster publisher, as every default api-v1 composition does, so each dequeued row is published and sent live here.
 */
async function createOrderedServer(options: OrderedServerOptions = {}): Promise<OrderedServer> {
    const clock = mockClock();
    const nowMs = () => clock.nowMs;
    const outbox = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    const socketServer = new JsonWebSocketServer();
    const sockets: Record<string, SimulatedWebSocket> = {};
    for (const peerId of ['a', 'b', 'c']) {
        const socket = new SimulatedWebSocket(`ws://${peerId}`);
        await socket.open();
        socketServer.addConnection(new ConnectionContext({ id: peerId, socket }));
        sockets[peerId] = socket;
    }
    const recipients = () => [...socketServer.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const controlAdmissions: ControlAdmission[] = [];
    const trackIndexEnds: TrackIndexEnd[] = [];
    const settlements: ALDeliverySettlement[] = [];
    const groupCommits: number[] = [];
    const orderedDispatches: string[] = [];
    const engine = new InboxOutboxEngine();
    const outboundBackend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), nowMs);
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        nowMs,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        outboundBackend
    });
    const producerRows = new Map<string, WsOutboxProducerAuthority | 'corrupt' | 'non-retryable'>();
    const unreadable = new Set(options.unreadableOnceMsgId === undefined ? [] : [options.unreadableOnceMsgId]);
    const rechecksAudience = options.unreadableOnceMsgId !== undefined || options.recheckGate !== undefined;
    const recheck: WsCapturedRecipientEligibilityFilter = async (captured) => {
        if (captured.message.id.msgId === options.recheckGate?.msgId) {
            await options.recheckGate.released;
        }
        if (unreadable.delete(captured.message.id.msgId)) {
            throw new Error('Re-check could not read');
        }
        return captured.candidateSessionIds;
    };
    const service = createDefaultWsQueueBoxServerService({
        capturedRecipientEligibilityFilters: !rechecksAudience ? undefined : { durable: recheck, local: recheck },
        inboundVolatileStores: undefined,
        outbox,
        socket: socketServer,
        name: SERVER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: (connection) =>
            socketServer.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        outboundStores,
        readProducerProvenance: async (message) => {
            const authority = producerRows.get(message.id.msgId);
            if (authority === 'non-retryable') {
                throw new NonRetryableException('Producer provenance refuses the row for good');
            }
            if (authority === undefined || authority === 'corrupt') {
                throw new ALAdmissionCorruptionError(message.id.msgId, new TypeError('Producer provenance cannot be read'));
            }
            return authority;
        },
        outboundDiagnostics: (event) => {
            if (event.kind === 'control-admission') {
                controlAdmissions.push(event);
            }
            if (event.kind === 'track-index-end') {
                trackIndexEnds.push(event);
            }
        },
        outboundSettlements: (settlement) => settlements.push(settlement),
        dequeueTiming: (observation) => {
            if (observation.kind === 'admission-group' && observation.outcome === 'committed') {
                groupCommits.push(observation.memberCount);
            }
            if (observation.kind === 'admission-stage' && observation.stage === 'ordered-dispatch-start') {
                orderedDispatches.push(decodePersistedALMessage(observation.member.effect.entry.resource).id.msgId);
            }
        },
        targetResolver: {
            requiresFrozenAudience: () => rechecksAudience,
            resolvePeerRecipients: (peerId) => recipients().filter((recipient) => recipient.peerId === peerId),
            resolveGroupRecipients: recipients,
            resolveBroadcastRecipients: recipients
        }
    });
    onTestFinished(() => service.dispose());
    if (options.cluster === true) {
        await installQueueBoxPubSubBridge({ wsQBoxServerService: service, bridge: new LoopbackBridge(), channel: 'ws', publisherId: SERVER_ID });
    }
    return {
        service,
        engine,
        sockets,
        clock,
        controlAdmissions,
        trackIndexEnds,
        settlements,
        groupCommits,
        orderedDispatches,
        outbox,
        outboundBackend,
        stores: outboundStores,
        producerRows
    };
}

/**
 * Writes an ordered row as a producer's transaction leaves it: the row on the outbox, its provenance, and its track
 * index entry, with no outbound admission of its own; then announces the write as the producer's commit does.
 */
async function writeProducerRow(
    server: OrderedServer,
    message: ALMessage,
    audience: readonly string[],
    options: ProducerRowOptions = {}
): Promise<void> {
    const trackKey = toALOrderingTrackKey(message);
    const seq = message.ordering?.seq;
    if (trackKey === undefined || seq === undefined) {
        throw new TypeError('A producer row names its track and sequence');
    }
    server.producerRows.set(
        message.id.msgId,
        options.provenanceFailure ?? { admittedAudience: audience, recipientScope: undefined }
    );
    const createdAt = Temporal.Instant.fromEpochMilliseconds(server.clock.nowMs);
    await server.outbox.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, createdAt));
    const expiresAtMs = server.clock.nowMs + EVENT_TTL_MS;
    const key = toALOutboundOrderingMessageKey(server.stores.admissionStore.namespace, trackKey, seq);
    await server.outboundBackend.write((tx) => tx.set(key, message.id.msgId, expiresAtMs));
    server.engine.wakeAfterExternalWrite(new Set([EnqueuedType.WS_OUTBOX]));
}

/** Waits until the row's failed attempt has handed it back to the queue for its retry. */
async function waitForRetry(server: OrderedServer, message: ALMessage): Promise<void> {
    await expect.poll(async () => (await server.outbox.getItem(message.route))?.status).toBe(EntityStatus.RETRY);
}

/** Publishes `event-1` .. `event-<count>` on one track and returns the ordering each was admitted with. */
async function publishEvents(
    server: OrderedServer,
    count: number,
    audience: readonly string[] = ADMITTED_AUDIENCE
): Promise<readonly ALMessage['ordering'][]> {
    const minted: ALMessage['ordering'][] = [];
    for (let index = 1; index <= count; index += 1) {
        const result = await server.service.enqueueOutboxIfAbsent(
            roundEvent(`event-${index}`),
            { admittedAudience: audience, admittedConnectionGenerationIds: undefined, recipientScope: undefined }
        );
        minted.push(result.message.ordering);
    }
    // A claim takes the run's rows in admission order: rows that follow their predecessor in the same claim commit with
    // it, and a row claimed without its unrecorded predecessor waits for it.
    await expect.poll(
        () => runEngineTicking(server, () => audience.map((peerId) => readSeqs(server.sockets[peerId]!).length))
    ).toEqual(audience.map(() => count));
    return minted;
}

/** Admits `event-<from>` .. `event-<to>` to the audience at once, leaving their dequeues to group as they will. */
async function enqueueEvents(
    server: OrderedServer,
    input: Readonly<{ from: number; to: number; audience: readonly string[]; }>
): Promise<void> {
    for (let index = input.from; index <= input.to; index += 1) {
        await server.service.enqueueOutboxIfAbsent(
            roundEvent(`event-${index}`),
            { admittedAudience: input.audience, admittedConnectionGenerationIds: undefined, recipientScope: undefined }
        );
    }
}

function toAudienceAuthority(admittedAudience: readonly string[]): WsQueueBoxServerService.EnqueueAuthority {
    return { admittedAudience, admittedConnectionGenerationIds: undefined, recipientScope: undefined };
}

/** Admits one row to the audience and waits until it reached every recipient it sends. */
async function publishEvent(
    server: OrderedServer,
    message: ALMessage,
    audience: readonly string[],
    recipients: readonly string[] = audience
): Promise<ALMessage['ordering']> {
    const result = await server.service.enqueueOutboxIfAbsent(
        message,
        { admittedAudience: audience, admittedConnectionGenerationIds: undefined, recipientScope: undefined }
    );
    await expect.poll(
        () => runEngine(server, () => recipients.every((peerId) => readMsgIds(server.sockets[peerId]!).includes(message.id.msgId))),
        { interval: 5 }
    ).toBe(true);
    return result.message.ordering;
}

/** Client `a`'s keyed room event at the sequence `a` stated, as the server relays it. */
function browserEvent(seq: number, msgId = `a-event-${seq}`): ALMessage {
    const message = newALBroadcastMessage(
        'a',
        newALRoute('room.round.event', ROOM.groupId, msgId),
        'room',
        'round.event.v1',
        { msgId },
        { groupRef: ROOM, reliability: 'at-least-once', ack: 'receiver', ttlMs: EVENT_TTL_MS, ordering: { ...ORDERING, seq } }
    );
    return { ...message, id: { ...message.id, msgId } };
}

/** The server's keyed room event at the sequence its producer minted, shaped as `browserEvent` shapes a client's. */
function producerEvent(seq: number, msgId = `s-event-${seq}`): ALMessage {
    const message = browserEvent(seq, msgId);
    return { ...message, id: { ...message.id, senderId: SERVER_ID } };
}

/** The server's own keyed round event; `ack: 'none'` asks no receipt of its recipients. */
function roundEvent(msgId: string, ack: 'receiver' | 'none' = 'receiver'): ALMessage {
    const message = newALBroadcastMessage(
        SERVER_ID,
        newALRoute('room.round.event', ROOM.groupId, msgId),
        'room',
        'round.event.v1',
        { msgId },
        { groupRef: ROOM, reliability: 'at-least-once', ack, ttlMs: EVENT_TTL_MS, ordering: ORDERING }
    );
    return { ...message, id: { ...message.id, msgId } };
}

/** The receiver's NACK as its WS client sends it: addressed to the server, naming the server's track. */
async function receiveNack(server: OrderedServer, input: NackInput): Promise<void> {
    await server.sockets[input.fromPeerId]!.receive(JSON.stringify(toNack(server, input)));
}

function toNack(server: OrderedServer, input: NackInput): ALMessage {
    return newALNackControlMessage(
        {
            v: 4,
            msgId: `nack-${input.msgId}-${input.fromPeerId}`,
            senderId: input.fromPeerId,
            ts: server.clock.nowMs,
            traceId: 'trace-ws-queue-box-server-ordered-repair'
        },
        {
            msgId: input.msgId,
            fromPeerId: input.fromPeerId,
            logicalRecipientPeerId: input.fromPeerId,
            toPeerId: input.toPeerId ?? SERVER_ID,
            reason: input.reason,
            observedAtEpochMs: server.clock.nowMs,
            ...(input.missingRanges.length === 0 ? {} : {
                orderingKey: input.trackKey ?? TRACK_KEY,
                expectedSeq: input.missingRanges[0]!.from,
                missingRanges: input.missingRanges
            })
        }
    );
}

/** The frames of the track a socket received, as sent: each copy's ordering and proof. */
function readFrames(socket: SimulatedWebSocket, msgId: string): readonly Pick<ALMessage, 'ordering' | 'proof'>[] {
    return socket.sent.map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.id.msgId === msgId)
        .map((message) => ({ ordering: message.ordering, proof: message.proof }));
}

async function receiveAck(server: OrderedServer, ackedMsgId: string, recipient: string): Promise<void> {
    await server.sockets[recipient]!.receive(JSON.stringify(toReceiverAck(server, ackedMsgId, recipient)));
}

/** The recipient's receiver ACK of a server row, as its WS client sends it. */
function toReceiverAck(server: OrderedServer, ackedMsgId: string, recipient: string): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: `ack-${ackedMsgId}-${recipient}`, senderId: recipient, ts: server.clock.nowMs, traceId: 'trace-ws-queue-box-server-ordered-repair' },
        {
            ackedMsgId,
            fromPeerId: recipient,
            toPeerId: SERVER_ID,
            originPeerId: SERVER_ID,
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: server.clock.nowMs
        }
    );
}

/** The peers each committed receipt retry of a message asked its repair to resend to, in commit order. */
function readRetriedPeerIds(
    commitBundle: MockInstance<ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>['admissionStore']['commitBundle']>,
    msgId: string
): readonly (readonly string[])[] {
    return commitBundle.mock.calls.flatMap(([bundle]) =>
        bundle.durableEffects.flatMap((effect) =>
            effect.payload.kind === 'repair-hint' && effect.payload.msgId === msgId && effect.payload.request.trigger === 'ack-timeout'
                ? [effect.payload.request.failedPeerIds ?? []]
                : []
        )
    );
}

/** One engine pass, then the observation: the poll that calls it waits for the server's asynchronous sends. */
async function runEngine<T>(server: OrderedServer, observe: () => T): Promise<T> {
    await server.engine.executeOnce();
    return observe();
}

/**
 * One engine pass a millisecond on: a row a track's order held is due again at the instant it was released, and the
 * engine runs a row only once the clock has reached past it, so a frozen clock would keep it waiting.
 */
async function runEngineTicking<T>(server: OrderedServer, observe: () => T): Promise<T> {
    server.clock.nowMs += 1;
    return await runEngine(server, observe);
}

/** One engine pass a step of the clock on, so a row that retries after a backoff falls due within a few passes. */
async function runEngineAdvancing<T>(server: OrderedServer, observe: () => T): Promise<T> {
    server.clock.nowMs += CLOCK_STEP_MS;
    return await runEngine(server, observe);
}

/** Further passes after the awaited outcome, so a send that should not happen has had its chance to. */
async function settle(server: OrderedServer): Promise<void> {
    for (let pass = 0; pass < 5; pass += 1) {
        await server.engine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function readSeqs(socket: SimulatedWebSocket): readonly (number | undefined)[] {
    return socket.sent.map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.ordering?.orderingKey === ORDERING.orderingKey)
        .map((message) => message.ordering?.seq);
}

function readMsgIds(socket: SimulatedWebSocket): readonly string[] {
    return socket.sent.map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.ordering?.orderingKey === ORDERING.orderingKey)
        .map((message) => message.id.msgId);
}

/** The rows a track's order held at dequeue, each time it held one, while an earlier row of the track recorded first. */
function readHeldMsgIds(server: OrderedServer): readonly string[] {
    return server.settlements
        .filter((settlement) =>
            settlement.kind === 'attempt-settled' && settlement.outcome === 'not-ready' &&
            settlement.detail?.includes('of its track to record first') === true
        )
        .map((settlement) => settlement.msgId);
}

/** Why each held row waited, each time a track's order held one. */
function readHoldDetails(server: OrderedServer): readonly string[] {
    return server.settlements.flatMap((settlement) =>
        settlement.kind === 'attempt-settled' && settlement.outcome === 'not-ready' &&
            settlement.detail?.includes('of its track to record first') === true
            ? [settlement.detail]
            : []
    );
}

/** The messages whose repair budget a requester found spent; each is stated once. */
function readRepairExhaustedMsgIds(server: OrderedServer): readonly string[] {
    return server.settlements
        .filter((settlement) =>
            settlement.kind === 'admission' && settlement.verdict.kind === 'skipped' &&
            settlement.verdict.reason === 'repair-exhausted'
        )
        .map((settlement) => settlement.msgId);
}

/** The sequences ranged repair served the requester, by their gap attempt identity, in the order they were sent. */
function readServedRepairSeqs(server: OrderedServer, requester: string): readonly number[] {
    return server.settlements.flatMap((settlement) => {
        const gap = settlement.kind === 'attempt-settled' && settlement.outcome === 'sent'
            ? REPAIR_GAP_ATTEMPT.exec(decodeURIComponent(settlement.attemptId))
            : null;
        return gap?.[1] === requester ? [Number(gap[2])] : [];
    });
}

function toSeqs(from: number, to: number): readonly number[] {
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function mockClock(): { nowMs: number; } {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    onTestFinished(() => {
        vi.restoreAllMocks();
    });
    return clock;
}

/** One instance's pub/sub: a published key reaches no other instance, so only the publisher's local send runs. */
class LoopbackBridge implements QueueBoxPubSubBridge {
    publish(_channel: string, _message: QueueBoxPubSubMessage): Promise<void> {
        return Promise.resolve();
    }

    subscribe(): Promise<void> {
        return Promise.resolve();
    }
}
