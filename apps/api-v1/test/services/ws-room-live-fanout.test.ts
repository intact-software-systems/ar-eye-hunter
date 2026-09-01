import assert from 'node:assert/strict';

import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import {
    newALBroadcastMessage,
    newALEventRoute,
    newALMulticastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { findGroupStateSnapshotByRef } from '@shared/repository/group-state-snapshots-repository.ts';
import { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';

import { createGroupSnapshot } from '../../../../packages/tests/shared-server/rallar-system/group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import { createOpenTestWebSocket } from '../../../../packages/tests/shared-server/rallar-system/websocket/test-support/open-test-websocket.ts';
import { createApiV1RoomWsAuthorizer } from '../../src/services/ws-topic-room-authorizer.ts';
import {
    createRoomStateTestRuntime,
    putRoomSnapshot,
    type RoomStateTestRuntime
} from './ws-room-test-runtime.ts';

interface RoomLiveSend {
    readonly sessionId: string;
    readonly encoded: string;
}

interface RoomDeliveryClock {
    atEpochMs: number;
}

interface LiveRoomTestRuntime extends RoomStateTestRuntime {
    readonly router: RallarServerWsRouter;
    readonly service: WsQueueBoxServerService;
    readonly socket: JsonWebSocketServer;
    readonly sent: RoomLiveSend[];
    readonly deliveryClock: RoomDeliveryClock;
}

for (const cacheState of ['cold', 'older-empty', 'same-tuple-expired'] as const) {
    Deno.test(`API authorized room fanout survives ${cacheState} cache`, async () => {
        const snapshot = createGroupSnapshot(2, ['session-1', 'session-2']);
        const runtime = createLiveRoomRuntime();
        await putRoomSnapshot(runtime.repository, snapshot);
        const cached = cacheState === 'cold' ? undefined : cacheState === 'older-empty'
            ? createGroupSnapshot(1, [])
            : {
                ...snapshot,
                activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: 1 }))
            };
        if (cached) {
            assert.equal(runtime.cache.observe(cached), 'inserted');
            if (cacheState === 'same-tuple-expired') {
                assert.equal(runtime.cache.observe(snapshot), 'duplicate');
            }
        }
        const message = roomMessage(snapshot);
        try {
            await runtime.router.route(message);
            assert.deepEqual(runtime.sent.map((send) => send.sessionId), [
                'session-1',
                'session-2'
            ]);
            assert.ok(runtime.sent.every((send) => send.encoded === JSON.stringify(message)));
            assert.equal(runtime.reads.snapshots, 1);
            assert.equal(runtime.reads.revisions, 0);
            assert.deepEqual(findGroupStateSnapshotByRef(snapshot.group, runtime.manager), cached);
        }
        finally {
            await runtime.manager.clear();
        }
    });
}

Deno.test('API authorized broadcast keeps exclusions and closed connections out of the live audience', async () => {
    const snapshot = createGroupSnapshot(2, ['closed-session', 'session-1', 'session-2']);
    const runtime = createLiveRoomRuntime();
    await putRoomSnapshot(runtime.repository, snapshot);
    const closedSocket = createOpenTestWebSocket();
    Object.defineProperty(closedSocket, 'readyState', { value: WebSocket.CLOSED });
    runtime.socket.addConnection(new ConnectionContext('closed-session', closedSocket));
    const message = newALBroadcastMessage(
        'session-1',
        newALEventRoute('room.chat', 'group-1', 'broadcast-1'),
        'room',
        'chat.message.v1',
        { text: 'hello' },
        { groupRef: snapshot.group, exceptPeerIds: ['session-1'] }
    );
    try {
        await runtime.router.route(message);
        assert.deepEqual(runtime.sent, [{ sessionId: 'session-2', encoded: JSON.stringify(message) }]);
    }
    finally {
        await runtime.manager.clear();
    }
});

Deno.test('authorized room authority requires the exact application, workspace, and room identity', async () => {
    const snapshot = createGroupSnapshot(2, ['session-1', 'session-2']);
    const runtime = createLiveRoomRuntime();
    await putRoomSnapshot(runtime.repository, snapshot);
    try {
        for (
            const groupRef of [
                { ...snapshot.group, applicationId: 'other-app' },
                { ...snapshot.group, workspaceId: 'other-workspace' },
                { ...snapshot.group, groupId: 'other-room' }
            ]
        ) {
            const message = { ...roomMessage(snapshot), targets: { mode: 'multicast' as const, groupRef } };
            await runtime.router.route(message);
        }
        assert.deepEqual(
            runtime.sent.filter((send) => decodePersistedALMessage(send.encoded).route.topicId === 'room.chat'),
            []
        );
    }
    finally {
        await runtime.manager.clear();
    }
});

Deno.test('room authority checks leases again after asynchronous topic handlers', async () => {
    const snapshot = createGroupSnapshot(2, ['session-1', 'session-2']);
    const runtime = createLiveRoomRuntime();
    await putRoomSnapshot(runtime.repository, snapshot);
    runtime.router.on({ topicId: 'room.chat' }, async () => {
        await Promise.resolve();
        runtime.deliveryClock.atEpochMs = 4_000_000_000_000;
    });
    try {
        await runtime.router.route(roomMessage(snapshot));
        assert.deepEqual(runtime.sent, []);
        assert.equal(runtime.reads.snapshots, 1);
    }
    finally {
        await runtime.manager.clear();
    }
});

Deno.test('same-tuple authoritative disconnect removes a recipient despite the cached summary', async () => {
    const snapshot = createGroupSnapshot(2, ['session-1', 'session-2']);
    const runtime = createLiveRoomRuntime();
    await putRoomSnapshot(runtime.repository, snapshot);
    runtime.cache.observe(snapshot);
    const presence = await runtime.repository.findPresenceEntry({ ...snapshot.group, sessionId: 'session-2' });
    assert.ok(presence);
    assert.equal(
        (await runtime.repository.updatePresence({
            ...presence.value,
            status: 'disconnected',
            disconnectedAtEpochMs: Date.now(),
            disconnectReason: 'client-disconnect'
        }, presence.entry.revision)).status,
        'applied'
    );
    try {
        await runtime.router.route(roomMessage(snapshot));
        assert.deepEqual(runtime.sent.map((send) => send.sessionId), ['session-1']);
        assert.deepEqual(findGroupStateSnapshotByRef(snapshot.group, runtime.manager), snapshot);
        assert.equal(runtime.reads.snapshots, 1);
    }
    finally {
        await runtime.manager.clear();
    }
});

Deno.test('transformed proxy targets and public publishes never inherit room authority', async () => {
    const snapshot = createGroupSnapshot(2, ['session-1', 'session-2']);
    const runtime = createLiveRoomRuntime();
    await putRoomSnapshot(runtime.repository, snapshot);
    runtime.router.proxy({
        from: { topicId: 'room.chat' },
        targets: () => ({ mode: 'unicast', toPeerId: 'outsider' })
    });
    const message = roomMessage(snapshot);
    try {
        await runtime.router.route(message);
        assert.deepEqual(runtime.sent.map((send) => send.sessionId), ['outsider', 'session-1', 'session-2']);
        assert.equal(
            runtime.sent[0]?.encoded,
            JSON.stringify({
                ...message,
                targets: { mode: 'unicast', toPeerId: 'outsider' }
            })
        );
        runtime.sent.length = 0;
        assert.equal((await runtime.router.publish(message)).status, 'no-recipients');
        assert.deepEqual(runtime.sent, []);
    }
    finally {
        await runtime.manager.clear();
    }
});

Deno.test('outbox fanout keeps the original message and uses its existing queue path', async () => {
    const snapshot = createGroupSnapshot(2, ['session-1', 'session-2']);
    const runtime = createLiveRoomRuntime();
    await putRoomSnapshot(runtime.repository, snapshot);
    runtime.router.defineTopic({ topicId: 'room.chat', fanout: 'outbox' });
    const enqueued: ALMessage[] = [];
    const enqueue = runtime.service.enqueueOutboxIfAbsent.bind(runtime.service);
    runtime.service.enqueueOutboxIfAbsent = (message) => {
        enqueued.push(message);
        return enqueue(message);
    };
    const message: ALMessage = {
        ...roomMessage(snapshot),
        delivery: { reliability: 'at-least-once', ack: 'receiver' }
    };
    try {
        await runtime.router.route(message);
        assert.deepEqual(enqueued, [message]);
        assert.equal((await runtime.service.outbox.getAllKeys()).length, 1);
        const entry = await runtime.service.outbox.getItem(message.route);
        assert.ok(entry);
        assert.equal(entry.resource, JSON.stringify(message));
        assert.deepEqual(runtime.sent, []);
        assert.equal(runtime.reads.snapshots, 1);
    }
    finally {
        await runtime.manager.clear();
    }
});

Deno.test('generic custom authorization retains its configured resolver without group storage', async () => {
    const runtime = createLiveRoomRuntime();
    const router = new RallarServerWsRouter(
        new WsQueueBoxServerService({
            name: 'custom-policy-test',
            inbox: new InMemoryQueueBox(),
            outbox: new InMemoryQueueBox(),
            socket: runtime.socket,
            targetResolver: { resolveGroupRecipients: () => [{ peerId: 'outsider', connectionId: 'outsider' }] }
        }),
        { authorizeRoomMessage: () => true }
    );
    try {
        await router.route(roomMessage(createGroupSnapshot(2, ['session-1'])));
        assert.deepEqual(runtime.sent.map((send) => send.sessionId), ['outsider']);
        assert.equal(runtime.reads.snapshots, 0);
    }
    finally {
        await runtime.manager.clear();
    }
});

function createLiveRoomRuntime(): LiveRoomTestRuntime {
    const state = createRoomStateTestRuntime();
    const socket = new JsonWebSocketServer();
    const sent: RoomLiveSend[] = [];
    const deliveryClock: RoomDeliveryClock = { atEpochMs: Date.now() };
    for (const sessionId of ['session-1', 'session-2', 'outsider']) {
        const webSocket = createOpenTestWebSocket();
        webSocket.send = (data) => {
            assert.ok(typeof data === 'string');
            sent.push({ sessionId, encoded: data });
        };
        socket.addConnection(new ConnectionContext(sessionId, webSocket));
    }
    const service = new WsQueueBoxServerService({
        name: 'api-live-room-test',
        inbox: new InMemoryQueueBox(),
        outbox: new InMemoryQueueBox(),
        socket,
        forwardsRoomScopedMessages: false,
        targetResolver: createWsServerTargetResolver(socket, {
            findGroupSnapshotByRef: (ref) => state.cache.findByRef(ref),
            now: () => deliveryClock.atEpochMs
        })
    });
    const router = new RallarServerWsRouter(service, {
        authorizeRoomMessage: createApiV1RoomWsAuthorizer(state.groupStateService, {
            readLifecyclePolicy: async () => ({ status: 'absent' })
        }),
        nowEpochMs: () => deliveryClock.atEpochMs
    });
    return { ...state, service, socket, router, sent, deliveryClock };
}

function roomMessage(snapshot: GroupSnapshot): ALMessage {
    return newALMulticastMessage(
        'session-1',
        newALEventRoute('room.chat', snapshot.group.groupId, 'message-1'),
        snapshot.group,
        'chat.message.v1',
        { text: 'hello' }
    );
}
