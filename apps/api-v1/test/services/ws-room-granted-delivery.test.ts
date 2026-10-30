import assert from 'node:assert/strict';

import type { GroupPublicationAuthority } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { installLiveWsNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import { encodeLiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
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
import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupMember, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import { TestWebSocket } from '../../../../packages/tests/shared/websocket/test-web-socket.ts';
import { API_V1_LIVE_WS_NOTICE_CHANNEL, createApiV1LiveWsNoticeTransport } from '../../src/db/api-v1-live-ws-notice-transport.ts';
import { createLocalQueuePubSubBus } from '../../src/db/local-queue-pubsub-bridge.ts';
import { filterGrantedWsRecipientSessionIds } from '../../src/services/filter-granted-ws-recipient-session-ids.ts';
import { createApiV1RoomWsAuthorizer } from '../../src/services/ws-topic-room-authorizer.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const FEED = 'room.feed';
const SERVER_PEER_ID = 'room-granted-delivery';
const PRODUCER = 'feed-producer';
const MEMBERS_TOPIC = 'room.chat';

type Grants = Readonly<Record<string, GroupPublicationTopicPermissions | undefined>>;
/** Session id → the generation its live subscription to the feed asserts; its live client row carries the same. */
type Subscriptions = Readonly<Record<string, string>>;
/** One read of the room: the probed snapshot with the feed's fresh subscription rows, or no current snapshot. */
type RoomRead = () => Promise<GroupPublicationAuthority | undefined>;

/** Alice publishes, Bob and Carol subscribe. */
const GRANTS: Grants = {
    alice: { publish: true, subscribe: false },
    bob: { publish: false, subscribe: true },
    carol: { publish: false, subscribe: true }
};
const REVOKED_CAROL: Grants = { ...GRANTS, carol: undefined };
/** Every session subscribes to the feed under its first generation. */
const SUBSCRIBED: Subscriptions = { alice: 'client-generation-alice', bob: 'client-generation-bob', carol: 'client-generation-carol' };
const UNSUBSCRIBED_CAROL: Subscriptions = { alice: SUBSCRIBED.alice, bob: SUBSCRIBED.bob };

interface GrantedDeliveryHarness {
    readonly service: WsQueueBoxServerService;
    readonly router: RallarServerWsRouter;
    readonly server: JsonWebSocketServer;
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    /** Each authority read takes the next answer; the last one repeats. */
    readonly reads: RoomRead[];
    /** When set, the D498 re-check reads this instead of taking its turn in `reads`. */
    recheckRead: RoomRead | undefined;
    readonly readCount: () => number;
}

interface GrantedDeliveryHarnessInput {
    /** The fanout of the granted feed and of the members topic `room.chat` the harness also defines. */
    readonly fanout: RallarServerWsFanout;
    /** Installs a cluster bridge over a loopback pub/sub. */
    readonly cluster?: boolean;
    /** Wires the server, and the bridge when installed, without the D498 re-check port: the half-wired composition. */
    readonly withoutRecheck?: boolean;
}

Deno.test('each of socket admission, pending replay, inbox dispatch and route refuses a publication without a grant', async () => {
    for (const pass of ['socket admission', 'pending replay', 'inbox dispatch', 'route'] as const) {
        await withHarness({ fanout: 'live-only' }, async (harness) => {
            const aliceFrames = addConnection(harness.server, 'alice');
            const bobFrames = addConnection(harness.server, 'bob');
            const revoked = createAuthority({ ...GRANTS, alice: undefined }, { snapshotVersion: pass === 'pending replay' ? 4 : 3 });
            // The read that sees the revoke: admission is read 1, inbox dispatch read 2, route read 3.
            const grantedReads = { 'socket admission': 0, 'pending replay': 1, 'inbox dispatch': 1, route: 2 }[pass];
            harness.reads.push(
                ...Array.from({ length: grantedReads }, () => () => Promise.resolve(createAuthority(GRANTS))),
                () => Promise.resolve(revoked)
            );
            const message = feedMessage({
                senderId: 'alice',
                msgId: `refused-at-${pass.replaceAll(' ', '-')}`,
                ...(pass === 'pending replay' ? { minSnapshotVersion: 4 } : {})
            });

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
            const message = feedMessage({ senderId: 'alice', msgId: `dequeue-${step.replaceAll(' ', '-')}` });

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
        const message = {
            ...feedMessage({ senderId: 'alice', msgId: 'repaired-revoke' }),
            qos: { ack: { algo: 'receiver', opts: { timeoutMs: 50 } } }
        } as const;

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
        const message = feedMessage({ senderId: 'alice', msgId: 'receipted-revoke' });

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
        const message = feedMessage({ senderId: 'alice', msgId: 'held-revoke' });

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

Deno.test('two held granted rows for one session reach it in admission order however long their re-checks take', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        addConnection(harness.server, 'alice');
        harness.server.expectedConnections.expect({ id: 'bob', generationId: 'generation', expiresAtEpochMs: Date.now() + 60_000 });
        let rechecks = 0;
        // Each row's dequeue re-checks once; the first held re-check then answers after the second.
        harness.recheckRead = async () => {
            rechecks += 1;
            if (rechecks === 3) {
                await new Promise((resolve) => setTimeout(resolve, 40));
            }
            return createAuthority(GRANTS);
        };
        const first = feedMessage({ senderId: 'alice', msgId: 'held-first' });
        const second = feedMessage({ senderId: 'alice', msgId: 'held-second' });

        await harness.service.acceptIncomingMessage(first, 'alice');
        await harness.service.acceptIncomingMessage(second, 'alice');
        await waitFor(() => rechecks >= 2);
        await settle();
        const bob = openLateConnection(harness.server, 'bob');
        await waitFor(() => readDelivered(bob, first) > 0 && readDelivered(bob, second) > 0);

        const order = bob.map((frame) => decodePersistedALMessage(frame).id.msgId).filter((msgId) => msgId.startsWith('held-'));
        assert.deepEqual(order, ['held-first', 'held-second']);
    });
});

Deno.test('a server-producer outbox row skips a subscriber revoked before dequeue and still reaches the others', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        // The publish reads the grant once; the revoke commits before the dequeue.
        harness.reads.push(...grantedReads(1), revokedReads());
        const message = feedMessage({ senderId: SERVER_PEER_ID, msgId: 'produced-revoke' });

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
        const message = feedMessage({ senderId: 'alice', msgId: 'probe-failed' });

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

for (const cluster of [false, true]) {
    Deno.test(`a granted outbox row with no re-check port reaches nobody (${cluster ? 'cluster send' : 'single instance'})`, async () => {
        await withHarness({ fanout: 'outbox', cluster, withoutRecheck: true }, async (harness) => {
            const frames = addAudience(harness.server);
            const message = feedMessage({ senderId: 'alice', msgId: `unchecked-${cluster ? 'cluster' : 'single'}` });

            assert.deepEqual((await harness.service.acceptIncomingMessage(message, 'alice')).right, { kind: 'admitted' });
            await waitFor(async () => (await readRelayRows(harness, message))[0]?.status === EntityStatus.COMPLETED);
            await settle();

            assert.equal(readDelivered(frames.bob, message), 0);
            assert.equal(readDelivered(frames.carol, message), 0);
        });
    });
}

Deno.test('a run of granted rows for a missing room does not stop a members row\'s delivery and does not open the dequeue breaker', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        const granted = Array.from({ length: 12 }, (_, index) => feedMessage({ senderId: 'alice', msgId: `missing-room-${index}` }));
        // Admission, dispatch and route read the room; every dequeue re-check then finds it gone.
        harness.recheckRead = () => Promise.resolve(undefined);
        for (const message of granted) {
            await harness.service.acceptIncomingMessage(message, 'alice');
        }
        await waitFor(async () =>
            (await Promise.all(granted.map((message) => readRelayRows(harness, message))))
                .every((rows) => rows[0]?.status === EntityStatus.COMPLETED)
        );
        const members = feedMessage({ senderId: 'alice', msgId: 'members-after-missing-room', topicId: MEMBERS_TOPIC });

        await harness.service.acceptIncomingMessage(members, 'alice');
        await waitFor(() => readDelivered(frames.bob, members) > 0);

        assert.equal(readDelivered(frames.bob, members), 1);
        assert.equal(readDelivered(frames.carol, members), 1);
        assert.equal(granted.some((message) => readDelivered(frames.bob, message) > 0), false);
    });
});

Deno.test('a granted row whose publisher\'s session left before dequeue reaches nobody and completes', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        const departed = createAuthority(GRANTS);
        harness.reads.push(...grantedReads(3), () =>
            Promise.resolve({
                ...departed,
                snapshot: {
                    ...departed.snapshot,
                    activeSessions: departed.snapshot.activeSessions.filter((session) => session.sessionId !== 'alice')
                }
            }));
        const message = feedMessage({ senderId: 'alice', msgId: 'publisher-departed' });

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(async () => (await readRelayRows(harness, message))[0]?.status === EntityStatus.COMPLETED);
        await settle();

        assert.equal((await readRelayRows(harness, message))[0]?.status, EntityStatus.COMPLETED);
        assert.equal(readDelivered(frames.bob, message), 0);
        assert.equal(readDelivered(frames.carol, message), 0);
    });
});

Deno.test('a granted row of a room archived before dequeue reaches nobody', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        const authority = createAuthority(GRANTS, { snapshotVersion: 4 });
        const { group } = authority.snapshot;
        harness.reads.push(...grantedReads(3), () =>
            Promise.resolve({
                ...authority,
                snapshot: { ...authority.snapshot, group: { ...group, status: 'archived', archived: group.updated, deleted: null } }
            }));
        const message = feedMessage({ senderId: 'alice', msgId: 'archived-room' });

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(() => harness.readCount() >= 4);
        await settle();

        assert.equal(readDelivered(frames.bob, message), 0);
        assert.equal(readDelivered(frames.carol, message), 0);
    });
});

Deno.test('a remote node\'s broad live notice on a granted topic reaches no session', async () => {
    const localBus = createLocalQueuePubSubBus();
    const remote = new JsonWebSocketServer();
    const frames = addAudience(remote);
    const grantedTopics = new WsGrantedTopicSet();
    grantedTopics.add(FEED);
    const targetResolution = new WsQueueBoxServerTargetResolution({
        socket: remote,
        targetResolver: createWsServerTargetResolver(remote, { grantedTopics })
    });
    const delivered: string[] = [];
    await installLiveWsNoticeSubscriber({
        transport: createApiV1LiveWsNoticeTransport({ mode: 'local', publisherId: 'remote', notification: null, localBus, nowMs: Date.now }),
        channel: API_V1_LIVE_WS_NOTICE_CHANNEL,
        publisherId: 'remote',
        nowMs: Date.now,
        inboundStores: [],
        // As the middleware resolves a broad notice's recipients on the receiving node.
        resolveBroadRecipientSessionIds: (message) => targetResolution.resolveOutboundRecipients(message).map((recipient) => recipient.connectionId),
        filterEligibleRecipientSessionIds: (sessionIds) => sessionIds,
        sendToTargetsWithResult: ({ message, recipientSessionIds }) => {
            delivered.push(...recipientSessionIds.map((sessionId) => `${message.route.topicId}:${sessionId}`));
        }
    });
    const origin = createApiV1LiveWsNoticeTransport({ mode: 'local', publisherId: 'origin', notification: null, localBus, nowMs: Date.now });

    for (const topicId of [FEED, 'app.news']) {
        const encoded = encodeLiveWsNotice({
            channel: API_V1_LIVE_WS_NOTICE_CHANNEL,
            publisherId: 'origin',
            scope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId },
            expiresAtMs: Date.now() + 30_000,
            audience: { mode: 'broad', targetMode: 'world' },
            message: worldMessage(topicId)
        });
        assert.equal(encoded.kind, 'inline');
        if (encoded.kind === 'inline') {
            await origin.publish(encoded.notice);
        }
    }
    await settle();

    assert.deepEqual(delivered, ['app.news:alice', 'app.news:bob', 'app.news:carol']);
    assert.equal(frames.bob.length, 0);
});

const ROUTE_TIME_CHANGES = [
    ['an unsubscribe', subscriptionReads(UNSUBSCRIBED_CAROL)],
    ['a revoke of subscribe', revokedReads()],
    // Carol's socket reopened under a new generation that has not subscribed yet: her row asserts the closed one.
    ['a reopened generation', () => Promise.resolve(createAuthority(GRANTS, { reopenedGenerations: { carol: 'client-generation-carol-reopened' } }))]
] as const;

for (const [change, routeRead] of ROUTE_TIME_CHANGES) {
    Deno.test(`${change} between socket admission and route skips the session on a live-only granted topic`, async () => {
        await withHarness({ fanout: 'live-only' }, async (harness) => {
            const frames = addAudience(harness.server);
            // Socket admission and inbox dispatch read Carol's live subscription; route's fresh read no longer finds it.
            harness.reads.push(...grantedReads(2), routeRead);
            const message = feedMessage({ senderId: 'alice', msgId: `live-route-${change.replaceAll(' ', '-')}` });

            assert.deepEqual((await harness.service.acceptIncomingMessage(message, 'alice')).right, { kind: 'admitted' });
            await waitFor(() => readDelivered(frames.bob, message) > 0);
            await settle();

            assert.equal(readDelivered(frames.bob, message), 1, change);
            assert.equal(readDelivered(frames.carol, message), 0, change);
            assert.deepEqual(readReceipts(frames.alice)[0]?.expectedRecipientPeerIds, ['bob', 'carol'], change);
        });
    });
}

Deno.test('only subscribed sessions receive a granted publication', async () => {
    for (const fanout of ['live-only', 'outbox'] as const) {
        await withHarness({ fanout }, async (harness) => {
            const frames = addAudience(harness.server);
            // Carol holds subscribe but has not subscribed.
            harness.reads.push(subscriptionReads(UNSUBSCRIBED_CAROL));
            const message = feedMessage({ senderId: 'alice', msgId: `subscribed-only-${fanout}` });

            await harness.service.acceptIncomingMessage(message, 'alice');
            await waitFor(() => readDelivered(frames.bob, message) > 0);
            await settle();

            assert.equal(readDelivered(frames.bob, message), 1, fanout);
            assert.equal(readDelivered(frames.carol, message), 0, fanout);
            assert.deepEqual(readReceipts(frames.alice)[0]?.expectedRecipientPeerIds, ['bob'], fanout);
        });
    }
});

for (const step of ['single-instance dequeue', 'cluster send'] as const) {
    Deno.test(`an unsubscribe between enqueue and dequeue skips the session at ${step}`, async () => {
        await withHarness({ fanout: 'outbox', cluster: step === 'cluster send' }, async (harness) => {
            const frames = addAudience(harness.server);
            // Admission, inbox dispatch and route read Carol's subscription; her unsubscribe commits before the re-check.
            harness.reads.push(...grantedReads(3), subscriptionReads(UNSUBSCRIBED_CAROL));
            const message = feedMessage({ senderId: 'alice', msgId: `unsubscribed-${step.replaceAll(' ', '-')}` });

            assert.deepEqual((await harness.service.acceptIncomingMessage(message, 'alice')).right, { kind: 'admitted' });
            await waitFor(() => readDelivered(frames.bob, message) > 0);
            await settle();

            assert.equal(readDelivered(frames.bob, message), 1);
            assert.equal(readDelivered(frames.carol, message), 0);
        });
    });
}

Deno.test('an unsubscribe between enqueue and dequeue skips the session at repair', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        // The first dequeue sends to both subscribers; neither acknowledges, and Carol unsubscribes before the retry.
        harness.reads.push(...grantedReads(4), subscriptionReads(UNSUBSCRIBED_CAROL));
        const message = {
            ...feedMessage({ senderId: 'alice', msgId: 'repaired-unsubscribe' }),
            qos: { ack: { algo: 'receiver', opts: { timeoutMs: 50 } } }
        } as const;

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(() => readDelivered(frames.bob, message) >= 2);
        await settle();

        assert.equal(readDelivered(frames.bob, message) >= 2, true);
        assert.equal(readDelivered(frames.carol, message), 1);
    });
});

Deno.test('a session that re-subscribed under a new generation between enqueue and dequeue is not sent the old row', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        // Carol's socket reopened after route: her live client generation and her renewed subscription both moved on.
        harness.reads.push(...grantedReads(3), subscriptionReads({ ...SUBSCRIBED, carol: 'client-generation-carol-reopened' }));
        const message = feedMessage({ senderId: 'alice', msgId: 'resubscribed-generation' });

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(() => readDelivered(frames.bob, message) > 0);
        await settle();

        assert.equal(readDelivered(frames.bob, message), 1);
        assert.equal(readDelivered(frames.carol, message), 0);
    });
});

Deno.test('a held row for a session whose generation changed is not sent when its socket opens', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        addConnection(harness.server, 'alice');
        for (const sessionId of ['bob', 'carol']) {
            harness.server.expectedConnections.expect({ id: sessionId, generationId: 'generation', expiresAtEpochMs: Date.now() + 60_000 });
        }
        // Admission, dispatch, route and the dequeue read the first generations; the held re-checks read Carol's new one.
        harness.reads.push(...grantedReads(4), subscriptionReads({ ...SUBSCRIBED, carol: 'client-generation-carol-reopened' }));
        const message = feedMessage({ senderId: 'alice', msgId: 'held-generation' });

        await harness.service.acceptIncomingMessage(message, 'alice');
        await waitFor(() => harness.readCount() >= 4);
        await settle();
        const bob = openLateConnection(harness.server, 'bob');
        const carol = openLateConnection(harness.server, 'carol');
        await waitFor(() => readDelivered(bob, message) > 0);
        await settle();

        assert.equal(readDelivered(bob, message), 1);
        assert.equal(readDelivered(carol, message), 0);
    });
});

Deno.test('a granted outbox row without captured generations sends nobody', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        const message = feedMessage({ senderId: SERVER_PEER_ID, msgId: 'captured-without-generations' });

        const admitted = await harness.service.enqueueOutboxIfAbsent(message, {
            admittedAudience: ['bob', 'carol'],
            admittedConnectionGenerationIds: undefined,
            recipientScope: undefined
        });
        await waitFor(async () => (await readRelayRows(harness, message))[0]?.status === EntityStatus.COMPLETED);
        await settle();

        assert.equal(admitted.verdict.kind, 'admitted');
        assert.equal((await readRelayRows(harness, message))[0]?.status, EntityStatus.COMPLETED);
        assert.equal(readDelivered(frames.bob, message), 0);
        assert.equal(readDelivered(frames.carol, message), 0);
    });
});

Deno.test('the receipt keeps the frozen expected set when the re-check drops a session', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        harness.reads.push(...grantedReads(3), subscriptionReads(UNSUBSCRIBED_CAROL));
        const message = feedMessage({ senderId: 'alice', msgId: 'receipted-unsubscribe' });

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

Deno.test('a members-topic outbox row is narrowed by the durable filter only', async () => {
    await withHarness({ fanout: 'outbox' }, async (harness) => {
        const frames = addAudience(harness.server);
        // No principal holds a grant on room.chat: the row is a members row, so no grant decides its sends.
        harness.reads.push(() => Promise.resolve(createAuthority({})));
        const message = feedMessage({ senderId: 'alice', msgId: 'members-row', topicId: MEMBERS_TOPIC });

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
    const reads: RoomRead[] = [];
    let readCount = 0;
    const readRoom = (ref: GroupRef) => {
        assert.deepEqual(ref, ROOM);
        readCount += 1;
        const next = reads.length > 1 ? reads.shift()! : reads[0];
        return next === undefined ? Promise.resolve(createAuthority(GRANTS)) : next();
    };
    const readCurrentSnapshot = async (ref: GroupRef) => (await readRoom(ref))?.snapshot;
    const readRecheckRoom = (ref: GroupRef) => harness.recheckRead?.() ?? readRoom(ref);
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
        filterEligibleCapturedSessionIds: input.withoutRecheck === true ? undefined : (captured) =>
            filterGrantedWsRecipientSessionIds({
                ...captured,
                durableEligibleSessionIds: captured.candidateSessionIds.filter((sessionId) => server.connections.get(sessionId)?.isOpen === true),
                grantedTopics,
                serverPeerId: SERVER_PEER_ID,
                readPublicationAuthority: readRecheckRoom,
                nowEpochMs: Date.now()
            })
    });
    const router = new RallarServerWsRouter(service, {
        grantedTopics,
        authorizeRoomMessage: createApiV1RoomWsAuthorizer(
            { readCurrentSnapshot, readCurrentPublicationAuthority: readRoom },
            { readLifecyclePolicy: () => Promise.resolve({ status: 'absent' }) }
        ),
        readServerPublishAudience: createServerPublishRoomAudienceReader({
            readGroupSnapshot: readCurrentSnapshot,
            readPublicationAuthority: readRoom,
            nowEpochMs: Date.now
        })
    });
    router.defineTopic({ topicId: FEED, scope: 'room', participation: 'granted', serverProducerIds: [PRODUCER], fanout: input.fanout });
    router.defineTopic({ topicId: MEMBERS_TOPIC, scope: 'room', participation: 'members', fanout: input.fanout });
    router.install();
    const harness: GrantedDeliveryHarness = {
        service,
        router,
        server,
        stores,
        reads,
        recheckRead: undefined,
        readCount: () => readCount
    };
    if (input.cluster === true) {
        await installQueueBoxPubSubBridge({
            wsQBoxServerService: service,
            bridge: new LoopbackBridge(),
            channel: 'granted',
            publisherId: 'publisher',
            filterEligibleCapturedSessionIds: input.withoutRecheck === true ? undefined : (captured) =>
                filterGrantedWsRecipientSessionIds({
                    ...captured,
                    durableEligibleSessionIds: captured.candidateSessionIds,
                    grantedTopics,
                    serverPeerId: SERVER_PEER_ID,
                    readPublicationAuthority: readRecheckRoom,
                    nowEpochMs: Date.now()
                })
        });
    }
    return harness;
}

function grantedReads(count: number, subscriptions: Subscriptions = SUBSCRIBED): RoomRead[] {
    return Array.from({ length: count }, () => () => Promise.resolve(createAuthority(GRANTS, { subscriptions })));
}

function revokedReads(): RoomRead {
    return () => Promise.resolve(createAuthority(REVOKED_CAROL, { snapshotVersion: 4 }));
}

function subscriptionReads(subscriptions: Subscriptions): RoomRead {
    return () => Promise.resolve(createAuthority(GRANTS, { subscriptions }));
}

interface CreateAuthorityOptions {
    readonly snapshotVersion?: number;
    readonly subscriptions?: Subscriptions;
    /** A session's live client generation where it differs from the one its subscription asserts. */
    readonly reopenedGenerations?: Subscriptions;
}

/** The room's snapshot with each subscribed session's live feed row, asserted by its one live client generation unless reopened. */
function createAuthority(grants: Grants, options: CreateAuthorityOptions = {}): GroupPublicationAuthority {
    const snapshot = createSnapshot(grants, options.snapshotVersion);
    const subscriptions = Object.entries(options.subscriptions ?? SUBSCRIBED);
    return {
        snapshot,
        subscriptions: subscriptions.map(([sessionId, connectionGenerationId]): GroupTopicSubscription => ({
            sessionId,
            principalId: sessionId,
            topicId: FEED,
            connectionGenerationId,
            leaseExpiresAtEpochMs: Date.now() + 120_000,
            admittedAtGroupRevision: snapshot.group.snapshotVersion
        })),
        liveSessionGenerations: Object.fromEntries(
            subscriptions.map(([sessionId, generation]) => [sessionId, [options.reopenedGenerations?.[sessionId] ?? generation]])
        )
    };
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
            .filter((entry): entry is [string, GroupPublicationTopicPermissions] => entry[1] !== undefined)
            .map(([principalId, permissions]) => ({ ...ROOM, principalId, topics: { [FEED]: permissions }, updated: group.updated }))
    };
}

interface FeedMessageInput {
    readonly senderId: string;
    readonly msgId: string;
    /** A floor makes admission wait for that snapshot version. */
    readonly minSnapshotVersion?: number;
    readonly topicId?: string;
}

/** An at-least-once receiver-acknowledged room broadcast, on the granted feed unless another topic is named. */
function feedMessage({ senderId, msgId, minSnapshotVersion, topicId = FEED }: FeedMessageInput): ALMessage {
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

/** A server's world broadcast with a deadline, as another node publishes it live. */
function worldMessage(topicId: string): ALMessage {
    const base = newALBroadcastMessage(SERVER_PEER_ID, newALEventRoute(topicId, 'world', 'broad-notice'), 'world', 'feed.v1', {}, {
        ttlMs: 30_000
    });
    return { ...base, id: { ...base.id, msgId: `broad-${topicId}` } };
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

async function waitFor(isSettled: () => boolean | Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 300 && !await isSettled(); attempt += 1) {
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
