import { BrowserDirectorRelayTransport } from '@shared-web/browser/director/browser-director-relay-transport.ts';
import type { RallarDirectorStatus } from '@shared-web/browser/director/rallar-director-facade.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const envelopeInput = { current, topicId: 'room.director', typeId: 'output', payload: { revision: 1 } };

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

function createTransport(rtc: MessageDeliveryFixture, sendWs: RallarMessagesOperations['ws']['send']): BrowserDirectorRelayTransport {
    return new BrowserDirectorRelayTransport({
        messages: {
            rtc: { send: async () => rtc.handle, onMessage: () => () => {} },
            ws: { send: sendWs, onMessage: () => () => {} },
            channel: () => {
                throw new Error('Not a typed channel test');
            },
            room: () => {
                throw new Error('Not a room test');
            }
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
