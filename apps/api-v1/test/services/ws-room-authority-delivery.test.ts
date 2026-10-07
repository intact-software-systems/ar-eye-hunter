import assert from 'node:assert/strict';

import type { GroupLifecyclePolicyRead } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALBroadcastMessage, newALMulticastMessage, toALGroupTargetKey } from '@shared/al-contracts/al-contract.ts';
import { newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALNackPayload, decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupMember, GroupPresenceSession } from '@shared/api/group-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
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
    readonly connectionScopes: Map<string, StateScope>;
    readonly server: JsonWebSocketServer;
    readonly service: WsQueueBoxServerService;
    readonly router: RallarServerWsRouter;
    readonly outbox: InMemoryQueueBox;
}

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const ROOM_SCOPE: StateScope = { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId };

for (const cacheState of ['absent', 'before-presence', 'wrong-scope'] as const) {
    Deno.test(`room live delivery uses current authority with ${cacheState} local cache`, async () => {
        const harness = createRoomDeliveryHarness();
        try {
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

            assert.deepEqual(senderFrames, []);
            assert.deepEqual(recipientFrames, [JSON.stringify(message)]);
            assert.deepEqual(outsiderFrames, []);
            assert.equal(harness.state.authorityReads, 1);
            assert.equal(harness.state.cached, cachedBefore);
            assert.deepEqual(await harness.outbox.getAllKeys(), []);
        }
        finally {
            harness.service.dispose();
        }
    });
}

Deno.test('room delivery excludes revoked or expired recipients even when cache and sockets retain them', async () => {
    for (const revocation of ['member', 'session', 'expiry'] as const) {
        const harness = createRoomDeliveryHarness();
        try {
            const snapshot = createRoomSnapshot(['alice', 'bob', 'carol']);
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
            const remainingFrames = addRecordingConnection(harness.server, 'carol');
            const message = roomMessage();

            await harness.router.route(message);

            assert.deepEqual(senderFrames, []);
            assert.deepEqual(revokedFrames, []);
            assert.deepEqual(remainingFrames, [JSON.stringify(message)]);
        }
        finally {
            harness.service.dispose();
        }
    }
});

Deno.test('current room denial emits its typed NACK without using a permissive recipient cache', async () => {
    for (
        const { denial, reason } of [
            { denial: 'missing', reason: 'unauthorized' },
            { denial: 'scope', reason: 'unauthorized' },
            { denial: 'group', reason: 'unauthorized' },
            { denial: 'member', reason: 'membership-fenced' },
            { denial: 'session', reason: 'membership-fenced' },
            { denial: 'version', reason: 'not-yet-in-sync' },
            { denial: 'roster', reason: 'not-yet-in-sync' },
            { denial: 'policy', reason: 'unauthorized' },
            { denial: 'halted', reason: 'unauthorized' }
        ] as const
    ) {
        const harness = createRoomDeliveryHarness();
        try {
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
            const message = roomMessage({
                minSnapshotVersion: denial === 'version' ? 3 : undefined,
                rosterVersion: denial === 'roster' ? 2 : undefined
            });

            await harness.router.route(message);

            assert.equal(senderFrames.length, 1);
            const nack = decodePersistedALMessage(senderFrames[0]!);
            assert.notEqual(nack.route.topicId, 'room.chat');
            assert.equal(decodeALNackPayload(JSON.parse(nack.payload.resource)).reason, reason, denial);
            assert.deepEqual(recipientFrames, []);
            assert.deepEqual(await harness.outbox.getAllKeys(), []);
        }
        finally {
            harness.service.dispose();
        }
    }
});

Deno.test('a room send behind the server snapshot is retained at ingress with its advisory NACK and delivered once the snapshot advances', async () => {
    for (const floor of ['version', 'roster'] as const) {
        const harness = createRoomDeliveryHarness();
        try {
            harness.router.install();
            const senderFrames = addRecordingConnection(harness.server, 'alice');
            const recipientFrames = addRecordingConnection(harness.server, 'bob');
            const message = roomMessage(floor === 'version' ? { minSnapshotVersion: 3 } : { rosterVersion: 2 });

            const accepted = await harness.service.acceptIncomingMessage(message, 'alice');

            assert.deepEqual(accepted.right, { kind: 'pending-admission' }, floor);
            assert.equal(senderFrames.length, 1, floor);
            const nack = decodePersistedALMessage(senderFrames[0]!);
            assert.equal(decodeALNackPayload(JSON.parse(nack.payload.resource)).reason, 'not-yet-in-sync', floor);
            await new Promise((resolve) => setTimeout(resolve, 120));
            assert.deepEqual(recipientFrames, [], floor);

            const snapshot = createRoomSnapshot();
            harness.state.current = { ...snapshot, group: { ...snapshot.group, snapshotVersion: 3, rosterVersion: 2 } };
            await waitForRoomFrames(() => recipientFrames.length > 0);

            assert.deepEqual(recipientFrames.map((frame) => decodePersistedALMessage(frame).id), [message.id], floor);
            assert.equal(senderFrames.length, 1, floor);
        }
        finally {
            harness.service.dispose();
        }
    }
});

Deno.test('room broadcast exclusions preserve an empty authoritative audience without cache fallback', async () => {
    const harness = createRoomDeliveryHarness();
    try {
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
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('room reconnect delivers to the current open socket and ignores delayed old-generation close', async () => {
    const harness = createRoomDeliveryHarness();
    try {
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
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('transformed proxy targets never inherit the source room authoritative audience', async () => {
    const harness = createRoomDeliveryHarness();
    try {
        harness.state.cached = undefined;
        const sourceFrames = addRecordingConnection(harness.server, 'alice');
        const proxyFrames = addRecordingConnection(harness.server, 'outsider');
        harness.router.proxy({
            from: { topicId: 'room.chat' },
            targets: () => ({ mode: 'unicast', toPeerId: 'outsider' }),
            suppressDefaultFanout: true
        });
        const message = roomMessage();

        await harness.router.route(message, {
            kind: 'ws-client',
            peerId: 'alice',
            authenticatedScope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId }
        });

        assert.deepEqual(sourceFrames, []);
        assert.deepEqual(proxyFrames, [JSON.stringify({ ...message, targets: { mode: 'unicast', toPeerId: 'outsider' } })]);
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('generic custom authorization retains its explicit resolver-owned audience', async () => {
    for (const decision of [true, { authorized: true }] as const) {
        const harness = createRoomDeliveryHarness();
        try {
            const frames = addRecordingConnection(harness.server, 'bob');
            const router = new RallarServerWsRouter(harness.service, { authorizeRoomMessage: () => decision });
            const message = roomMessage();

            await router.route(message);

            assert.deepEqual(frames, [JSON.stringify(message)]);
            assert.equal(harness.state.authorityReads, 0);
        }
        finally {
            harness.service.dispose();
        }
    }
});

Deno.test('room delivery rechecks session expiry and open sockets after awaited handlers', async () => {
    let nowEpochMs = Date.now();
    const harness = createRoomDeliveryHarness(() => nowEpochMs);
    try {
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
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('a handler cannot reuse room authority after changing the target scope or exclusions', async () => {
    for (const mutation of ['scope', 'exclusions'] as const) {
        const harness = createRoomDeliveryHarness();
        try {
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
        finally {
            harness.service.dispose();
        }
    }
});

Deno.test('a socket closed during an awaited handler receives no authoritative live frame', async () => {
    const harness = createRoomDeliveryHarness();
    try {
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
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('a WS-carried receiver room multicast queues durable delivery to the other admitted members, never its origin, and answers it with receipts', async () => {
    const harness = createRoomDeliveryHarness();
    try {
        const snapshot = createRoomSnapshot(['alice', 'bob', 'carol']);
        harness.state.current = snapshot;
        harness.state.cached = snapshot;
        harness.router.defineTopic({ topicId: 'room.chat', fanout: 'outbox' });
        harness.router.install();
        const senderFrames = addRecordingConnection(harness.server, 'alice');
        const bobFrames = addRecordingConnection(harness.server, 'bob');
        const carolFrames = addRecordingConnection(harness.server, 'carol');
        const message = newALMulticastMessage('alice', newALEventRoute('room.chat', ROOM.groupId, 'fallback-durable'), ROOM, 'chat.message.v1', {
            text: 'over the fallback carrier'
        }, {
            ttlMs: 30_000,
            orderingKey: toALGroupTargetKey(ROOM),
            reliability: 'at-least-once',
            ack: 'receiver',
            ownership: 'shared',
            overlayId: toScopedOverlayId(ROOM)
        });

        const accepted = await harness.service.acceptIncomingMessage(message, 'alice');
        assert.deepEqual(accepted.right, { kind: 'admitted' });
        const roomFrames = (frames: readonly string[]) => frames.filter((frame) => decodePersistedALMessage(frame).route.topicId === 'room.chat');
        await waitForRoomFrames(() => roomFrames(bobFrames).length + roomFrames(carolFrames).length >= 2);

        // The room message and the origin's admitted receipt: one row each.
        assert.equal((await harness.outbox.getAllKeys()).filter((key) => key.topicId === 'AL_OUTBOUND_MESSAGE').length, 2);
        assert.deepEqual(roomFrames(bobFrames).map((frame) => decodePersistedALMessage(frame).id), [message.id]);
        assert.deepEqual(roomFrames(carolFrames).map((frame) => decodePersistedALMessage(frame).id), [message.id]);
        assert.deepEqual(roomFrames(senderFrames), []);

        for (const recipient of ['bob', 'carol']) {
            await harness.service.acceptIncomingMessage(receiverAck(message, recipient), recipient);
        }
        await waitForRoomFrames(() => readReceipts(senderFrames).length >= 2);
        assert.deepEqual(readReceipts(senderFrames).map((receipt) => [receipt.phase, receipt.confirmedRecipientPeerIds]), [
            ['admitted', []],
            ['complete', ['bob', 'carol']]
        ]);
        assert.deepEqual(readReceipts(senderFrames)[0]?.expectedRecipientPeerIds, ['bob', 'carol']);
        assert.equal(readReceipts(senderFrames)[0]?.snapshotVersion, 2);
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('a server publication that names an ordering key is published with the sequence its outbound minted, and delivered with it', async () => {
    const harness = createRoomDeliveryHarness();
    try {
        const aliceFrames = addRecordingConnection(harness.server, 'alice');
        const bobFrames = addRecordingConnection(harness.server, 'bob');

        const published = [
            await harness.router.publish({ message: serverTrackNotice(harness.router.serverPeerId, 'notice-1'), fanout: 'outbox' }),
            await harness.router.publish({ message: serverTrackNotice(harness.router.serverPeerId, 'notice-2'), fanout: 'outbox' })
        ];
        await waitForRoomFrames(() => readNoticeOrderings(aliceFrames).length + readNoticeOrderings(bobFrames).length >= 4);

        const minted = [1, 2].map((seq) => ({ orderingKey: 'notice-track', epoch: 1, seq }));
        assert.deepEqual(published.map((result) => [result.status, result.message.ordering]), [
            ['queued-outbox', minted[0]],
            ['queued-outbox', minted[1]]
        ]);
        assert.deepEqual(readNoticeOrderings(aliceFrames), minted);
        assert.deepEqual(readNoticeOrderings(bobFrames), minted);
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('a principal broadcast in a room reaches the live sessions of that principal in the room alone, and its receipt and outbox row expect them', async () => {
    for (const fanout of ['live-only', 'outbox'] as const) {
        const harness = createRoomDeliveryHarness();
        try {
            harness.state.current = createSecondSessionSnapshot();
            harness.state.cached = createSecondSessionSnapshot();
            harness.router.defineTopic({ topicId: 'room.chat', fanout });
            harness.router.install();
            const frames = Object.fromEntries(
                ['alice', 'alice-2', 'alice-elsewhere', 'bob', 'carol'].map((sessionId) => [sessionId, addRecordingConnection(harness.server, sessionId)])
            );
            const message = audienceMessage('bob', {
                mode: 'broadcast',
                scope: 'principal',
                groupRef: ROOM,
                principalRef: { ...ROOM_SCOPE, principalId: 'alice' }
            });

            const accepted = await harness.service.acceptIncomingMessage(message, 'bob');
            assert.deepEqual(accepted.right, { kind: 'admitted' }, fanout);
            await waitForRoomFrames(() => readChatIds(frames['alice']!).length + readChatIds(frames['alice-2']!).length >= 2);

            assert.deepEqual(readChatIds(frames['alice']!), [message.id.msgId], fanout);
            assert.deepEqual(readChatIds(frames['alice-2']!), [message.id.msgId], fanout);
            for (const outside of ['alice-elsewhere', 'bob', 'carol']) {
                assert.deepEqual(readChatIds(frames[outside]!), [], `${fanout} ${outside}`);
            }
            assert.deepEqual(readReceipts(frames['bob']!)[0]?.expectedRecipientPeerIds, ['alice', 'alice-2'], fanout);
            if (fanout === 'outbox') {
                assert.deepEqual((await readCapturedOutboxPolicy(harness, message))?.admittedAudience, ['alice', 'alice-2']);
            }
        }
        finally {
            harness.service.dispose();
        }
    }
});

Deno.test('a principal broadcast whose principal has no live session in the room reaches no one and is answered with one empty admitted receipt', async () => {
    const harness = createRoomDeliveryHarness();
    try {
        const snapshot = createRoomSnapshot(['alice', 'bob', 'carol']);
        harness.state.current = { ...snapshot, activeSessions: snapshot.activeSessions.filter((session) => session.principalId !== 'carol') };
        harness.router.install();
        const frames = Object.fromEntries(['alice', 'bob', 'carol'].map((sessionId) => [sessionId, addRecordingConnection(harness.server, sessionId)]));
        const message = audienceMessage('bob', {
            mode: 'broadcast',
            scope: 'principal',
            groupRef: ROOM,
            principalRef: { ...ROOM_SCOPE, principalId: 'carol' }
        });

        const accepted = await harness.service.acceptIncomingMessage(message, 'bob');
        await waitForRoomFrames(() => false);

        assert.deepEqual(accepted.right, { kind: 'admitted' });
        for (const sessionId of ['alice', 'bob', 'carol']) {
            assert.deepEqual(readChatIds(frames[sessionId]!), [], sessionId);
        }
        assert.deepEqual(readReceipts(frames['bob']!).map((receipt) => [receipt.phase, receipt.expectedRecipientPeerIds]), [['admitted', []]]);
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('a principal broadcast stamped beyond the server roster is retained at ingress and delivered to that principal once the roster advances', async () => {
    const harness = createRoomDeliveryHarness();
    try {
        harness.state.current = createSecondSessionSnapshot();
        harness.router.install();
        const frames = Object.fromEntries(
            ['alice', 'alice-2', 'bob', 'carol'].map((sessionId) => [sessionId, addRecordingConnection(harness.server, sessionId)])
        );
        const message = audienceMessage('bob', {
            mode: 'broadcast',
            scope: 'principal',
            groupRef: ROOM,
            principalRef: { ...ROOM_SCOPE, principalId: 'alice' },
            rosterVersion: 2
        });

        const accepted = await harness.service.acceptIncomingMessage(message, 'bob');

        assert.deepEqual(accepted.right, { kind: 'pending-admission' });
        assert.equal(decodeALNackPayload(JSON.parse(decodePersistedALMessage(frames['bob']![0]!).payload.resource)).reason, 'not-yet-in-sync');
        const current = createSecondSessionSnapshot();
        harness.state.current = { ...current, group: { ...current.group, rosterVersion: 2 } };
        await waitForRoomFrames(() => readChatIds(frames['alice']!).length + readChatIds(frames['alice-2']!).length >= 2);

        assert.deepEqual(readChatIds(frames['alice']!), [message.id.msgId]);
        assert.deepEqual(readChatIds(frames['alice-2']!), [message.id.msgId]);
        assert.deepEqual(readChatIds(frames['carol']!), []);
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('a room broadcast from a client reaches the other live sessions in the room and never its sender', async () => {
    for (const fanout of ['live-only', 'outbox'] as const) {
        const harness = createRoomDeliveryHarness();
        try {
            harness.state.current = createRoomSnapshot(['alice', 'bob', 'carol']);
            harness.state.cached = createRoomSnapshot(['alice', 'bob', 'carol']);
            harness.router.defineTopic({ topicId: 'room.chat', fanout });
            harness.router.install();
            const frames = Object.fromEntries(['alice', 'bob', 'carol'].map((sessionId) => [sessionId, addRecordingConnection(harness.server, sessionId)]));
            const message = audienceMessage('alice', { mode: 'broadcast', scope: 'room', groupRef: ROOM });

            const accepted = await harness.service.acceptIncomingMessage(message, 'alice');
            assert.deepEqual(accepted.right, { kind: 'admitted' }, fanout);
            await waitForRoomFrames(() => readChatIds(frames['bob']!).length + readChatIds(frames['carol']!).length >= 2);

            assert.deepEqual(readChatIds(frames['bob']!), [message.id.msgId], fanout);
            assert.deepEqual(readChatIds(frames['carol']!), [message.id.msgId], fanout);
            assert.deepEqual(readChatIds(frames['alice']!), [], fanout);
            assert.deepEqual(readReceipts(frames['alice']!)[0]?.expectedRecipientPeerIds, ['bob', 'carol'], fanout);
        }
        finally {
            harness.service.dispose();
        }
    }
});

Deno.test('a room broadcast with a fixed list reaches the listed sessions in the room alone, and its receipt expects them', async () => {
    const harness = createRoomDeliveryHarness();
    try {
        harness.state.current = createRoomSnapshot(['alice', 'bob', 'carol']);
        harness.router.install();
        const frames = Object.fromEntries(
            ['alice', 'bob', 'carol', 'outsider'].map((sessionId) => [sessionId, addRecordingConnection(harness.server, sessionId)])
        );
        const message = audienceMessage('alice', { mode: 'broadcast', scope: 'room', groupRef: ROOM, recipientPeerIds: ['carol', 'outsider'] });

        const accepted = await harness.service.acceptIncomingMessage(message, 'alice');
        assert.deepEqual(accepted.right, { kind: 'admitted' });
        await waitForRoomFrames(() => readChatIds(frames['carol']!).length >= 1);

        assert.deepEqual(readChatIds(frames['carol']!), [message.id.msgId]);
        for (const outside of ['alice', 'bob', 'outsider']) {
            assert.deepEqual(readChatIds(frames[outside]!), [], outside);
        }
        assert.deepEqual(readReceipts(frames['alice']!).map((receipt) => receipt.expectedRecipientPeerIds), [['carol']]);
    }
    finally {
        harness.service.dispose();
    }
});

Deno.test('a world broadcast reaches each live connection of the authenticated scope of its sender once, and no one else', async () => {
    for (const fanout of ['live-only', 'outbox'] as const) {
        const harness = createRoomDeliveryHarness();
        try {
            harness.router.defineTopic({ topicId: 'app.news', fanout });
            harness.router.install();
            harness.connectionScopes.set('foreign', { applicationId: 'app-2', workspaceId: ROOM.workspaceId });
            const frames = Object.fromEntries(
                ['alice', 'bob', 'foreign'].map((sessionId) => [sessionId, addRecordingConnection(harness.server, sessionId)])
            );
            const message = newALBroadcastMessage('alice', newALEventRoute('app.news', 'world', 'world-news'), 'world', 'news.v1', { text: 'hello' }, {
                reliability: 'at-least-once',
                ack: 'none'
            });

            const accepted = await harness.service.acceptIncomingMessage(message, 'alice');
            assert.deepEqual(accepted.right, { kind: 'admitted' }, fanout);
            await waitForRoomFrames(() => readTopicIds(frames['bob']!, 'app.news').length >= 1);
            // Settles every path that could still deliver, so a second copy or a stray one would have arrived.
            await waitForRoomFrames(() => false);

            assert.deepEqual(readTopicIds(frames['bob']!, 'app.news'), [message.id.msgId], fanout);
            assert.deepEqual(readTopicIds(frames['foreign']!, 'app.news'), [], fanout);
            assert.deepEqual(readTopicIds(frames['alice']!, 'app.news'), [], fanout);
            if (fanout === 'outbox') {
                assert.deepEqual((await readCapturedOutboxPolicy(harness, message))?.recipientScope, ROOM_SCOPE);
            }
        }
        finally {
            harness.service.dispose();
        }
    }
});

Deno.test('an all broadcast from a client is refused unauthorized and reaches no one', async () => {
    const harness = createRoomDeliveryHarness();
    try {
        harness.router.install();
        const senderFrames = addRecordingConnection(harness.server, 'alice');
        const bobFrames = addRecordingConnection(harness.server, 'bob');
        const message = newALBroadcastMessage('alice', newALEventRoute('app.news', 'all', 'all-news'), 'all', 'news.v1', { text: 'hello' });

        const accepted = await harness.service.acceptIncomingMessage(message, 'alice');
        await waitForRoomFrames(() => false);

        assert.equal(accepted.left?.code, 'unauthorized');
        assert.deepEqual(senderFrames.map((frame) => decodeALNackPayload(JSON.parse(decodePersistedALMessage(frame).payload.resource)).reason), [
            'unauthorized'
        ]);
        assert.deepEqual(bobFrames, []);
    }
    finally {
        harness.service.dispose();
    }
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
    const connectionScopes = new Map<string, StateScope>();
    const service = createDefaultWsQueueBoxServerService({
        outbox,
        socket: server,
        readAuthenticatedConnectionScope: (connection) =>
            server.connections.get(connection.id) === connection
                ? { scope: connectionScopes.get(connection.id) ?? ROOM_SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
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
    return { state, connectionScopes, server, service, router, outbox };
}

function receiverAck(message: ALMessage, recipient: string): ALMessage {
    return newALAckControlMessage({ v: 3, msgId: `ack-${recipient}`, senderId: recipient, ts: Date.now() }, {
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

function readReceipts(frames: readonly string[]): readonly ALReceiptPayload[] {
    return frames
        .map((frame) => decodePersistedALMessage(frame))
        .filter((frame) => frame.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((frame) => decodeALReceiptPayload(JSON.parse(frame.payload.resource)));
}

/** A notice the server publishes itself on epoch 1 of one track, naming no sequence. */
function serverTrackNotice(serverPeerId: string, noticeId: string): ALMessage {
    return newALBroadcastMessage(serverPeerId, newALEventRoute('room.notice', ROOM.groupId, noticeId), 'room', 'notice.v1', {
        noticeId
    }, {
        groupRef: ROOM,
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: 60_000,
        ordering: { orderingKey: 'notice-track', epoch: 1 }
    });
}

function readNoticeOrderings(frames: readonly string[]): readonly (ALMessage['ordering'])[] {
    return frames
        .map((frame) => decodePersistedALMessage(frame))
        .filter((frame) => frame.route.topicId === 'room.notice')
        .map((frame) => frame.ordering);
}

/** A receiver-acknowledged chat message in the room from `senderId`, addressed by `targets`. */
function audienceMessage(senderId: string, targets: NonNullable<ALMessage['targets']>): ALMessage {
    const message = newALBroadcastMessage(senderId, newALEventRoute('room.chat', ROOM.groupId, 'audience'), 'room', 'chat.message.v1', { text: 'hello' }, {
        groupRef: ROOM,
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: 30_000
    });
    return { ...message, targets };
}

/** The policy the outbox captured for the row that relays `message`. */
async function readCapturedOutboxPolicy(harness: RoomDeliveryHarness, message: ALMessage): Promise<ALOutboundCapturedPolicy | undefined> {
    for (const key of (await harness.outbox.getAllKeys()).filter((key) => key.topicId === 'AL_OUTBOUND_MESSAGE')) {
        const entry = await harness.outbox.getItem(key);
        const relayed = entry === undefined ? undefined : decodePersistedALMessage(entry.resource);
        if (entry !== undefined && relayed?.id.msgId === message.id.msgId) {
            return await harness.service.readCapturedPolicy(relayed, entry);
        }
    }
    return undefined;
}

function readChatIds(frames: readonly string[]): readonly string[] {
    return readTopicIds(frames, 'room.chat');
}

function readTopicIds(frames: readonly string[], topicId: string): readonly string[] {
    return frames
        .map((frame) => decodePersistedALMessage(frame))
        .filter((frame) => frame.route.topicId === topicId)
        .map((frame) => frame.id.msgId);
}

/** Alice, Bob and Carol in the room, Alice with a second live session `alice-2`. */
function createSecondSessionSnapshot(): GroupSnapshot {
    const snapshot = createRoomSnapshot(['alice', 'bob', 'carol']);
    const alice = snapshot.activeSessions[0]!;
    return {
        ...snapshot,
        activeSessions: [...snapshot.activeSessions, { ...alice, sessionId: 'alice-2', generationId: 'generation-alice-2' }]
    };
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

/** Admission returns before the inbound worker delivers, and the outbox worker sends on a later batch still. */
async function waitForRoomFrames(isSettled: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !isSettled(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
}

function roomMessage(floors: Readonly<{ minSnapshotVersion?: number; rosterVersion?: number; }> = {}): ALMessage {
    return newALMulticastMessage('alice', newALEventRoute('room.chat', ROOM.groupId, 'room-delivery'), ROOM, 'chat.message.v1', { text: 'hello' }, {
        ...floors,
        reliability: 'best-effort',
        ack: 'none'
    });
}

function createRoomSnapshot(principalIds: readonly string[] = ['alice', 'bob']): GroupSnapshot {
    const group = createTestGroup({ ...ROOM, snapshotVersion: 2, presenceVersion: 1, activeMemberCount: principalIds.length });
    return {
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
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
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 2,
            expiresAtEpochMs: 4_000_000_000_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: principalIds.length,
        onlineMemberCount: principalIds.length
    };
}
