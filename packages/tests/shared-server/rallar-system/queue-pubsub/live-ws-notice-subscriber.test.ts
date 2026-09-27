import { describe, expect, it, vi } from 'vitest';

import { installLiveWsNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import { encodeLiveWsNotice, type LiveWsNotice, type LiveWsNoticeTransport } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundStoredPlanningRead } from '@shared/alm/inbound/al-inbound-admission-store.ts';

const deadline = 1_800_000_000_000;
const scope = { applicationId: 'app', workspaceId: 'workspace' };
const groupRef = { ...scope, groupId: 'room' };

function roomMessage(resource = '{}'): ALMessage {
    return {
        id: { v: 2, msgId: 'message-1', ts: 1, senderId: 'sender' },
        route: { topicId: 'room.match', resourceId: 'room', contextId: 'room' },
        targets: { mode: 'multicast', groupRef },
        constraints: { expiresAtMs: deadline },
        payload: { typeId: 'room.match', resource }
    };
}

function roomNotice(recipientSessionIds: readonly string[] = ['remote-session']): LiveWsNotice {
    const encoded = encodeLiveWsNotice({
        channel: 'ws-channel',
        publisherId: 'publisher-a',
        scope,
        expiresAtMs: deadline,
        audience: { mode: 'room', groupRef, recipientSessionIds },
        message: roomMessage()
    });
    if (encoded.kind !== 'inline') {
        throw new Error('Expected inline fixture');
    }
    return encoded.notice;
}

function createReceiver() {
    let callback: ((notice: LiveWsNotice) => Promise<void> | void) | undefined;
    const transport: LiveWsNoticeTransport = {
        publish: async () => {},
        subscribe: async (_channel, onNotice) => {
            callback = onNotice;
        }
    };
    const sent: Array<{ message: ALMessage; ids: readonly string[]; }> = [];
    const readDeliverySurface = vi.fn(async (): Promise<ALInboundStoredPlanningRead | undefined> => undefined);
    const eligible = vi.fn((ids: readonly string[]) => ids.filter((id) => id === 'remote-session'));
    const resolveBroad = vi.fn((): readonly string[] => ['remote-session']);
    const installed = installLiveWsNoticeSubscriber({
        transport,
        channel: 'ws-channel',
        publisherId: 'publisher-b',
        nowMs: () => 1,
        inboundStores: [{ namespace: 'ws', readDeliverySurface }],
        resolveBroadRecipientSessionIds: resolveBroad,
        filterEligibleRecipientSessionIds: eligible,
        sendToTargetsWithResult: (message, ids) => {
            sent.push({ message, ids });
        }
    });
    return {
        installed,
        sent,
        readDeliverySurface,
        eligible,
        resolveBroad,
        receive: async (notice: LiveWsNotice) => {
            await installed;
            if (!callback) {
                throw new Error('Subscriber was not installed');
            }
            await callback(notice);
        }
    };
}

describe('live WS notice subscriber', () => {
    it('delivers a two-process notice only where the addressed socket is local', async () => {
        const callbacks: Array<(notice: LiveWsNotice) => Promise<void> | void> = [];
        const transport: LiveWsNoticeTransport = {
            publish: async (notice) => {
                for (const callback of callbacks) {
                    await callback(notice);
                }
            },
            subscribe: async (_channel, callback) => {
                callbacks.push(callback);
            }
        };
        const sentOnPublisher: string[] = [];
        const sentOnReceiver: string[] = [];
        const common = {
            transport,
            channel: 'ws-channel',
            nowMs: () => 1,
            inboundStores: [],
            resolveBroadRecipientSessionIds: () => []
        };
        await installLiveWsNoticeSubscriber({
            ...common,
            publisherId: 'publisher-a',
            filterEligibleRecipientSessionIds: () => [],
            sendToTargetsWithResult: (_message, ids) => {
                sentOnPublisher.push(...ids);
            }
        });
        await installLiveWsNoticeSubscriber({
            ...common,
            publisherId: 'publisher-b',
            filterEligibleRecipientSessionIds: (ids) => ids.filter((id) => id === 'remote-session'),
            sendToTargetsWithResult: (_message, ids) => {
                sentOnReceiver.push(...ids);
            }
        });

        await transport.publish(roomNotice(['remote-session']));

        expect(sentOnPublisher).toEqual([]);
        expect(sentOnReceiver).toEqual(['remote-session']);
    });

    it('sends a remote publisher notice once to the frozen locally eligible room session', async () => {
        const receiver = createReceiver();
        await receiver.receive(roomNotice(['remote-session', 'late-joiner']));

        expect(receiver.sent).toEqual([{ message: roomMessage(), ids: ['remote-session'] }]);
        expect(receiver.readDeliverySurface).not.toHaveBeenCalled();
        expect(receiver.resolveBroad).not.toHaveBeenCalled();
    });

    it('never broadens an empty room audience or processes self, expired, or malformed notices', async () => {
        const receiver = createReceiver();
        await receiver.receive(roomNotice([]));
        await receiver.receive({ ...roomNotice(), publisherId: 'publisher-b' });
        await receiver.receive({ ...roomNotice(), expiresAtMs: 1 });
        await receiver.receive({ ...roomNotice(), audience: { mode: 'room', groupRef, recipientSessionIds: [''] } });

        expect(receiver.sent).toEqual([]);
        expect(receiver.resolveBroad).not.toHaveBeenCalled();
        expect(receiver.readDeliverySurface).not.toHaveBeenCalled();
    });

    it('resolves a broad notice against the local audience at receipt', async () => {
        const receiver = createReceiver();
        const message: ALMessage = { ...roomMessage(), targets: { mode: 'broadcast', scope: 'all', exceptPeerIds: ['excluded'] } };
        const encoded = encodeLiveWsNotice({
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            scope,
            expiresAtMs: deadline,
            audience: { mode: 'broad', targetMode: 'all' },
            message
        });
        if (encoded.kind !== 'inline') {
            throw new Error('Expected inline fixture');
        }
        await receiver.receive(encoded.notice);

        expect(receiver.resolveBroad).toHaveBeenCalledWith(message);
        expect(receiver.sent).toEqual([{ message, ids: ['remote-session'] }]);
    });

    it('reads a 64 KiB canonical room message and sends only its persisted frozen audience', async () => {
        const receiver = createReceiver();
        const largeMessage = roomMessage(JSON.stringify('x'.repeat(64_000)));
        const encoded = encodeLiveWsNotice({
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            scope,
            expiresAtMs: deadline,
            audience: { mode: 'room', groupRef, recipientSessionIds: Array.from({ length: 1000 }, (_, index) => `session-${index}`) },
            message: largeMessage,
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        });
        if (encoded.kind !== 'inbound-key') {
            throw new Error('Expected key fixture');
        }
        receiver.readDeliverySurface.mockResolvedValue({
            msg: largeMessage,
            source: { kind: 'ws-client', peerId: 'sender', groupRecipientPeerIds: ['remote-session'] },
            nowMs: 1,
            supersedenceKey: null,
            supersedence: {},
            supersedenceTrackTtlMs: 1000
        });
        await receiver.receive(encoded.notice);

        expect(receiver.readDeliverySurface).toHaveBeenCalledWith({ senderId: 'sender', msgId: 'message-1' }, 1);
        expect(receiver.sent).toEqual([{ message: largeMessage, ids: ['remote-session'] }]);
    });

    it('treats absent or mismatched canonical authority as a best-effort miss', async () => {
        const receiver = createReceiver();
        const key: Extract<LiveWsNotice, { delivery: 'inbound-key'; }> = {
            kind: 'live-ws',
            version: 1,
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            scope,
            expiresAtMs: deadline,
            delivery: 'inbound-key',
            audienceMode: 'room',
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        };
        await receiver.receive(key);
        receiver.readDeliverySurface.mockResolvedValue({
            msg: roomMessage(),
            source: { kind: 'ws-client', peerId: 'sender' },
            nowMs: 1,
            supersedenceKey: null,
            supersedence: {},
            supersedenceTrackTtlMs: 1000
        });
        await receiver.receive(key);
        await receiver.receive({ ...key, inbound: { namespace: 'other', reference: key.inbound.reference } });

        expect(receiver.sent).toEqual([]);
        expect(receiver.readDeliverySurface).toHaveBeenCalledTimes(2);
    });

    it('rejects a canonical row whose source or scoped room target differs from the notice', async () => {
        const receiver = createReceiver();
        const key: Extract<LiveWsNotice, { delivery: 'inbound-key'; }> = {
            kind: 'live-ws',
            version: 1,
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            scope,
            expiresAtMs: deadline,
            delivery: 'inbound-key',
            audienceMode: 'room',
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        };
        const base: ALInboundStoredPlanningRead = {
            msg: roomMessage(),
            source: { kind: 'ws-client', peerId: 'sender', groupRecipientPeerIds: ['remote-session'] },
            nowMs: 1,
            supersedenceKey: null,
            supersedence: {},
            supersedenceTrackTtlMs: 1000
        };
        for (
            const surface of [
                { ...base, source: { kind: 'ws-client' as const, peerId: 'another', groupRecipientPeerIds: ['remote-session'] } },
                { ...base, msg: { ...roomMessage(), targets: { mode: 'multicast' as const, groupRef: { ...groupRef, workspaceId: 'other' } } } },
                { ...base, msg: { ...roomMessage(), id: { ...roomMessage().id, msgId: 'another' } } }
            ]
        ) {
            receiver.readDeliverySurface.mockResolvedValue(surface);
            await receiver.receive(key);
        }
        expect(receiver.sent).toEqual([]);
    });

    it('drops key-only principal notices because the canonical source has no frozen principal list', async () => {
        const receiver = createReceiver();
        await receiver.receive({
            kind: 'live-ws',
            version: 1,
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            scope,
            expiresAtMs: deadline,
            delivery: 'inbound-key',
            audienceMode: 'principal',
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        });
        expect(receiver.readDeliverySurface).not.toHaveBeenCalled();
        expect(receiver.sent).toEqual([]);
    });

    it('drops key-only peer notices because the canonical unicast target has no persisted recipient scope', async () => {
        const receiver = createReceiver();
        const message: ALMessage = { ...roomMessage(), targets: { mode: 'unicast', toPeerId: 'remote-session' } };
        receiver.readDeliverySurface.mockResolvedValue({
            msg: message,
            source: { kind: 'ws-client', peerId: 'sender' },
            nowMs: 1,
            supersedenceKey: null,
            supersedence: {},
            supersedenceTrackTtlMs: 1000
        });
        await receiver.receive({
            kind: 'live-ws',
            version: 1,
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            scope,
            expiresAtMs: deadline,
            delivery: 'inbound-key',
            audienceMode: 'peer',
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        });
        expect(receiver.sent).toEqual([]);
    });

    it('accepts an earlier logical deadline when a canonical room message has no AL expiry', async () => {
        const receiver = createReceiver();
        const { constraints: _constraints, ...withoutExpiry } = roomMessage();
        const message: ALMessage = withoutExpiry;
        receiver.readDeliverySurface.mockResolvedValue({
            msg: message,
            source: { kind: 'ws-client', peerId: 'sender', groupRecipientPeerIds: ['remote-session'] },
            nowMs: 1,
            supersedenceKey: null,
            supersedence: {},
            supersedenceTrackTtlMs: 1000
        });
        await receiver.receive({
            kind: 'live-ws',
            version: 1,
            channel: 'ws-channel',
            publisherId: 'publisher-a',
            scope,
            expiresAtMs: deadline,
            delivery: 'inbound-key',
            audienceMode: 'room',
            inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
        });
        expect(receiver.sent).toEqual([{ message, ids: ['remote-session'] }]);
    });
});
