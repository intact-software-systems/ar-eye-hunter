import { describe, expect, it, vi } from 'vitest';

import { decodeLiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { installRelayedAckNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice-subscriber.ts';
import {
    createRelayedAckPublisher,
    decodeRelayedAckNotice,
    toRelayedAckNotice,
    type RelayedAckNotice,
    type RelayedAckNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage
} from '@shared/al-contracts/al-control.ts';

function receiverAck(ackedMsgId = 'room-message-1'): ALMessage {
    return newALAckControlMessage(
        { v: 3, msgId: 'ack-c', senderId: 'c', ts: 1 },
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
}

function relayedNotice(): RelayedAckNotice {
    const notice = toRelayedAckNotice({
        channel: 'ws-channel',
        publisherId: 'server-b',
        message: receiverAck()
    });
    if (notice.right === undefined) {
        throw new Error(`Relayed ACK notice fixture is invalid: ${notice.left}`);
    }
    return notice.right;
}

function createMemoryTransport(): RelayedAckNoticeTransport & {
    readonly published: RelayedAckNotice[];
} {
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

describe('relayed ACK notice codec', () => {
    it('round trips a receiver ACK through its JSON wire form', () => {
        const notice = relayedNotice();

        expect(notice).toEqual({
            kind: 'relayed-ack',
            version: 1,
            channel: 'ws-channel',
            publisherId: 'server-b',
            message: receiverAck()
        });
        expect(decodeRelayedAckNotice(JSON.parse(JSON.stringify(notice)), 'ws-channel')).toEqual(
            notice
        );
    });

    it('refuses an ACK whose notice would reach the notification byte limit', () => {
        const oversized = toRelayedAckNotice({
            channel: 'ws-channel',
            publisherId: 'server-b',
            message: receiverAck('x'.repeat(8_000))
        });

        expect(oversized.left).toMatch(
            /^Relayed acknowledgement notice is oversized \(\d+ bytes\)$/
        );
        expect(
            decodeRelayedAckNotice(
                { ...relayedNotice(), message: receiverAck('x'.repeat(8_000)) },
                'ws-channel'
            )
        )
            .toBeUndefined();
    });

    it('relays only a receiver acknowledgement', () => {
        const nack = newALNackControlMessage(
            { v: 3, msgId: 'nack-c', senderId: 'c', ts: 1 },
            {
                msgId: 'room-message-1',
                fromPeerId: 'c',
                toPeerId: 'a',
                reason: 'unauthorized',
                observedAtEpochMs: 1
            }
        );

        expect(
            toRelayedAckNotice({ channel: 'ws-channel', publisherId: 'server-b', message: nack })
                .left
        )
            .toBe('Only a receiver acknowledgement is relayed');
    });

    it.each([
        { label: 'another channel', value: relayedNotice(), channel: 'other-channel' },
        {
            label: 'an unknown key',
            value: { ...relayedNotice(), scope: 'extra' },
            channel: 'ws-channel'
        },
        {
            label: 'no publisher',
            value: { ...relayedNotice(), publisherId: '' },
            channel: 'ws-channel'
        },
        {
            label: 'another version',
            value: { ...relayedNotice(), version: 2 },
            channel: 'ws-channel'
        }
    ])('does not decode a notice with $label', ({ value, channel }) => {
        expect(decodeRelayedAckNotice(JSON.parse(JSON.stringify(value)), channel)).toBeUndefined();
    });

    it('shares the channel with live WS notices without either decoder taking the other kind', () => {
        const live = {
            kind: 'live-ws',
            version: 1,
            channel: 'ws-channel',
            publisherId: 'server-b',
            expiresAtMs: 1_800_000_000_000,
            delivery: 'inline',
            audience: { mode: 'broad', targetMode: 'all' },
            message: {
                id: { v: 3, msgId: 'message-1', ts: 1, senderId: 'sender' },
                route: { topicId: 'app.live', resourceId: 'message', contextId: 'all' },
                targets: { mode: 'broadcast', scope: 'all' },
                constraints: { expiresAtMs: 1_800_000_000_000 },
                payload: { typeId: 'app.live.v1', resource: '{}' }
            }
        };

        expect(decodeLiveWsNotice(live, 'ws-channel', 1)).toBeDefined();
        expect(decodeRelayedAckNotice(live, 'ws-channel')).toBeUndefined();
        expect(decodeLiveWsNotice(JSON.parse(JSON.stringify(relayedNotice())), 'ws-channel', 1))
            .toBeUndefined();
    });
});

describe('relayed ACK publisher and subscriber', () => {
    it('publishes one notice per relayed ACK and hands it to the other instances only', async () => {
        const transport = createMemoryTransport();
        const acceptedByA: ALMessage[] = [];
        const acceptedByB: ALMessage[] = [];
        await installRelayedAckNoticeSubscriber({
            transport,
            channel: 'ws-channel',
            publisherId: 'server-a',
            acceptRelayedAck: async (message) => {
                acceptedByA.push(message);
            }
        });
        await installRelayedAckNoticeSubscriber({
            transport,
            channel: 'ws-channel',
            publisherId: 'server-b',
            acceptRelayedAck: async (message) => {
                acceptedByB.push(message);
            }
        });

        const published = await createRelayedAckPublisher({
            transport,
            channel: 'ws-channel',
            publisherId: 'server-b'
        })(
            receiverAck()
        );

        expect(published.right).toBe('published');
        expect(transport.published).toHaveLength(1);
        expect(acceptedByA).toEqual([receiverAck()]);
        expect(acceptedByB).toEqual([]);
    });

    it('answers a failed or oversized relay as a value', async () => {
        const failing: RelayedAckNoticeTransport = {
            publish: async () => {
                throw new Error('notify failed');
            },
            subscribe: async () => {}
        };
        const publish = createRelayedAckPublisher({
            transport: failing,
            channel: 'ws-channel',
            publisherId: 'server-b'
        });

        expect((await publish(receiverAck())).left).toBe('notify failed');
        expect((await publish(receiverAck('x'.repeat(8_000)))).left).toMatch(/oversized/);
    });

    it('keeps the subscriber listening when counting one relayed ACK fails', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const transport = createMemoryTransport();
        const accepted: ALMessage[] = [];
        let calls = 0;
        await installRelayedAckNoticeSubscriber({
            transport,
            channel: 'ws-channel',
            publisherId: 'server-a',
            acceptRelayedAck: async (message) => {
                calls += 1;
                if (calls === 1) {
                    throw new Error('aggregate unavailable');
                }
                accepted.push(message);
            }
        });

        await transport.publish(relayedNotice());
        await transport.publish(relayedNotice());

        expect(accepted).toEqual([receiverAck()]);
        error.mockRestore();
    });
});
