import { describe, expect, it, onTestFinished } from 'vitest';

import { publishRallarServerWsMessage } from '@shared-server/rallar-system/websocket/router/publish-rallar-server-ws-message.ts';
import { readRallarServerWsPublicationAudience } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-publication-audience.ts';
import type {
    RallarServerWsPublishAudienceReader,
    RallarServerWsRoomAudience,
    RallarServerWsRoomAuthorizationInput
} from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { drainEngine } from '../../../../shared/alm/outbound-runtime-test-fixture.ts';
import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const NOTIFICATION = newALBroadcastMessage(
    'server',
    newALRoute('room.snapshot', 'room-1', 'round-1'),
    'room',
    'snapshot.v1',
    {},
    {
        groupRef: ROOM,
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: 15_000
    }
);
const AUDIENCE: RallarServerWsRoomAudience = {
    targets: NOTIFICATION.targets!,
    sessions: [liveSession('b'), liveSession('c')],
    snapshotVersion: 4
};

describe('the audience a server or proxy publish is frozen to', () => {
    it('reads the room audience of the server\'s own outbox room notification', async () => {
        const reader = createAudienceReader();

        const audience = await readRallarServerWsPublicationAudience({
            message: NOTIFICATION,
            fanout: 'outbox',
            origin: 'server',
            authorizeRoomMessage: undefined,
            readServerPublishAudience: reader.read
        });

        expect(audience.right?.frozen).toBe(AUDIENCE);
        expect(reader.reads).toEqual([NOTIFICATION]);
    });

    it.each<[string, ALMessage, 'outbox' | 'live-only']>([
        ['a live-only publish', NOTIFICATION, 'live-only'],
        ['a notification another sender publishes', {
            ...NOTIFICATION,
            id: { ...NOTIFICATION.id, senderId: 'relic-hunter-server' }
        }, 'outbox']
    ])('also freezes %s that names its room', async (_name, message, fanout) => {
        const reader = createAudienceReader();

        const audience = await readRallarServerWsPublicationAudience({
            message,
            fanout,
            origin: 'server',
            authorizeRoomMessage: undefined,
            readServerPublishAudience: reader.read
        });

        expect(audience.right?.frozen).toBe(AUDIENCE);
        expect(reader.reads).toEqual([message]);
    });

    it.each<[string, ALMessage, 'outbox' | 'none', 'server' | 'admitted']>([
        [
            'a world broadcast',
            { ...NOTIFICATION, targets: { mode: 'broadcast', scope: 'world' } },
            'outbox',
            'server'
        ],
        ['a publish with fanout none', NOTIFICATION, 'none', 'server'],
        [
            'an admitted client message, which carries the audience it was admitted to',
            NOTIFICATION,
            'outbox',
            'admitted'
        ]
    ])('reads no audience for %s', async (_name, message, fanout, origin) => {
        const reader = createAudienceReader();
        const authorizations: RallarServerWsRoomAuthorizationInput[] = [];

        expect(
            await readRallarServerWsPublicationAudience({
                message,
                fanout,
                origin,
                authorizeRoomMessage: (input) => {
                    authorizations.push(input);
                    return { authorized: true, audience: AUDIENCE };
                },
                readServerPublishAudience: reader.read
            })
        ).toEqual({ right: { frozen: undefined } });
        expect(reader.reads).toEqual([]);
        expect(authorizations).toEqual([]);
    });

    it('freezes nothing when the router has no audience reader or the room has none to read', async () => {
        expect(
            await readRallarServerWsPublicationAudience({
                message: NOTIFICATION,
                fanout: 'outbox',
                origin: 'server',
                authorizeRoomMessage: undefined,
                readServerPublishAudience: undefined
            })
        ).toEqual({ right: { frozen: undefined } });
        expect(
            await readRallarServerWsPublicationAudience({
                message: NOTIFICATION,
                fanout: 'outbox',
                origin: 'server',
                authorizeRoomMessage: undefined,
                readServerPublishAudience: async () => undefined
            })
        ).toEqual({ right: { frozen: undefined } });
    });

    it('freezes a proxy publish to the audience the room authorizer grants, and refuses it when the authorizer does', async () => {
        const reader = createAudienceReader();
        const read = (authorized: boolean) =>
            readRallarServerWsPublicationAudience({
                message: NOTIFICATION,
                fanout: 'outbox',
                origin: 'proxy',
                authorizeRoomMessage: () =>
                    authorized
                        ? { authorized: true, audience: AUDIENCE }
                        : { authorized: false, logMessage: 'not a member of room-1' },
                readServerPublishAudience: reader.read
            });

        expect(await read(true)).toEqual({ right: { frozen: AUDIENCE } });
        expect(await read(false)).toEqual({ left: 'not a member of room-1' });
        expect(reader.reads).toEqual([]);
    });

    it.each<'outbox' | 'live-only'>(['outbox', 'live-only'])(
        'fails a %s proxy publish the room authorizer refuses and sends nothing',
        async (fanout) => {
            const fixture = createServerFixture(['b', 'c']);

            const result = await publishRallarServerWsMessage({
                service: fixture.service,
                message: NOTIFICATION,
                fanout,
                nowEpochMs: Date.now(),
                origin: 'proxy',
                authorizeRoomMessage: () => ({ authorized: false, logMessage: 'not a member of room-1' })
            });
            await drainEngine(fixture.engine);

            expect(result).toMatchObject({ status: 'failed', reason: 'not a member of room-1' });
            expect(fixture.sockets.get('b')!.sent).toEqual([]);
            expect(fixture.sockets.get('c')!.sent).toEqual([]);
            expect(await fixture.store.readReceiptState({ originPeerId: 'server', msgId: NOTIFICATION.id.msgId }))
                .toBeUndefined();
        }
    );

    it('sends the server\'s outbox room notification to the frozen sessions only, and its receipt expects exactly them', async () => {
        const fixture = createServerFixture(['b', 'c', 'late-joiner']);
        const router = new RallarServerWsRouter(fixture.service, {
            nowEpochMs: Date.now,
            readServerPublishAudience: async () => AUDIENCE
        });

        const result = await router.publish({ message: NOTIFICATION, fanout: 'outbox' });
        await drainEngine(fixture.engine);
        await expect.poll(() => fixture.sockets.get('c')!.sent.length).toBe(1);

        expect(result.status).toBe('queued-outbox');
        expect(fixture.sockets.get('b')!.sent).toHaveLength(1);
        expect(fixture.sockets.get('late-joiner')!.sent).toEqual([]);
        expect(
            await fixture.store.readReceiptState({
                originPeerId: 'server',
                msgId: NOTIFICATION.id.msgId
            })
        )
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b', 'c'], ackedPeerIds: [] });
    });
});

interface ServerFixture {
    readonly service: WsQueueBoxServerService;
    readonly store: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>;
    readonly engine: InboxOutboxEngine;
    readonly sockets: ReadonlyMap<string, TestWebSocket>;
}

/** One server whose room resolves every session named here, each on its own open connection. */
function createServerFixture(roomPeerIds: readonly string[]): ServerFixture {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    const store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'ws-publication-audience',
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
        namespace: 'ws-publication-audience',
        backend,
        supersedenceTrackTtlMs: 300_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const server = new JsonWebSocketServer();
    const sockets = new Map<string, TestWebSocket>();
    for (const peerId of roomPeerIds) {
        const native = new TestWebSocket(`ws://${peerId}`);
        native.open();
        server.addConnection(new ConnectionContext({ id: peerId, socket: native }));
        sockets.set(peerId, native);
    }
    const roomRecipients = roomPeerIds.map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        readAuthenticatedConnectionScope: () => undefined,
        name: 'server',
        socket: server,
        outbox: backend.workQueue,
        outboundStores: { admissionStore: store, workQueue: backend.workQueue },
        queueEngine: engine,
        targetResolver: { resolveGroupRecipients: () => roomRecipients }
    });
    onTestFinished(() => service.dispose());
    return { service, store, engine, sockets };
}

interface AudienceReader {
    readonly reads: ALMessage[];
    readonly read: RallarServerWsPublishAudienceReader;
}

function createAudienceReader(): AudienceReader {
    const reads: ALMessage[] = [];
    return {
        reads,
        read: async (message) => {
            reads.push(message);
            return AUDIENCE;
        }
    };
}

function liveSession(sessionId: string): GroupPresenceSession {
    return {
        ...ROOM,
        sessionId,
        principalId: `principal-${sessionId}`,
        generationId: `generation-${sessionId}`,
        generationVersion: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 4_000_000_000_000,
        status: 'active',
        disconnectReason: null,
        disconnectedAtEpochMs: null
    };
}
