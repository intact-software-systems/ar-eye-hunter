import assert from 'node:assert/strict';

import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { createServerPublishRoomAudienceReader } from '@shared-server/rallar-system/websocket/read-server-publish-room-audience.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import type { RallarServerWsFanout } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import { newALBroadcastMessage, newALEventRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_NACK_TYPE_ID, AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALNackPayload, decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupMember, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import { TestWebSocket } from '../../../../packages/tests/shared/websocket/test-web-socket.ts';
import { filterGrantedWsRecipientSessionIds } from '../../src/services/filter-granted-ws-recipient-session-ids.ts';
import { createApiV1RoomWsAuthorizer } from '../../src/services/ws-topic-room-authorizer.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const FEED = 'room.feed';
const SERVER_PEER_ID = 'room-granted-delivery';
const PRODUCER = 'feed-producer';

type Permissions = GroupPublicationTopicPermissions;
type Grants = Readonly<Record<string, Permissions | undefined>>;

/** Alice publishes, Bob and Carol subscribe. */
const GRANTS: Grants = {
    alice: { publish: true, subscribe: false },
    bob: { publish: false, subscribe: true },
    carol: { publish: false, subscribe: true }
};
const REVOKED_CAROL: Grants = { ...GRANTS, carol: undefined };

interface GrantedDeliveryHarness {
    readonly service: WsQueueBoxServerService;
    readonly router: RallarServerWsRouter;
    readonly server: JsonWebSocketServer;
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    /** Each authority read takes the next answer; the last one repeats. */
    readonly reads: (() => Promise<GroupSnapshot | undefined>)[];
    readonly readCount: () => number;
}

interface GrantedDeliveryHarnessInput {
    readonly fanout: RallarServerWsFanout;
    readonly topicId?: string;
    /** Installs no WS router topic routing beyond the granted feed; installs a cluster bridge when set. */
    readonly cluster?: boolean;
}

Deno.test('each of socket admission, pending replay, inbox dispatch and route refuses a publication without a grant', async () => {
    for (const pass of ['socket admission', 'pending replay', 'inbox dispatch', 'route'] as const) {
        await withHarness({ fanout: 'live-only' }, async (harness) => {
            const aliceFrames = addConnection(harness.server, 'alice');
            const bobFrames = addConnection(harness.server, 'bob');
            const revoked = createSnapshot({ ...GRANTS, alice: undefined }, pass === 'pending replay' ? 4 : 3);
            // The read that sees the revoke: admission is read 1, inbox dispatch read 2, route read 3.
            const grantedReads = { 'socket admission': 0, 'pending replay': 1, 'inbox dispatch': 1, route: 2 }[pass];
            harness.reads.push(
                ...Array.from({ length: grantedReads }, () => () => Promise.resolve(createSnapshot(GRANTS))),
                () => Promise.resolve(revoked)
            );
            const message = feedMessage('alice', `refused-at-${pass.replaceAll(' ', '-')}`, pass === 'pending replay' ? 4 : undefined);

            await harness.service.acceptIncomingMessage(message, 'alice');
            await waitFor(() => harness.readCount() > grantedReads);
            await settle();

            assert.equal(readDelivered(bobFrames, message), 0, pass);
            // The refusing pass is the last to read: a pass after it never runs.
            assert.equal(harness.readCount(), grantedReads + 1, pass);
            // Socket admission and route answer with the NACK; a pending replay or inbox dispatch drops the message.
            assert.deepEqual(
                readNackReasons(aliceFrames, message).filter((reason) => reason === 'no-publish-grant'),
                pass === 'socket admission' || pass === 'route' ? ['no-publish-grant'] : [],
                pass
            );
        });
    }
});

for (const step of ['single-instance dequeue', 'cluster send'] as const) {
    Deno.test(`a revoke between enqueue and dequeue skips the revoked session at ${step}`, async () => {
        await withHarness({ fanout: 'outbox', cluster: step === 'cluster send' }, async (harness) => {
            const frames = addAudience(harness.server);
            // Admission, inbox dispatch and route read the grant; the revoke commits before the dequeue's re-check.
            harness.reads.push(...grantedReads(3), revokedReads());
            const message = feedMessage('alice', `dequeue-${step.replaceAll(' ', '-')}`);

            assert.deepEqual((await harness.service.acceptIncomingMessage(message, 'alice')).right, { kind: 'admitted' });
            await waitFor(() => readDelivered(frames.bob, message) > 0);
            await settle();

            assert.equal(readDelivered(frames.bob, message), 1);
            assert.equal(readDelivered(frames.carol, message), 0);
            assert.equal(readDelivered(frames.alice, message), 0);
        });
    });
}

Deno.test('a revoke between enqueue and dequeue skips the revoked session at repair', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        // The first dequeue sends to both subscribers; neither acknowledges, and the revoke commits before the retry.
        harness.reads.push(...grantedReads(4), revokedReads());
        const message = { ...feedMessage('alice', 'repaired-revoke'), qos: { ack: { algo: 'receiver', opts: { timeoutMs: 50 } } } } as const;

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(() => readDelivered(frames.bob, message) >= 2);
        await settle();

        assert.equal(readDelivered(frames.bob, message) >= 2, true);
        assert.equal(readDelivered(frames.carol, message), 1);
    });
});

Deno.test('a revoke between enqueue and dequeue keeps the revoked session expected and unconfirmed in the receipt', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        harness.reads.push(...grantedReads(3), revokedReads());
        const message = feedMessage('alice', 'receipted-revoke');

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(() => readDelivered(frames.bob, message) > 0);
        await harness.service.acceptIncomingMessage(receiverAck(message, 'bob'), 'bob');
        await settle();

        const receipts = readReceipts(frames.alice);
        assert.deepEqual(receipts[0]?.expectedRecipientPeerIds, ['bob', 'carol']);
        assert.equal(receipts.some((receipt) => receipt.phase === 'complete'), false);
        assert.equal(receipts.some((receipt) => receipt.confirmedRecipientPeerIds.includes('carol')), false);
        assert.equal(readDelivered(frames.carol, message), 0);
    });
});

Deno.test('a revoke between enqueue and dequeue skips the revoked session at the awaited hold', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const aliceFrames = addConnection(harness.server, 'alice');
        // Bob and Carol upgraded but have not opened their sockets: the dequeued row waits for them.
        for (const sessionId of ['bob', 'carol']) {
            harness.server.expectedConnections.expect({ id: sessionId, generationId: 'generation', expiresAtEpochMs: Date.now() + 60_000 });
        }
        // Admission, dispatch, route and the dequeue read the grant; Carol's held send re-checks after the revoke.
        harness.reads.push(...grantedReads(4), revokedReads());
        const message = feedMessage('alice', 'held-revoke');

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(() => harness.readCount() >= 4);
        await settle();
        const bob = openLateConnection(harness.server, 'bob');
        const carol = openLateConnection(harness.server, 'carol');
        await waitFor(() => readDelivered(bob, message) > 0);
        await settle();

        assert.equal(readDelivered(bob, message), 1);
        assert.equal(readDelivered(carol, message), 0);
        assert.equal(readDelivered(aliceFrames, message), 0);
    });
});

Deno.test('a server-producer outbox row skips a subscriber revoked before dequeue and still reaches the others', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        // The publish reads the grant once; the revoke commits before the dequeue.
        harness.reads.push(...grantedReads(1), revokedReads());
        const message = feedMessage(SERVER_PEER_ID, 'produced-revoke');

        const result = await harness.router.publish({ message, fanout: 'outbox', producerId: PRODUCER });
        await waitFor(() => readDelivered(frames.bob, message) > 0);
        await settle();

        assert.equal(result.status, 'queued-outbox');
        assert.equal(readDelivered(frames.bob, message), 1);
        assert.equal(readDelivered(frames.carol, message), 0);
    });
});

Deno.test('a failed snapshot read at dequeue sends nothing and keeps the row for retry', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        harness.reads.push(...grantedReads(3), () => Promise.reject(new Error('version probe failed')));
        const message = feedMessage('alice', 'probe-failed');

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(() => harness.readCount() >= 5);
        await settle();

        assert.equal(readDelivered(frames.bob, message), 0);
        assert.equal(readDelivered(frames.carol, message), 0);
        const rows = await readRelayRows(harness, message);
        assert.equal(rows.length, 1);
        assert.notEqual(rows[0]?.status, EntityStatus.COMPLETED);
    });
});

Deno.test('a members-topic outbox row is narrowed by the durable filter only', async () => {
    await withHarness({ fanout: 'outbox', topicId: 'room.chat' }, async (harness) => {
        const frames = addAudience(harness.server);
        // No principal holds a grant on room.chat: the row is a members row, so no grant decides its sends.
        harness.reads.push(() => Promise.resolve(createSnapshot({})));
        const message = feedMessage('alice', 'members-row', undefined, 'room.chat');

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(() => readDelivered(frames.bob, message) > 0 && readDelivered(frames.carol, message) > 0);

        assert.equal(readDelivered(frames.bob, message), 1);
        assert.equal(readDelivered(frames.carol, message), 1);
        // Admission, dispatch and route read the room; the dequeue re-checks no grant.
        assert.equal(harness.readCount(), 3);
    });
});

async function withHarness(
    input: GrantedDeliveryHarnessInput,
    body: (harness: GrantedDeliveryHarness) => Promise<void>
): Promise<void> {
    const harness = await createHarness(input);
    let bodyFailure: Error | undefined;
    try {
        await body(harness);
    }
    catch (caught) {
        bodyFailure = toError(caught);
    }
    const disposed = await Promise.allSettled([harness.service.dispose()]);
    if (bodyFailure) {
        throw bodyFailure;
    }
    if (disposed[0]?.status === 'rejected') {
        throw disposed[0].reason;
    }
}

async function createHarness(input: GrantedDeliveryHarnessInput): Promise<GrantedDeliveryHarness> {
    const server = new JsonWebSocketServer();
    const stores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const grantedTopics = new WsGrantedTopicSet();
    const reads: (() => Promise<GroupSnapshot | undefined>)[] = [];
    let readCount = 0;
    const readCurrentSnapshot = (ref: GroupRef) => {
        assert.deepEqual(ref, ROOM);
        readCount += 1;
        const next = reads.length > 1 ? reads.shift()! : reads[0];
        return next === undefined ? Promise.resolve(createSnapshot(GRANTS)) : next();
    };
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        outbox: stores.workQueue,
        outboundStores: stores,
        socket: server,
        name: SERVER_PEER_ID,
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: (connection) =>
            server.connections.get(connection.id) === connection
                ? { scope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId }, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        targetResolver: createWsServerTargetResolver(server, { findGroupSnapshotByRef: () => createSnapshot(GRANTS), grantedTopics }),
        filterEligibleCapturedSessionIds: (captured) =>
            filterGrantedWsRecipientSessionIds({
                ...captured,
                durableEligibleSessionIds: captured.candidateSessionIds.filter((sessionId) => server.connections.get(sessionId)?.isOpen === true),
                grantedTopics,
                serverPeerId: SERVER_PEER_ID,
                readCurrentSnapshot,
                nowEpochMs: Date.now()
            })
    });
    const router = new RallarServerWsRouter(service, {
        grantedTopics,
        authorizeRoomMessage: createApiV1RoomWsAuthorizer(
            { readCurrentSnapshot },
            { readLifecyclePolicy: () => Promise.resolve({ status: 'absent' }) }
        ),
        readServerPublishAudience: createServerPublishRoomAudienceReader({ readGroupSnapshot: readCurrentSnapshot, nowEpochMs: Date.now })
    });
    router.defineTopic(
        input.topicId === undefined
            ? { topicId: FEED, scope: 'room', participation: 'granted', serverProducerIds: [PRODUCER], fanout: input.fanout }
            : { topicId: input.topicId, scope: 'room', participation: 'members', fanout: input.fanout }
    );
    router.install();
    if (input.cluster === true) {
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: service,
            bridge: new LoopbackBridge(),
            channel: 'granted',
            publisherId: 'publisher',
            filterEligibleCapturedSessionIds: (captured) =>
                filterGrantedWsRecipientSessionIds({
                    ...captured,
                    durableEligibleSessionIds: captured.candidateSessionIds,
                    grantedTopics,
                    serverPeerId: SERVER_PEER_ID,
                    readCurrentSnapshot,
                    nowEpochMs: Date.now()
                })
        });
    }
    return { service, router, server, stores, reads, readCount: () => readCount };
}

function grantedReads(count: number): (() => Promise<GroupSnapshot | undefined>)[] {
    return Array.from({ length: count }, () => () => Promise.resolve(createSnapshot(GRANTS)));
}

function revokedReads(): () => Promise<GroupSnapshot | undefined> {
    return () => Promise.resolve(createSnapshot(REVOKED_CAROL, 4));
}

/** Alice, Bob and Carol in the room, each a live session of the principal of the same name. */
function createSnapshot(grants: Grants, snapshotVersion = 3): GroupSnapshot {
    const principalIds = ['alice', 'bob', 'carol'];
    const group = createTestGroup({ ...ROOM, snapshotVersion, presenceVersion: 1, activeMemberCount: principalIds.length });
    return {
        causalRevision: { groupRevision: snapshotVersion, presenceRevision: 1 },
        group,
        members: principalIds.map((principalId): GroupMember => ({
            ...ROOM,
            principalId,
            role: principalId === 'alice' ? 'owner' : 'member',
            status: 'active',
            joined: group.created,
            updated: group.updated,
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        })),
        activeSessions: principalIds.map((sessionId): GroupPresenceSession => ({
            ...ROOM,
            principalId: sessionId,
            sessionId,
            generationId: `generation-${sessionId}`,
            connectionGenerationId: `ws-generation-${sessionId}`,
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 2,
            expiresAtEpochMs: 4_000_000_000_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: principalIds.length,
        onlineMemberCount: principalIds.length,
        publicationGrants: Object.entries(grants)
            .filter((entry): entry is [string, Permissions] => entry[1] !== undefined)
            .map(([principalId, permissions]) => ({ ...ROOM, principalId, topics: { [FEED]: permissions }, updated: group.updated }))
    };
}

/** An at-least-once receiver-acknowledged room broadcast; a floor makes admission wait for that snapshot version. */
function feedMessage(senderId: string, msgId: string, minSnapshotVersion?: number, topicId = FEED): ALMessage {
    const base = newALBroadcastMessage(senderId, newALEventRoute(topicId, ROOM.groupId, msgId), 'room', 'feed.v1', { msgId }, {
        groupRef: ROOM,
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: 30_000,
        ...(minSnapshotVersion === undefined ? {} : { minSnapshotVersion }),
        traceId: 'trace-ws-room-granted-delivery'
    });
    return { ...base, id: { ...base.id, msgId } };
}

function receiverAck(message: ALMessage, recipient: string): ALMessage {
    return newALAckControlMessage({ v: 4, msgId: `ack-${recipient}`, senderId: recipient, ts: Date.now(), traceId: 'trace-ws-room-granted-delivery' }, {
        ackedMsgId: message.id.msgId,
        fromPeerId: recipient,
        toPeerId: message.id.senderId,
        originPeerId: message.id.senderId,
        logicalRecipientPeerId: recipient,
        carrier: 'ws',
        status: 'delivered',
        observedAtEpochMs: Date.now()
    });
}

function addAudience(server: JsonWebSocketServer): Readonly<Record<'alice' | 'bob' | 'carol', string[]>> {
    return { alice: addConnection(server, 'alice'), bob: addConnection(server, 'bob'), carol: addConnection(server, 'carol') };
}

function addConnection(server: JsonWebSocketServer, sessionId: string): string[] {
    const socket = new TestWebSocket(`ws://${sessionId}`);
    socket.open();
    server.addConnection(new ConnectionContext({ id: sessionId, socket }));
    return socket.sent;
}

/** A socket whose upgrade the server awaited, opened now: its held sends follow. */
function openLateConnection(server: JsonWebSocketServer, sessionId: string): string[] {
    const socket = new TestWebSocket(`ws://${sessionId}`);
    server.addConnection(new ConnectionContext({ id: sessionId, socket, generationId: 'generation' }));
    socket.open();
    return socket.sent;
}

function readDelivered(frames: readonly string[], message: ALMessage): number {
    return frames.map((frame) => decodePersistedALMessage(frame))
        .filter((frame) => frame.route.topicId === message.route.topicId && frame.id.msgId === message.id.msgId).length;
}

function readNackReasons(frames: readonly string[], message: ALMessage): readonly string[] {
    return frames.map((frame) => decodePersistedALMessage(frame))
        .filter((frame) => frame.payload.typeId === AL_CONTROL_NACK_TYPE_ID)
        .map((frame) => decodeALNackPayload(JSON.parse(frame.payload.resource)))
        .filter((nack) => nack.msgId === message.id.msgId)
        .map((nack) => nack.reason);
}

function readReceipts(frames: readonly string[]): readonly ALReceiptPayload[] {
    return frames
        .map((frame) => decodePersistedALMessage(frame))
        .filter((frame) => frame.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((frame) => decodeALReceiptPayload(JSON.parse(frame.payload.resource)));
}

async function readRelayRows(harness: GrantedDeliveryHarness, message: ALMessage) {
    const workQueue = harness.stores.workQueue;
    const rows = await Promise.all((await workQueue.getAllKeys()).map((key) => workQueue.getItem(key)));
    return rows.filter((row) =>
        row !== undefined && row.key.topicId === 'AL_OUTBOUND_MESSAGE' &&
        decodePersistedALMessage(row.resource).id.msgId === message.id.msgId
    );
}

async function waitFor(isSettled: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 300 && !isSettled(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
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
