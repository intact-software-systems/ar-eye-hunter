import assert from 'node:assert/strict';

import type { LiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { RelayedAckNotice } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';

import { createApiV1LiveWsNoticeTransport } from '../../src/db/api-v1-live-ws-notice-transport.ts';
import {
    createApiV1RelayedAckNotices,
    createPostgresRelayedAckNoticeTransport
} from '../../src/db/create-postgres-relayed-ack-notice-transport.ts';
import { createLocalQueuePubSubBus } from '../../src/db/local-queue-pubsub-bridge.ts';

interface RecordingNotificationPort {
    readonly notified: Array<{ readonly channel: string; readonly message: object; }>;
    readonly listeners: Array<(payload: string) => void | Promise<void>>;
    notify(channel: string, message: object): Promise<void>;
    listen(channel: string, onMessage: (payload: string) => void | Promise<void>): Promise<void>;
}

function createRecordingNotificationPort(): RecordingNotificationPort {
    const notified: RecordingNotificationPort['notified'] = [];
    const listeners: RecordingNotificationPort['listeners'] = [];
    return {
        notified,
        listeners,
        notify: (channel, message) => {
            notified.push({ channel, message });
            return Promise.resolve();
        },
        listen: (_channel, onMessage) => {
            listeners.push(onMessage);
            return Promise.resolve();
        }
    };
}

function relayedNotice(ackedMsgId = 'room-message-1'): RelayedAckNotice {
    const message = newALAckControlMessage(
        { v: 2, msgId: 'ack-c', senderId: 'c', ts: 1 },
        {
            ackedMsgId,
            fromPeerId: 'c',
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: 'c',
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: 1
        }
    );
    return {
        kind: 'relayed-ack',
        version: 1,
        channel: 'ws-channel',
        publisherId: 'server-b',
        message
    };
}

Deno.test('relayed ACK notices exist only for PostgreSQL pub/sub', () => {
    const notification = createRecordingNotificationPort();
    for (const mode of ['local', 'disabled'] as const) {
        assert.equal(
            createApiV1RelayedAckNotices({
                mode,
                notification,
                channel: 'ws-channel',
                publisherId: 'server-b'
            }),
            undefined
        );
    }
    const postgres = createApiV1RelayedAckNotices({
        mode: 'postgres',
        notification,
        channel: 'ws-channel',
        publisherId: 'server-b'
    });
    assert.equal(postgres?.channel, 'ws-channel');
    assert.equal(postgres?.publisherId, 'server-b');
});

Deno.test('the PostgreSQL relayed ACK transport notifies once and delivers only its own kind', async () => {
    const notification = createRecordingNotificationPort();
    const transport = createPostgresRelayedAckNoticeTransport(notification);
    const received: RelayedAckNotice[] = [];
    await transport.subscribe('ws-channel', (notice) => {
        received.push(notice);
    });
    const notice = relayedNotice();

    await transport.publish(notice);
    const live: LiveWsNotice = {
        kind: 'live-ws',
        version: 1,
        channel: 'ws-channel',
        publisherId: 'server-b',
        expiresAtMs: 1_800_000_000_000,
        delivery: 'inbound-key',
        audienceMode: 'broad',
        targetMode: 'all',
        inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message' } }
    };
    for (const listener of notification.listeners) {
        await listener(JSON.stringify(notice));
        await listener(JSON.stringify(live));
        await listener(
            JSON.stringify({ ...notice, message: relayedNotice('x'.repeat(8_000)).message })
        );
        await listener('not json');
    }

    assert.deepEqual(notification.notified, [{ channel: 'ws-channel', message: notice }]);
    assert.deepEqual(received, [notice]);
});

Deno.test('the live WS notice subscriber ignores a relayed ACK on the shared channel', async () => {
    const notification = createRecordingNotificationPort();
    const live = createApiV1LiveWsNoticeTransport({
        mode: 'postgres',
        publisherId: 'server-a',
        notification,
        localBus: createLocalQueuePubSubBus(),
        nowMs: () => 1
    });
    const received: LiveWsNotice[] = [];
    await live.subscribe('ws-channel', (notice) => {
        received.push(notice);
    });

    for (const listener of notification.listeners) {
        await listener(JSON.stringify(relayedNotice()));
    }

    assert.deepEqual(received, []);
});
