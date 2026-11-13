import { describe, expect, it } from 'vitest';

import type {
    RelayedAckNotice,
    RelayedAckNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import { createInboundTestStores } from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import {
    createRelayedAckMiddlewareInstance,
    readReceiptPhases,
    toRelayedAckMessage,
    toRelayedAckRoomMessage
} from './relayed-ack-middleware-fixture.ts';

const TRACE_ID = 'trace-relayed-ack-notice-delivery';

describe('middleware relayed ACK notices', () => {
    it('completes a receipt on the origin instance from an ACK its recipient sent to another instance', async () => {
        const transport = createMemoryTransport();
        const inboundStores = createInboundTestStores({
            namespace: 'relayed-ack-inbound',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const roomAudiencePeerIds = ['a', 'c'];
        const owner = await createRelayedAckMiddlewareInstance({
            relayedAckNotices: { transport, channel: 'ws-channel', publisherId: 'server-a' },
            inboundStores,
            sessionIds: ['a'],
            roomAudiencePeerIds
        });
        const other = await createRelayedAckMiddlewareInstance({
            relayedAckNotices: { transport, channel: 'ws-channel', publisherId: 'server-b' },
            inboundStores,
            sessionIds: ['c'],
            roomAudiencePeerIds
        });
        const message = toRelayedAckRoomMessage({ msgId: 'room-message-1', senderId: 'a', ack: 'receiver', traceId: TRACE_ID });
        expect((await owner.service.acceptIncomingMessage(message, 'a')).right?.kind).toBe('admitted');
        await expect.poll(() => readReceiptPhases(owner.sockets.a!, 'room-message-1')).toEqual(['admitted']);

        const accepted = await other.service.acceptIncomingMessage(
            toRelayedAckMessage({ ackedMsgId: 'room-message-1', fromPeerId: 'c', originPeerId: 'a', traceId: TRACE_ID }),
            'c'
        );

        expect(accepted.right).toEqual({ kind: 'control', handled: false });
        expect(transport.published.map((notice) => notice.publisherId)).toEqual(['server-b']);
        await expect.poll(() => readReceiptPhases(owner.sockets.a!, 'room-message-1')).toEqual([
            'admitted',
            'complete'
        ]);
    });
});

interface MemoryRelayedAckNoticeTransport extends RelayedAckNoticeTransport {
    readonly published: RelayedAckNotice[];
}

function createMemoryTransport(): MemoryRelayedAckNoticeTransport {
    const published: RelayedAckNotice[] = [];
    const subscribers: Array<(notice: RelayedAckNotice) => Promise<void> | void> = [];
    return {
        published,
        publish: async (notice) => {
            published.push(notice);
            for (const subscriber of subscribers) {
                await subscriber(notice);
            }
        },
        subscribe: async (_channel, onNotice) => {
            subscribers.push(onNotice);
        }
    };
}
