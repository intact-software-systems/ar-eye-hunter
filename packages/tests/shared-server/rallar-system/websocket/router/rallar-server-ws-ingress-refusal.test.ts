import { describe, expect, it, onTestFinished } from 'vitest';

import type { RallarServerWsFanout } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const TOPIC_ID = 'app.pose';

interface IngressFixture {
    readonly service: WsQueueBoxServerService;
    readonly router: RallarServerWsRouter;
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly sockets: Readonly<Record<'origin' | 'receiver', TestWebSocket>>;
}

interface SentNack {
    readonly msgId: string;
    readonly reason: string;
}

describe('the WS ingress refusal of a live publication on an outbox topic (D482)', () => {
    it('refuses a volatile best-effort latest-wins send on an outbox topic unsupported, NACKs it unsupported and delivers it to no one', async () => {
        const fixture = createIngressFixture('outbox');
        const message = createLivePublication('live-on-outbox');

        const refused = await fixture.service.acceptIncomingMessage(message, 'origin');

        expect(refused.left?.code).toBe('unsupported');
        await expect.poll(() => readSentNacks(fixture.sockets.origin)).toEqual([
            { msgId: 'live-on-outbox', reason: 'unsupported' }
        ]);
        await settleDelivery();
        expect(readDeliveredCount(fixture.sockets.receiver, message.id.msgId)).toBe(0);
        expect(await readOutboxRowCount(fixture, message.id.msgId)).toBe(0);
    });

    it('refuses the same send when it reaches the router after admission, as a NACK of the same reason', async () => {
        const fixture = createIngressFixture('outbox');
        const message = createLivePublication('live-routed');

        await fixture.router.route(message);

        expect(readSentNacks(fixture.sockets.origin)).toEqual([{ msgId: 'live-routed', reason: 'unsupported' }]);
        await settleDelivery();
        expect(readDeliveredCount(fixture.sockets.receiver, message.id.msgId)).toBe(0);
        expect(await readOutboxRowCount(fixture, message.id.msgId)).toBe(0);
    });

    it('admits the same send on a live-only topic and delivers it to the receiver once', async () => {
        const fixture = createIngressFixture('live-only');
        const message = createLivePublication('live-on-live-only');

        expect((await fixture.service.acceptIncomingMessage(message, 'origin')).right).toEqual({ kind: 'admitted' });

        await expect.poll(() => readDeliveredCount(fixture.sockets.receiver, message.id.msgId)).toBe(1);
        expect(readSentNacks(fixture.sockets.origin)).toEqual([]);
    });

    it('admits an at-least-once command on an outbox topic and delivers it to the receiver once', async () => {
        const fixture = createIngressFixture('outbox');
        const message = createCommand('command-on-outbox');

        expect((await fixture.service.acceptIncomingMessage(message, 'origin')).right).toEqual({ kind: 'admitted' });

        await expect.poll(() => readDeliveredCount(fixture.sockets.receiver, message.id.msgId)).toBe(1);
        expect(await readOutboxRowCount(fixture, message.id.msgId)).toBeGreaterThan(0);
        expect(readSentNacks(fixture.sockets.origin)).toEqual([]);
    });

    it('admits a live publication unicast to the server on an outbox topic: it ends at the server\'s handlers', async () => {
        const fixture = createIngressFixture('outbox');
        const handled: string[] = [];
        fixture.router.on({ topicId: TOPIC_ID }, (message) => {
            handled.push(message.raw.id.msgId);
        });
        const message: ALMessage = {
            ...createLivePublication('live-to-server'),
            targets: { mode: 'unicast', toPeerId: fixture.router.serverPeerId }
        };

        expect((await fixture.service.acceptIncomingMessage(message, 'origin')).right).toEqual({ kind: 'admitted' });

        await expect.poll(() => handled).toEqual(['live-to-server']);
        expect(readSentNacks(fixture.sockets.origin)).toEqual([]);
    });

    it('refuses a live publication on a live-only topic whose proxy rule publishes it through the outbox', async () => {
        const fixture = createIngressFixture('live-only');
        fixture.router.proxy({ id: 'pose-to-outbox', from: { topicId: TOPIC_ID }, fanout: 'outbox' });
        const message = createLivePublication('live-proxied-to-outbox');

        const refused = await fixture.service.acceptIncomingMessage(message, 'origin');

        expect(refused.left?.code).toBe('unsupported');
        await expect.poll(() => readSentNacks(fixture.sockets.origin)).toEqual([
            { msgId: 'live-proxied-to-outbox', reason: 'unsupported' }
        ]);
        await settleDelivery();
        expect(readDeliveredCount(fixture.sockets.receiver, message.id.msgId)).toBe(0);
        expect(await readOutboxRowCount(fixture, message.id.msgId)).toBe(0);
    });

    it('admits a live publication on an outbox topic whose proxy rule publishes it live and suppresses the default fanout', async () => {
        const fixture = createIngressFixture('outbox');
        fixture.router.proxy({
            id: 'pose-live',
            from: { topicId: TOPIC_ID },
            fanout: 'live-only',
            suppressDefaultFanout: true,
            targets: () => ({ mode: 'unicast', toPeerId: 'receiver' })
        });
        const message = createLivePublication('live-proxied-live');

        expect((await fixture.service.acceptIncomingMessage(message, 'origin')).right).toEqual({ kind: 'admitted' });

        await expect.poll(() => readDeliveredCount(fixture.sockets.receiver, message.id.msgId)).toBe(1);
        expect(readSentNacks(fixture.sockets.origin)).toEqual([]);
    });
});

function createIngressFixture(fanout: RallarServerWsFanout): IngressFixture {
    const socketServer = new JsonWebSocketServer();
    const sockets = { origin: new TestWebSocket('ws://origin'), receiver: new TestWebSocket('ws://receiver') };
    for (const [sessionId, socket] of Object.entries(sockets)) {
        socket.open();
        socketServer.addConnection(new ConnectionContext({ id: sessionId, socket }));
    }
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        outbox: outboundStores.workQueue,
        socket: socketServer,
        name: 'server-1',
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: () => ({ scope: SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }),
        targetResolver: {
            resolvePeerIdForConnection: (connectionId) => connectionId,
            resolvePeerRecipients: (peerId) => [{ peerId, connectionId: peerId }],
            resolveBroadcastRecipients: () => Object.keys(sockets).map((peerId) => ({ peerId, connectionId: peerId }))
        }
    });
    onTestFinished(() => service.dispose());
    const router = new RallarServerWsRouter(service, {}).install().defineTopic({ topicId: TOPIC_ID, fanout });
    return { service, router, outboundStores, sockets };
}

/** The wire signature of a live channel's send: best-effort, no receipt, volatile and latest-wins. */
function createLivePublication(msgId: string): ALMessage {
    const base = createWorldSend(msgId);
    return {
        ...base,
        delivery: { reliability: 'best-effort', ack: 'none' },
        qos: { durability: { algo: 'volatile' }, supersedence: { algo: 'latest-wins' } }
    };
}

function createCommand(msgId: string): ALMessage {
    return { ...createWorldSend(msgId), delivery: { reliability: 'at-least-once', ack: 'none' } };
}

function createWorldSend(msgId: string): ALMessage {
    const base = newALBroadcastMessage('origin', newALRoute(TOPIC_ID, 'world', msgId), 'world', 'pose.v1', {});
    return { ...base, id: { ...base.id, msgId } };
}

async function settleDelivery(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
}

function readDeliveredCount(socket: TestWebSocket, msgId: string): number {
    return socket.sent.map(decodePersistedALMessage).filter((sent) => sent.id.msgId === msgId).length;
}

/** The server's outbox rows that carry the message, whatever their status. */
async function readOutboxRowCount(fixture: IngressFixture, msgId: string): Promise<number> {
    const workQueue = fixture.outboundStores.workQueue;
    const rows = await Promise.all((await workQueue.getAllKeys()).map((key) => workQueue.getItem(key)));
    return rows.filter((row) => JSON.stringify(row).includes(msgId)).length;
}

function readSentNacks(socket: TestWebSocket): readonly SentNack[] {
    return socket.sent.map(decodePersistedALMessage).flatMap((sent) => {
        const control = parseALControlMessage(sent);
        return control?.type === 'nack' ? [{ msgId: control.payload.msgId, reason: control.payload.reason }] : [];
    });
}
