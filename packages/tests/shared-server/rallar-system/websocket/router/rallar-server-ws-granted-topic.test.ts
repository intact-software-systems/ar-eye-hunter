import { describe, expect, it, onTestFinished } from 'vitest';

import type { GroupPublicationAuthority } from '@shared-server/rallar-system/group-state/persistence/subscription/read-group-topic-subscriptions.ts';
import { createServerPublishRoomAudienceReader } from '@shared-server/rallar-system/websocket/read-server-publish-room-audience.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishResult,
    RallarServerWsRoomAuthorizationInput,
    RallarServerWsRouterOptions,
    RallarServerWsUnicastInputDto
} from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { newALBroadcastMessage, newALEventRoute, type ALMessage, type ALTargets } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createRallarGroupDirectorAppointment, mergeRallarGroupDirectorMetadata } from '@shared/api/group-director.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupMember, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createTestGroup } from '../../../../create-test-group.ts';
import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { createRecordingLiveWsPublication } from './recording-live-ws-publication.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const FEED = 'room.feed';
const PRODUCER = 'feed-producer';
/** Session id → principal: alice publishes and subscribes (two sessions), bob subscribes, carol holds nothing, dan is a demoted spectator. */
const SESSIONS = { alice: 'alice', 'alice-2': 'alice', bob: 'bob', carol: 'carol', dan: 'dan' } as const;
type SessionId = keyof typeof SESSIONS;

const GRANTS: Readonly<Record<string, GroupPublicationTopicPermissions>> = {
    alice: { publish: true, subscribe: true },
    bob: { publish: false, subscribe: true },
    dan: { publish: true, subscribe: true }
};

interface GrantedFixture {
    readonly service: WsQueueBoxServerService;
    readonly router: RallarServerWsRouter;
    readonly socketServer: JsonWebSocketServer;
    readonly grantedTopics: WsGrantedTopicSet;
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly sockets: Readonly<Record<SessionId, TestWebSocket>>;
    readonly authorizations: RallarServerWsRoomAuthorizationInput[];
    /** The snapshot each authority read answers, in read order; the last repeats. */
    readonly snapshots: GroupSnapshot[];
    /** The sessions holding a live subscription to FEED asserted by their live generation; every session by default. */
    readonly subscribed: Set<SessionId>;
}

describe('a granted WS topic (D486, D487)', () => {
    it('defineTopic refuses a granted definition without scope room', () => {
        const fixture = createGrantedFixture('live-only');

        expect(() => fixture.router.defineTopic({ topicId: 'room.unscoped', participation: 'granted', serverProducerIds: [] })).toThrow(/scoped to a room/u);
        expect(fixture.grantedTopics.has('room.unscoped')).toBe(false);
    });

    it('defineTopic refuses one topicId defined both members and granted', () => {
        const fixture = createGrantedFixture('live-only');
        fixture.router.defineTopic({ topicId: 'room.mixed', typeId: 'a.v1', participation: 'members' });

        expect(() =>
            fixture.router.defineTopic({
                topicId: 'room.mixed',
                typeId: 'b.v1',
                scope: 'room',
                participation: 'granted',
                serverProducerIds: []
            })
        ).toThrow(/both members and granted/u);
        expect(() => fixture.router.defineTopic({ topicId: FEED, typeId: 'other.v1', participation: 'members' }))
            .toThrow(/both members and granted/u);
    });

    it('an implicit room topic is members', async () => {
        const fixture = createGrantedFixture('live-only');
        const message = roomBroadcast('carol', 'room.chat', 'implicit');

        expect((await fixture.service.acceptIncomingMessage(message, 'carol')).right).toEqual({ kind: 'admitted' });

        await expect.poll(() => readDelivered(fixture.sockets.bob, 'implicit')).toBe(1);
        expect(fixture.authorizations[0]?.topic).toEqual({ participation: 'members' });
        expect(readDelivered(fixture.sockets.alice, 'implicit')).toBe(1);
    });

    it('a client publish without a grant is NACKed unauthorized with reason no-publish-grant at socket admission', async () => {
        const fixture = createGrantedFixture('live-only');

        const refused = await fixture.service.acceptIncomingMessage(roomBroadcast('bob', FEED, 'ungranted'), 'bob');

        expect(refused.left?.code).toBe('unauthorized');
        await expect.poll(() => readNacks(fixture.sockets.bob)).toEqual([{ msgId: 'ungranted', reason: 'no-publish-grant' }]);
        await settle();
        expect(readDelivered(fixture.sockets.alice, 'ungranted')).toBe(0);
    });

    it('a granted app topic sent as a world broadcast is refused unsupported at ingress', async () => {
        const fixture = createGrantedFixture('live-only');
        fixture.router.defineTopic({ topicId: 'app.scores', scope: 'room', participation: 'granted', serverProducerIds: [] });
        const base = newALBroadcastMessage('alice', newALEventRoute('app.scores', 'world', 'world-scores'), 'world', 'scores.v1', {});

        const refused = await fixture.service.acceptIncomingMessage({ ...base, id: { ...base.id, msgId: 'world-scores' } }, 'alice');

        expect(refused.left?.code).toBe('unsupported');
        await expect.poll(() => readNacks(fixture.sockets.alice)).toEqual([{ msgId: 'world-scores', reason: 'unsupported' }]);
        expect(fixture.authorizations).toEqual([]);
    });

    it('a revoke between socket admission and route refuses at route with NACK no-publish-grant and writes no outbox row', async () => {
        const fixture = createGrantedFixture('outbox');
        // Socket admission and inbox dispatch read the grant; the revoke commits before route's read.
        fixture.snapshots.push(createSnapshot(), createSnapshot(), createSnapshot({ alice: undefined }));
        const message = { ...roomBroadcast('alice', FEED, 'held-revoked'), delivery: { reliability: 'at-least-once', ack: 'receiver' } } as const;

        expect((await fixture.service.acceptIncomingMessage(message, 'alice')).right).toEqual({ kind: 'admitted' });

        await expect.poll(() => readNacks(fixture.sockets.alice)).toEqual([{ msgId: 'held-revoked', reason: 'no-publish-grant' }]);
        expect(fixture.authorizations).toHaveLength(3);
        await settle();
        expect(readDelivered(fixture.sockets.bob, 'held-revoked')).toBe(0);
        expect(await readOutboxRowCount(fixture, 'held-revoked')).toBe(0);
    });

    it('an origin session\'s sibling receives the publication', async () => {
        const fixture = createGrantedFixture('live-only');

        expect((await fixture.service.acceptIncomingMessage(roomBroadcast('alice', FEED, 'from-alice'), 'alice')).right)
            .toEqual({ kind: 'admitted' });

        await expect.poll(() => readDelivered(fixture.sockets['alice-2'], 'from-alice')).toBe(1);
        await expect.poll(() => readDelivered(fixture.sockets.bob, 'from-alice')).toBe(1);
        expect(readDelivered(fixture.sockets.alice, 'from-alice')).toBe(0);
        expect(readDelivered(fixture.sockets.carol, 'from-alice')).toBe(0);
    });

    it('a server publish with a listed producer reaches subscribe-granted sessions only', async () => {
        const fixture = createGrantedFixture('live-only');

        const result = await fixture.router.publish({
            message: roomBroadcast(fixture.router.serverPeerId, FEED, 'produced'),
            producerId: PRODUCER
        });

        expect(result.status).toBe('sent-live');
        expect(readDeliveredBy(fixture, 'produced')).toEqual({ alice: 1, 'alice-2': 1, bob: 1, carol: 0, dan: 1 });
    });

    it('an unlisted producer returns status refused with refusal topic-not-granted and no outbox row', async () => {
        const fixture = createGrantedFixture('outbox');

        const result = await fixture.router.publish({
            message: roomBroadcast(fixture.router.serverPeerId, FEED, 'unlisted'),
            producerId: 'other-producer'
        });

        expect(result).toMatchObject({ status: 'refused', refusal: 'topic-not-granted', entries: [] });
        await settle();
        expect(await readOutboxRowCount(fixture, 'unlisted')).toBe(0);
        expect(readDeliveredBy(fixture, 'unlisted')).toEqual({ alice: 0, 'alice-2': 0, bob: 0, carol: 0, dan: 0 });
    });

    it('a server publish on a granted topic with no server publish audience reader composed returns refused unsupported and no outbox row', async () => {
        const fixture = createGrantedFixture('outbox', { composesServerPublishAudience: false });

        const result = await fixture.router.publish({
            message: roomBroadcast(fixture.router.serverPeerId, FEED, 'unread'),
            producerId: PRODUCER
        });

        expect(result).toMatchObject({ status: 'refused', refusal: 'unsupported', entries: [] });
        await settle();
        expect(await readOutboxRowCount(fixture, 'unread')).toBe(0);
        expect(readDeliveredBy(fixture, 'unread')).toEqual({ alice: 0, 'alice-2': 0, bob: 0, carol: 0, dan: 0 });
    });

    it('a proxy rule relaying a subscriber-only sender onto a granted topic is refused', async () => {
        const fixture = createGrantedFixture('live-only');
        relayChatOntoFeed(fixture);

        await fixture.service.acceptIncomingMessage(roomBroadcast('bob', 'room.chat', 'bob-relay'), 'bob');

        await expect.poll(() => readDelivered(fixture.sockets.carol, 'bob-relay', 'room.chat')).toBe(1);
        await settle();
        expect(readDelivered(fixture.sockets.alice, 'bob-relay', FEED)).toBe(0);
        expect(readDelivered(fixture.sockets['alice-2'], 'bob-relay', FEED)).toBe(0);
    });

    it('a publish-granted sender\'s relay is admitted on the result topic\'s definition', async () => {
        const fixture = createGrantedFixture('live-only');
        relayChatOntoFeed(fixture);

        await fixture.service.acceptIncomingMessage(roomBroadcast('alice', 'room.chat', 'alice-relay'), 'alice');

        await expect.poll(() => readDelivered(fixture.sockets.bob, 'alice-relay', FEED)).toBe(1);
        expect(readDelivered(fixture.sockets.carol, 'alice-relay', FEED)).toBe(0);
        const relayed = fixture.authorizations.find((input) => input.topicId === FEED);
        expect(relayed?.topic).toEqual({ participation: 'granted', serverProducerIds: [PRODUCER] });
        expect(relayed?.senderId).toBe('alice');
    });

    it('the unfrozen resolver returns no recipients for a granted topic', () => {
        const fixture = createGrantedFixture('live-only');
        const resolver = createWsServerTargetResolver(fixture.socketServer, {
            findGroupSnapshotByRef: () => createSnapshot(),
            grantedTopics: fixture.grantedTopics
        });

        const unfrozen = roomBroadcast('alice', FEED, 'unfrozen');
        expect(resolver.resolveBroadcastRecipients?.('room', unfrozen)).toEqual([]);
        expect(resolver.requiresFrozenAudience(unfrozen)).toBe(true);
        expect(resolver.resolveBroadcastRecipients?.('room', roomBroadcast('alice', 'room.chat', 'members'))).toHaveLength(5);
    });

    it('the resolver resolves no world, all or unicast targets on a granted topic', () => {
        const fixture = createGrantedFixture('live-only');
        const resolver = createWsServerTargetResolver(fixture.socketServer, {
            findGroupSnapshotByRef: () => createSnapshot(),
            grantedTopics: fixture.grantedTopics
        });

        for (const scope of ['world', 'all'] as const) {
            expect(resolver.resolveBroadcastRecipients?.(scope, ungroupedSend(FEED, { mode: 'broadcast', scope }))).toEqual([]);
            expect(resolver.resolveBroadcastRecipients?.(scope, ungroupedSend('app.news', { mode: 'broadcast', scope })))
                .toHaveLength(5);
        }
        expect(resolver.resolvePeerRecipients?.('bob', ungroupedSend(FEED, { mode: 'unicast', toPeerId: 'bob' }))).toEqual([]);
        expect(resolver.resolvePeerRecipients?.('bob', ungroupedSend('app.news', { mode: 'unicast', toPeerId: 'bob' })))
            .toEqual([{ peerId: 'bob', connectionId: 'bob' }]);
    });

    it('a server publish of a granted topic as a world broadcast or a scope-less unicast returns refused unsupported and sends nothing', async () => {
        const recording = createRecordingLiveWsPublication();
        const fixture = createGrantedFixture('live-only', { livePublication: recording.livePublication });
        const scope = { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId };

        const results = [
            await fixture.router.publish({
                message: ungroupedSend(FEED, { mode: 'broadcast', scope: 'world' }, fixture.router.serverPeerId),
                scope,
                producerId: PRODUCER
            }),
            await fixture.router.publish({
                message: ungroupedSend(FEED, { mode: 'unicast', toPeerId: 'bob' }, fixture.router.serverPeerId),
                scope,
                producerId: 'unlisted-producer'
            })
        ];

        expect(results.map((result) => [result.status, result.refusal])).toEqual([
            ['refused', 'unsupported'],
            ['refused', 'unsupported']
        ]);
        expect(recording.notices).toEqual([]);
        await settle();
        expect(readDeliveredBy(fixture, 'ungrouped')).toEqual({ alice: 0, 'alice-2': 0, bob: 0, carol: 0, dan: 0 });
    });

    it('a proxy publishing onto a granted topic through toAll or toPeer is refused and sends nothing', async () => {
        const fixture = createGrantedFixture('live-only');
        const statuses: string[] = [];
        fixture.router.on({ topicId: 'room.chat' }, async (message, context) => {
            const relayed = { ...message.raw, route: { ...message.raw.route, topicId: FEED } };
            statuses.push((await context.proxy.toAll(relayed)).status);
            statuses.push(
                (await context.proxy.toPeer({
                    message: relayed,
                    peerId: 'bob',
                    scope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId }
                })).status
            );
        });

        await fixture.service.acceptIncomingMessage(roomBroadcast('alice', 'room.chat', 'proxy-ungrouped'), 'alice');

        await expect.poll(() => statuses).toEqual(['refused', 'refused']);
        await settle();
        expect(readDelivered(fixture.sockets.bob, 'proxy-ungrouped', FEED)).toBe(0);
        expect(readDelivered(fixture.sockets.carol, 'proxy-ungrouped', FEED)).toBe(0);
    });

    it('a proxy toPeer without a scope still fails', async () => {
        const fixture = createGrantedFixture('live-only');
        const results: RallarServerWsPublishResult[] = [];
        fixture.router.on({ topicId: 'room.chat' }, async (message, context) => {
            results.push(
                await context.proxy.toPeer({
                    message: { ...message.raw, route: { ...message.raw.route, topicId: 'app.news' } },
                    peerId: 'bob'
                } as RallarServerWsUnicastInputDto)
            );
        });

        await fixture.service.acceptIncomingMessage(roomBroadcast('alice', 'room.chat', 'scope-less-peer'), 'alice');

        await expect.poll(() => results.map((result) => result.status)).toEqual(['failed']);
        expect(readDelivered(fixture.sockets.bob, 'scope-less-peer', 'app.news')).toBe(0);
    });

    it('a granted room broadcast with no subscribed session is admitted, reaches no session and its receipt completes with no expected recipients', async () => {
        const fixture = createGrantedFixture('outbox');
        fixture.subscribed.clear();
        const message = { ...roomBroadcast('alice', FEED, 'nobody-subscribed'), delivery: { reliability: 'at-least-once', ack: 'receiver' } } as const;

        expect((await fixture.service.acceptIncomingMessage(message, 'alice')).right).toEqual({ kind: 'admitted' });

        await expect.poll(() => readOriginReceipts(fixture.sockets.alice, 'nobody-subscribed'))
            .toEqual([{ phase: 'admitted', expected: [], confirmed: [] }]);
        await settle();
        expect(readDeliveredBy(fixture, 'nobody-subscribed')).toEqual({ alice: 0, 'alice-2': 0, bob: 0, carol: 0, dan: 0 });
        expect(readNacks(fixture.sockets.alice)).toEqual([]);
    });

    it('a group-leader ack whose leader is not subscribed is NACKed no-leader', async () => {
        const fixture = createGrantedFixture('live-only');
        fixture.snapshots.push(withDirector(createSnapshot(), 'bob'));
        fixture.subscribed.delete('bob');
        const unsubscribedLeader = {
            ...roomBroadcast('alice', FEED, 'to-unsubscribed-leader'),
            delivery: { reliability: 'at-least-once', ack: 'group-leader' }
        } as const;

        const refused = await fixture.service.acceptIncomingMessage(unsubscribedLeader, 'alice');
        fixture.subscribed.add('bob');
        const admitted = await fixture.service.acceptIncomingMessage(
            { ...unsubscribedLeader, id: { ...unsubscribedLeader.id, msgId: 'to-subscribed-leader' } },
            'alice'
        );

        expect(refused.left?.code).toBe('unauthorized');
        await expect.poll(() => readNacks(fixture.sockets.alice)).toEqual([{ msgId: 'to-unsubscribed-leader', reason: 'no-leader' }]);
        expect(admitted.right).toEqual({ kind: 'admitted' });
        await expect.poll(() => readDelivered(fixture.sockets.bob, 'to-subscribed-leader')).toBe(1);
        expect(readDelivered(fixture.sockets.bob, 'to-unsubscribed-leader')).toBe(0);
    });

    it('a room unicast to an unsubscribed session is NACKed unauthorized', async () => {
        const fixture = createGrantedFixture('live-only');
        fixture.subscribed.delete('bob');
        const toBob = { ...roomBroadcast('alice', FEED, 'unicast-to-bob'), targets: { mode: 'unicast', toPeerId: 'bob', groupRef: ROOM } } as const;

        const refused = await fixture.service.acceptIncomingMessage(toBob, 'alice');

        expect(refused.left?.code).toBe('unauthorized');
        await expect.poll(() => readNacks(fixture.sockets.alice)).toEqual([{ msgId: 'unicast-to-bob', reason: 'unauthorized' }]);
        await settle();
        expect(readDelivered(fixture.sockets.bob, 'unicast-to-bob')).toBe(0);
    });

    it('a server producer\'s publication reaches subscribed sessions only', async () => {
        const fixture = createGrantedFixture('live-only');
        fixture.subscribed.clear();
        fixture.subscribed.add('alice').add('bob').add('carol');

        const result = await fixture.router.publish({
            message: roomBroadcast(fixture.router.serverPeerId, FEED, 'produced-for-subscribers'),
            producerId: PRODUCER
        });

        expect(result.status).toBe('sent-live');
        expect(readDeliveredBy(fixture, 'produced-for-subscribers')).toEqual({ alice: 1, 'alice-2': 0, bob: 1, carol: 0, dan: 0 });
    });

    it('a proxy relay reaches subscribed sessions only', async () => {
        const fixture = createGrantedFixture('live-only');
        relayChatOntoFeed(fixture);
        fixture.subscribed.clear();
        fixture.subscribed.add('bob');

        await fixture.service.acceptIncomingMessage(roomBroadcast('alice', 'room.chat', 'relay-for-subscribers'), 'alice');

        await expect.poll(() => readDelivered(fixture.sockets.bob, 'relay-for-subscribers', FEED)).toBe(1);
        await settle();
        expect(readDelivered(fixture.sockets['alice-2'], 'relay-for-subscribers', FEED)).toBe(0);
        expect(readDelivered(fixture.sockets.dan, 'relay-for-subscribers', FEED)).toBe(0);
    });

    it('a demoted spectator keeps subscribe and is refused publish', async () => {
        const fixture = createGrantedFixture('live-only');

        const refused = await fixture.service.acceptIncomingMessage(roomBroadcast('dan', FEED, 'from-spectator'), 'dan');
        await fixture.service.acceptIncomingMessage(roomBroadcast('alice', FEED, 'to-spectator'), 'alice');

        expect(refused.left?.code).toBe('unauthorized');
        await expect.poll(() => readNacks(fixture.sockets.dan)).toEqual([{ msgId: 'from-spectator', reason: 'no-publish-grant' }]);
        await expect.poll(() => readDelivered(fixture.sockets.dan, 'to-spectator')).toBe(1);
        expect(readDelivered(fixture.sockets.bob, 'from-spectator')).toBe(0);
    });
});

interface GrantedFixtureOptions {
    readonly livePublication?: RallarServerWsRouterOptions['livePublication'];
    /** False leaves the router without a server publish audience reader, as a members-only composition is built. */
    readonly composesServerPublishAudience?: boolean;
}

function createGrantedFixture(fanout: RallarServerWsFanout, options: GrantedFixtureOptions = {}): GrantedFixture {
    const socketServer = new JsonWebSocketServer();
    const sockets = Object.fromEntries(
        (Object.keys(SESSIONS) as SessionId[]).map((sessionId) => [sessionId, new TestWebSocket(`ws://${sessionId}`)])
    ) as Record<SessionId, TestWebSocket>;
    for (const [sessionId, socket] of Object.entries(sockets)) {
        socket.open();
        socketServer.addConnection(new ConnectionContext({ id: sessionId, socket }));
    }
    const grantedTopics = new WsGrantedTopicSet();
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeWsQueueBoxServerPreparedMessage });
    const snapshots: GroupSnapshot[] = [];
    const readSnapshot = (): GroupSnapshot => snapshots.length > 1 ? snapshots.shift()! : snapshots[0] ?? createSnapshot();
    const subscribed = new Set(Object.keys(SESSIONS) as SessionId[]);
    const readPublicationAuthority = async (_ref: GroupRef, topicId: string) => toSubscribedAuthority(readSnapshot(), topicId, subscribed);
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        outbox: outboundStores.workQueue,
        outboundStores,
        socket: socketServer,
        name: 'server-1',
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: () => ({
            scope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId },
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER
        }),
        targetResolver: createWsServerTargetResolver(socketServer, { findGroupSnapshotByRef: () => createSnapshot(), grantedTopics })
    });
    onTestFinished(() => service.dispose());
    const authorizations: RallarServerWsRoomAuthorizationInput[] = [];
    const authorizeGroupRoom = createGroupRoomWsAuthorizer({
        readGroupSnapshot: () => readSnapshot(),
        readPublicationAuthority,
        readPreActivationAppData: () => 'allowed',
        nowEpochMs: Date.now
    });
    const router = new RallarServerWsRouter(service, {
        grantedTopics,
        authorizeRoomMessage: (input) => {
            authorizations.push(input);
            return authorizeGroupRoom(input);
        },
        readServerPublishAudience: options.composesServerPublishAudience === false
            ? undefined
            : createServerPublishRoomAudienceReader({
                readGroupSnapshot: () => Promise.resolve(readSnapshot()),
                readPublicationAuthority,
                nowEpochMs: Date.now
            }),
        livePublication: options.livePublication
    }).install().defineTopic({
        topicId: FEED,
        scope: 'room',
        participation: 'granted',
        serverProducerIds: [PRODUCER],
        fanout
    });
    return { service, router, socketServer, grantedTopics, outboundStores, sockets, authorizations, snapshots, subscribed };
}

/** Each subscribed session's live row on the topic, asserted by its one live client generation. */
function toSubscribedAuthority(
    snapshot: GroupSnapshot,
    topicId: string,
    subscribed: ReadonlySet<SessionId>
): GroupPublicationAuthority {
    const sessionIds = [...subscribed];
    return {
        snapshot,
        subscriptions: sessionIds.map((sessionId): GroupTopicSubscription => ({
            sessionId,
            principalId: SESSIONS[sessionId],
            topicId,
            connectionGenerationId: `client-generation-${sessionId}`,
            leaseExpiresAtEpochMs: Date.now() + 120_000,
            admittedAtGroupRevision: snapshot.group.snapshotVersion
        })),
        liveSessionGenerations: Object.fromEntries(sessionIds.map((sessionId) => [sessionId, [`client-generation-${sessionId}`]]))
    };
}

function withDirector(snapshot: GroupSnapshot, sessionId: SessionId): GroupSnapshot {
    const appointment = createRallarGroupDirectorAppointment({ session: { clientId: SESSIONS[sessionId], sessionId }, now: Date.now() });
    return { ...snapshot, group: { ...snapshot.group, metadata: mergeRallarGroupDirectorMetadata(snapshot.group.metadata, appointment) } };
}

function relayChatOntoFeed(fixture: GrantedFixture): void {
    fixture.router.proxy({
        id: 'chat-to-feed',
        from: { topicId: 'room.chat' },
        transform: (message) => ({ ...message.raw, route: { ...message.raw.route, topicId: FEED } })
    });
}

/** The room with every session live; `overrides` replaces a principal's grant (undefined removes it). */
function createSnapshot(
    overrides: Readonly<Record<string, GroupPublicationTopicPermissions | undefined>> = {}
): GroupSnapshot {
    const principalIds = [...new Set(Object.values(SESSIONS))];
    const grants = { ...GRANTS, ...overrides };
    const group = createTestGroup({ ...ROOM, snapshotVersion: 3, presenceVersion: 1, activeMemberCount: principalIds.length });
    return {
        causalRevision: { groupRevision: 3, presenceRevision: 1 },
        group,
        members: principalIds.map((principalId): GroupMember => ({
            ...ROOM,
            principalId,
            role: principalId === 'alice' ? 'owner' : principalId === 'dan' ? 'spectator' : 'member',
            status: 'active',
            joined: group.created,
            updated: group.updated,
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        })),
        activeSessions: (Object.entries(SESSIONS) as [SessionId, string][]).map(([sessionId, principalId]): GroupPresenceSession => ({
            ...ROOM,
            principalId,
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
            .sort(([left], [right]) => left < right ? -1 : 1)
            .map(([principalId, permissions]) => ({ ...ROOM, principalId, topics: { [FEED]: permissions }, updated: group.updated }))
    };
}

function roomBroadcast(senderId: string, topicId: string, msgId: string): ALMessage {
    const base = newALBroadcastMessage(senderId, newALEventRoute(topicId, ROOM.groupId, msgId), 'room', 'feed.v1', { msgId }, {
        groupRef: ROOM,
        ttlMs: 30_000
    });
    return { ...base, id: { ...base.id, msgId } };
}

/** A send that names no room: a world or all broadcast, or a unicast without a GroupRef. */
function ungroupedSend(topicId: string, targets: ALTargets, senderId = 'alice'): ALMessage {
    const base = newALBroadcastMessage(senderId, newALEventRoute(topicId, 'world', 'ungrouped'), 'world', 'feed.v1', {});
    return { ...base, id: { ...base.id, msgId: 'ungrouped' }, targets };
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
}

function readDelivered(socket: TestWebSocket, msgId: string, topicId?: string): number {
    return socket.sent.map(decodePersistedALMessage)
        .filter((sent) => sent.id.msgId === msgId && (topicId === undefined || sent.route.topicId === topicId)).length;
}

function readDeliveredBy(fixture: GrantedFixture, msgId: string): Readonly<Record<SessionId, number>> {
    return Object.fromEntries(
        Object.entries(fixture.sockets).map(([sessionId, socket]) => [sessionId, readDelivered(socket, msgId)])
    ) as Record<SessionId, number>;
}

function readOriginReceipts(socket: TestWebSocket, msgId: string) {
    return socket.sent.map(decodePersistedALMessage).flatMap((sent) => {
        const control = parseALControlMessage(sent);
        return control?.type === 'receipt' && control.payload.msgId === msgId
            ? [{ phase: control.payload.phase, expected: control.payload.expectedRecipientPeerIds, confirmed: control.payload.confirmedRecipientPeerIds }]
            : [];
    });
}

function readNacks(socket: TestWebSocket): readonly Readonly<{ msgId: string; reason: string; }>[] {
    return socket.sent.map(decodePersistedALMessage).flatMap((sent) => {
        const control = parseALControlMessage(sent);
        return control?.type === 'nack' ? [{ msgId: control.payload.msgId, reason: control.payload.reason }] : [];
    });
}

async function readOutboxRowCount(fixture: GrantedFixture, msgId: string): Promise<number> {
    const workQueue = fixture.outboundStores.workQueue;
    const rows = await Promise.all((await workQueue.getAllKeys()).map((key) => workQueue.getItem(key)));
    return rows.filter((row) => row?.resource.includes(msgId) === true && !row.resource.includes('al.control')).length;
}
