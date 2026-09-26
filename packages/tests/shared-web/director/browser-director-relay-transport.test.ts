import { BrowserDirectorRelayTransport } from '@shared-web/browser/director/browser-director-relay-transport.ts';
import type { RallarDirectorRelayEnvelope, RallarDirectorStatus } from '@shared-web/browser/director/rallar-director-facade.ts';
import type {
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createMessageDelivery, type MessageDeliveryFixture } from '../messages/test-message-delivery.ts';

const current: RallarDirectorStatus = {
    roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
    roomId: 'room',
    role: 'director',
    state: 'fresh',
    isDirector: true,
    isFresh: true,
    active: true,
    freshness: 'fresh',
    nowEpochMs: 0,
    appointment: { version: 1, mode: 'appointed-spa', sessionId: 'director', principalId: 'principal', epoch: 1, appointedAtEpochMs: 0, heartbeatTtlMs: 5_000 }
};
const envelopeInput = { current, topicId: 'room.director', typeId: 'output', payload: { revision: 1 }, ack: undefined };

describe('director delivery admission', () => {
    afterEach(() => vi.useRealTimers());

    it.each(['queued', 'superseded'] as const)('waits for RTC then treats %s as sent without stale WS fallback', async (state) => {
        const rtc = createMessageDelivery('rtc', undefined);
        const ws = vi.fn(async () => createMessageDelivery('ws', { kind: 'admitted', durable: true, queuedAttempts: 1 }).handle);
        const transport = createTransport(rtc, ws);
        let completed = false;
        const sending = transport.sendRoomEnvelope(envelopeInput).then((result) => {
            completed = true;
            return result;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(completed).toBe(false);
        expect(ws).not.toHaveBeenCalled();
        rtc.registry.record({
            kind: 'admission',
            carrier: 'rtc',
            msgId: rtc.handle.msgId,
            atMs: Date.now(),
            verdict: state === 'queued' ? { kind: 'admitted', durable: true, queuedAttempts: 1 } : { kind: 'superseded', detail: 'Newer state' }
        });
        expect(await sending).toEqual({ status: 'sent', rtc: rtc.handle });
        expect(ws).not.toHaveBeenCalled();
    });

    it('falls back after failed RTC and reports WS refusal reason', async () => {
        const rtc = createMessageDelivery('rtc', { kind: 'failed', detail: 'RTC failed' });
        const ws = createMessageDelivery('ws', { kind: 'refused', reason: 'unauthorized', detail: 'Room denied' });
        expect(await createTransport(rtc, async () => ws.handle).sendRoomEnvelope(envelopeInput)).toEqual({
            status: 'failed',
            rtc: rtc.handle,
            ws: ws.handle,
            reason: 'Room denied'
        });
    });

    it('bounds RTC admission at the existing budget and releases its wait before fallback', async () => {
        vi.useFakeTimers();
        const rtc = createMessageDelivery('rtc', undefined);
        const ws = createMessageDelivery('ws', { kind: 'admitted', durable: true, queuedAttempts: 1 });
        const sending = createTransport(rtc, async () => ws.handle).sendRoomEnvelope(envelopeInput);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await sending).toEqual({ status: 'sent', rtc: rtc.handle, ws: ws.handle });
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('director receipt output', () => {
    const receiptInput = { ...envelopeInput, ack: 'all-logical-recipients' } as const;

    it('sends one room message over the RTC-with-WS-fallback strategy and returns its handle as the receipt', async () => {
        const receipt = createMessageDelivery('rtc', { kind: 'admitted', durable: true, queuedAttempts: 1 });
        const room = createRoomChannel(async () => receipt.handle);
        const transport = createTransport(createMessageDelivery('rtc', undefined), rejectCarrierSend, {
            room: toRoomOperation(room),
            rtcSend: rejectCarrierSend
        });

        expect(await transport.sendRoomEnvelope(receiptInput)).toEqual({ status: 'sent', receipt: receipt.handle });
        expect(room.open).toHaveBeenCalledWith({
            topicId: 'room.director',
            typeId: 'output',
            roomRef: current.roomRef,
            purpose: 'notification'
        });
        expect(room.send).toHaveBeenCalledWith(
            expect.objectContaining({ protocol: 'rallar.director.relay.v1', typeId: 'output', payload: { revision: 1 } }),
            { strategy: 'rtc-with-ws-fallback', reliability: 'at-least-once', ack: 'all-logical-recipients', ttlMs: 30_000 }
        );
    });

    it('reports a refused receipt output with its reason and no second carrier send', async () => {
        const receipt = createMessageDelivery('ws', { kind: 'refused', reason: 'unauthorized', detail: 'Room denied' });
        const room = createRoomChannel(async () => receipt.handle);
        const transport = createTransport(createMessageDelivery('rtc', undefined), rejectCarrierSend, {
            room: toRoomOperation(room),
            rtcSend: rejectCarrierSend
        });

        expect(await transport.sendRoomEnvelope(receiptInput)).toEqual({ status: 'failed', receipt: receipt.handle, reason: 'Room denied' });
    });

    it('keeps a best-effort output on the two-send path without a room channel', async () => {
        const rtc = createMessageDelivery('rtc', { kind: 'admitted', durable: true, queuedAttempts: 1 });
        const rtcSend = vi.fn(async () => rtc.handle);
        const transport = createTransport(rtc, rejectCarrierSend, {
            room: () => {
                throw new Error('A best-effort output must not use the receipt channel.');
            },
            rtcSend
        });

        expect(await transport.sendRoomEnvelope(envelopeInput)).toEqual({ status: 'sent', rtc: rtc.handle });
        expect(rtcSend).toHaveBeenCalledWith(expect.objectContaining({ reliability: 'best-effort', ack: 'none', ttlMs: 5_000 }));
    });
});

async function rejectCarrierSend(): Promise<never> {
    throw new Error('This output must not reach a carrier-pinned send.');
}

interface OutputPayload {
    readonly revision: number;
}

interface RoomChannelDouble {
    readonly open: Mock<(definition: RallarRoomMessageChannelDefinition) => RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>>>;
    readonly send: Mock<RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>>['send']>;
}

function createRoomChannel(send: RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>>['send']): RoomChannelDouble {
    const sendDouble = vi.fn<RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>>['send']>(send);
    const channel: RallarTypedMessageChannel<RallarDirectorRelayEnvelope<OutputPayload>> = {
        send: sendDouble,
        sendRtc: rejectCarrierSend,
        sendWs: rejectCarrierSend,
        onRtc: () => () => {},
        onWs: () => () => {}
    };
    const open = vi.fn((_definition: RallarRoomMessageChannelDefinition) => channel);
    return { open, send: sendDouble };
}

function toRoomOperation(room: RoomChannelDouble): RallarMessagesOperations['room'] {
    return <T>(definition: RallarRoomMessageChannelDefinition) => room.open(definition) as RallarTypedMessageChannel<T>;
}

interface TransportChannels {
    readonly room: RallarMessagesOperations['room'];
    readonly rtcSend: RallarMessagesOperations['rtc']['send'];
}

function createTransport(
    rtc: MessageDeliveryFixture,
    sendWs: RallarMessagesOperations['ws']['send'],
    channels?: TransportChannels
): BrowserDirectorRelayTransport {
    return new BrowserDirectorRelayTransport({
        messages: {
            rtc: { send: channels?.rtcSend ?? (async () => rtc.handle), onMessage: () => () => {} },
            ws: { send: sendWs, onMessage: () => () => {} },
            channel: () => {
                throw new Error('Not a typed channel test');
            },
            room: channels?.room ?? (() => {
                throw new Error('Not a room test');
            })
        },
        readSession: () => ({ clientId: 'client', sessionId: 'session', username: 'user', accessToken: 'test', expiresAtEpochMs: 60_000 }),
        createTargetedChannel: () => {
            throw new Error('Room output must use room messages.');
        },
        sendWsUnicast: async () => {
            throw new Error('Room output must not send unicast.');
        }
    });
}
