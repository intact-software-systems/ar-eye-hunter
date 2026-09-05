import assert from 'node:assert/strict';

import type { GroupLifecyclePolicyRead } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALBroadcastMessage, newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupMember, GroupPresenceSession } from '@shared/api/group-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import { createOpenTestWebSocket } from '../../../../packages/tests/shared-server/rallar-system/websocket/test-support/open-test-websocket.ts';
import { createApiV1RoomWsAuthorizer } from '../../src/services/ws-topic-room-authorizer.ts';

interface RoomDeliveryState {
    current: GroupSnapshot | undefined;
    cached: GroupSnapshot | undefined;
    policy: GroupLifecyclePolicyRead;
    authorityReads: number;
}

interface RoomDeliveryHarness {
    readonly state: RoomDeliveryState;
    readonly server: JsonWebSocketServer;
    readonly service: WsQueueBoxServerService;
    readonly router: RallarServerWsRouter;
    readonly outbox: InMemoryQueueBox;
}

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

for (const cacheState of ['absent', 'before-presence', 'wrong-scope'] as const) {
    Deno.test(`room live delivery uses current authority with ${cacheState} local cache`, async () => {
        const harness = createRoomDeliveryHarness();
        const snapshot = createRoomSnapshot();
        harness.state.cached = cacheState === 'absent' ? undefined : {
            ...snapshot,
            group: { ...snapshot.group, workspaceId: cacheState === 'wrong-scope' ? 'other-workspace' : ROOM.workspaceId },
            causalRevision: { groupRevision: 2, presenceRevision: 0 },
            activeSessions: [],
            onlineMemberCount: 0
        };
        const cachedBefore = harness.state.cached;
        const senderFrames = addRecordingConnection(harness.server, 'alice');
        const recipientFrames = addRecordingConnection(harness.server, 'bob');
        const outsiderFrames = addRecordingConnection(harness.server, 'outsider');
        const message = roomMessage();

        await harness.router.route(message);

        assert.deepEqual(senderFrames, [JSON.stringify(message)]);
        assert.deepEqual(recipientFrames, [JSON.stringify(message)]);
        assert.deepEqual(outsiderFrames, []);
        assert.equal(harness.state.authorityReads, 1);
        assert.equal(harness.state.cached, cachedBefore);
        assert.deepEqual(await harness.outbox.getAllKeys(), []);
    });
}

Deno.test('room delivery excludes revoked or expired recipients even when cache and sockets retain them', async () => {
    for (const revocation of ['member', 'session', 'expiry'] as const) {
        const harness = createRoomDeliveryHarness();
        const snapshot = createRoomSnapshot();
        harness.state.current = {
            ...snapshot,
            members: snapshot.members.map((member): GroupMember =>
                member.principalId === 'bob' && revocation === 'member'
                    ? { ...member, status: 'removed', removed: snapshot.group.updated, left: null, banned: null }
                    : member
            ),
            activeSessions: snapshot.activeSessions.filter((session) => revocation !== 'session' || session.sessionId !== 'bob')
                .map((session): GroupPresenceSession =>
                    session.sessionId === 'bob' && revocation === 'expiry'
                        ? { ...session, expiresAtEpochMs: 1 }
                        : session
                )
        };
        const senderFrames = addRecordingConnection(harness.server, 'alice');
        const revokedFrames = addRecordingConnection(harness.server, 'bob');
        const message = roomMessage();

        await harness.router.route(message);

        assert.deepEqual(senderFrames, [JSON.stringify(message)]);
        assert.deepEqual(revokedFrames, []);
    }
});

Deno.test('current room denial emits the existing NACK without using a permissive recipient cache', async () => {
    for (const denial of ['missing', 'scope', 'group', 'member', 'session', 'version', 'policy', 'halted'] as const) {
        const harness = createRoomDeliveryHarness();
        const snapshot = createRoomSnapshot();
        harness.state.current = denial === 'missing' ? undefined : {
            ...snapshot,
            group: {
                ...snapshot.group,
                workspaceId: denial === 'scope' ? 'wrong-workspace' : ROOM.workspaceId,
                groupId: denial === 'group' ? 'wrong-room' : ROOM.groupId,
                lifecycleState: denial === 'policy' ? 'forming' : 'active',
                transportState: denial === 'halted' ? 'halted' : 'flowing'
            },
            members: snapshot.members.map((member): GroupMember =>
                member.principalId === 'alice' && denial === 'member'
                    ? { ...member, status: 'banned', banned: snapshot.group.updated, left: null, removed: null }
                    : member
            ),
            activeSessions: denial === 'session' ? snapshot.activeSessions.filter((session) => session.sessionId !== 'alice') : snapshot.activeSessions
        };
        harness.state.policy = { status: 'present', policy: resolveGroupLifecyclePolicyPreset('match') };
        const senderFrames = addRecordingConnection(harness.server, 'alice');
        const recipientFrames = addRecordingConnection(harness.server, 'bob');
        const message = roomMessage(denial === 'version' ? 3 : undefined);

        await harness.router.route(message);

        assert.equal(senderFrames.length, 1);
        const nack = decodePersistedALMessage(senderFrames[0]!);
        assert.notEqual(nack.route.topicId, 'room.chat');
        assert.match(nack.payload.resource, /unauthorized|not-yet-in-sync/);
        assert.deepEqual(recipientFrames, []);
        assert.deepEqual(await harness.outbox.getAllKeys(), []);
    }
});

Deno.test('room broadcast exclusions preserve an empty authoritative audience without cache fallback', async () => {
    const harness = createRoomDeliveryHarness();
    const snapshot = createRoomSnapshot();
    harness.state.current = { ...snapshot, activeSessions: snapshot.activeSessions.filter((session) => session.sessionId === 'alice') };
    const senderFrames = addRecordingConnection(harness.server, 'alice');
    const staleFrames = addRecordingConnection(harness.server, 'bob');
    const message = newALBroadcastMessage('alice', newALEventRoute('room.chat', ROOM.groupId, 'excluded'), 'room', 'chat.message.v1', { text: 'hello' }, {
        groupRef: ROOM,
        exceptPeerIds: ['alice']
    });

    await harness.router.route(message);

    assert.deepEqual(senderFrames, []);
    assert.deepEqual(staleFrames, []);
    assert.deepEqual(await harness.outbox.getAllKeys(), []);
});

Deno.test('room reconnect delivers to the current open socket and ignores delayed old-generation close', async () => {
    const harness = createRoomDeliveryHarness();
    harness.state.cached = undefined;
    const oldSocket = createOpenTestWebSocket();
    const oldFrames: string[] = [];
    oldSocket.send = (frame) => oldFrames.push(String(frame));
    harness.server.addConnection(new ConnectionContext({ id: 'bob', socket: oldSocket }));
    const currentFrames = addRecordingConnection(harness.server, 'bob');
    oldSocket.dispatchEvent(new CloseEvent('close'));
    const message = roomMessage();

    await harness.router.route(message);

    assert.deepEqual(oldFrames, []);
    assert.deepEqual(currentFrames, [JSON.stringify(message)]);
    harness.server.connections.delete('bob');
    await harness.router.route(message);
    assert.deepEqual(currentFrames, [JSON.stringify(message)]);
});

Deno.test('transformed proxy targets never inherit the source room authoritative audience', async () => {
    const harness = createRoomDeliveryHarness();
    harness.state.cached = undefined;
    const sourceFrames = addRecordingConnection(harness.server, 'alice');
    const proxyFrames = addRecordingConnection(harness.server, 'outsider');
    harness.router.proxy({
        from: { topicId: 'room.chat' },
        targets: () => ({ mode: 'unicast', toPeerId: 'outsider' }),
        suppressDefaultFanout: true
    });
    const message = roomMessage();

    await harness.router.route(message);

    assert.deepEqual(sourceFrames, []);
    assert.deepEqual(proxyFrames, [JSON.stringify({ ...message, targets: { mode: 'unicast', toPeerId: 'outsider' } })]);
});

Deno.test('generic custom authorization retains its explicit resolver-owned audience', async () => {
    for (const decision of [true, { authorized: true }] as const) {
        const harness = createRoomDeliveryHarness();
        const frames = addRecordingConnection(harness.server, 'bob');
        const router = new RallarServerWsRouter(harness.service, { authorizeRoomMessage: () => decision });
        const message = roomMessage();

        await router.route(message);

        assert.deepEqual(frames, [JSON.stringify(message)]);
        assert.equal(harness.state.authorityReads, 0);
    }
});

Deno.test('room delivery rechecks session expiry and open sockets after awaited handlers', async () => {
    let nowEpochMs = Date.now();
    const harness = createRoomDeliveryHarness(() => nowEpochMs);
    const senderFrames = addRecordingConnection(harness.server, 'alice');
    const recipientFrames = addRecordingConnection(harness.server, 'bob');
    harness.router.on({ topicId: 'room.chat' }, async () => {
        await Promise.resolve();
        nowEpochMs = 4_000_000_000_001;
        harness.server.connections.delete('bob');
    });

    await harness.router.route(roomMessage());

    assert.deepEqual(senderFrames, []);
    assert.deepEqual(recipientFrames, []);
    assert.equal(harness.state.authorityReads, 1);
});

Deno.test('a handler cannot reuse room authority after changing the target scope or exclusions', async () => {
    for (const mutation of ['scope', 'exclusions'] as const) {
        const harness = createRoomDeliveryHarness();
        const frames = addRecordingConnection(harness.server, 'bob');
        harness.router.on({ topicId: 'room.chat' }, async (message) => {
            await Promise.resolve();
            assert.equal(message.raw.targets?.mode, 'broadcast');
            Object.assign(
                message.raw.targets!,
                mutation === 'scope'
                    ? { groupRef: { ...ROOM, workspaceId: 'other-workspace' } }
                    : { exceptPeerIds: [] }
            );
        });
        const message = newALBroadcastMessage('alice', newALEventRoute('room.chat', ROOM.groupId, 'changed-target'), 'room', 'chat.message.v1', {
            text: 'hello'
        }, {
            groupRef: ROOM,
            exceptPeerIds: ['bob']
        });

        await harness.router.route(message);

        assert.deepEqual(frames, []);
    }
});

Deno.test('a socket closed during an awaited handler receives no authoritative live frame', async () => {
    const harness = createRoomDeliveryHarness();
    const socket = createOpenTestWebSocket();
    let readyState: number = WebSocket.OPEN;
    Object.defineProperty(socket, 'readyState', { get: () => readyState });
    const frames: string[] = [];
    socket.send = (frame) => frames.push(String(frame));
    harness.server.addConnection(new ConnectionContext({ id: 'bob', socket }));
    harness.router.on({ topicId: 'room.chat' }, async () => {
        await Promise.resolve();
        readyState = WebSocket.CLOSED;
    });

    await harness.router.route(roomMessage());

    assert.deepEqual(frames, []);
    assert.equal(harness.state.authorityReads, 1);
});

function createRoomDeliveryHarness(nowEpochMs?: () => number): RoomDeliveryHarness {
    const state: RoomDeliveryState = {
        current: createRoomSnapshot(),
        cached: createRoomSnapshot(),
        policy: { status: 'absent' },
        authorityReads: 0
    };
    const server = new JsonWebSocketServer();
    const outbox = new InMemoryQueueBox();
    const service = createDefaultWsQueueBoxServerService({
        inbox: new InMemoryQueueBox(),
        outbox,
        socket: server,
        name: 'room-authority-delivery',
        forwardsRoomScopedMessages: false,
        targetResolver: createWsServerTargetResolver(server, { findGroupSnapshotByRef: () => state.cached })
    });
    const authorizeRoomMessage = createApiV1RoomWsAuthorizer({
        readCurrentSnapshot: (ref) => {
            assert.deepEqual(ref, ROOM);
            state.authorityReads += 1;
            return Promise.resolve(state.current);
        }
    }, { readLifecyclePolicy: () => Promise.resolve(state.policy) });
    const router = new RallarServerWsRouter(service, { authorizeRoomMessage, nowEpochMs });
    return { state, server, service, router, outbox };
}

function addRecordingConnection(server: JsonWebSocketServer, sessionId: string): string[] {
    const frames: string[] = [];
    const socket = createOpenTestWebSocket();
    socket.send = (frame) => {
        assert.equal(typeof frame, 'string');
        frames.push(String(frame));
    };
    server.addConnection(new ConnectionContext({ id: sessionId, socket }));
    return frames;
}

function roomMessage(minSnapshotVersion?: number): ALMessage {
    return newALMulticastMessage('alice', newALEventRoute('room.chat', ROOM.groupId, 'room-delivery'), ROOM, 'chat.message.v1', { text: 'hello' }, {
        minSnapshotVersion,
        reliability: 'best-effort',
        ack: 'none'
    });
}

function createRoomSnapshot(): GroupSnapshot {
    const group = createTestGroup({ ...ROOM, snapshotVersion: 2, presenceVersion: 1, activeMemberCount: 2 });
    return {
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        group,
        members: ['alice', 'bob'].map((principalId): GroupMember => ({
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
        activeSessions: ['alice', 'bob'].map((sessionId): GroupPresenceSession => ({
            ...ROOM,
            principalId: sessionId,
            sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 2,
            expiresAtEpochMs: 4_000_000_000_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: 2,
        onlineMemberCount: 2
    };
}
