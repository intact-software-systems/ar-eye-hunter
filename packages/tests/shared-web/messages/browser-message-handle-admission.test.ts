import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

afterEach(() => vi.useRealTimers());

describe('message handle admission', () => {
    it.each(['rtc', 'ws'] as const)('returns the %s handle while carrier admission is pending', async (carrier) => {
        const admission = Promise.withResolvers<ALOutboundEnqueueResult>();
        const fixture = createSender();
        let envelope: ALMessage | undefined;
        fixture.middleware.middleware[carrier === 'rtc' ? 'rtcRxStreamer' : 'webSocketQueueBox'].enqueueOutboxIfAbsent = (message) => {
            envelope = message;
            return admission.promise;
        };
        let handle: RallarMessageHandle | undefined;
        const sending = fixture.sender[carrier === 'rtc' ? 'sendRtc' : 'sendWs']({ typeId: 'room.ready', payload: true }).then((value) => {
            handle = value;
        });
        try {
            await vi.waitFor(() => expect(handle?.lifecycle().state).toBe('submitted'), { timeout: 100 });
            expect(handle?.msgId).toBe(envelope?.id.msgId);
        }
        finally {
            if (envelope) {
                admission.resolve(toQueued(envelope));
            }
            await sending;
        }
        expect((await handle?.wait({ until: AL_DELIVERY_ADMITTED_STATES }))?.lifecycle.state).toBe('queued');
    });

    it('retains synchronous transport settlement that arrives before admission returns', async () => {
        const fixture = createSender();
        fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent = async (message) => {
            fixture.registry.record({ kind: 'attempt-started', msgId: message.id.msgId, carrier: 'ws', atMs: Date.now(), attemptId: 'sync' });
            fixture.registry.record({
                kind: 'attempt-settled',
                msgId: message.id.msgId,
                carrier: 'ws',
                atMs: Date.now(),
                attemptId: 'sync',
                outcome: 'sent',
                submissionAttempted: true,
                detail: undefined,
                willRetry: false
            });
            return toQueued(message);
        };
        const handle = await fixture.sender.sendWs({ typeId: 'room.ready', payload: true });
        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'transport-accepted',
            evidence: { attempts: [{ attemptId: 'sync', outcome: 'sent' }] }
        });
    });

    it('adopts a shortened admission deadline and expires an already waiting handle at that deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const fixture = createSender();
        const admission = Promise.withResolvers<ALOutboundEnqueueResult>();
        let envelope: ALMessage | undefined;
        fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent = (message) => {
            envelope = message;
            return admission.promise;
        };
        const pendingHandle = fixture.sender.sendWs({ typeId: 'room.ready', payload: true, ttlMs: 60_000 });
        let handle: RallarMessageHandle | undefined;
        void pendingHandle.then((value) => {
            handle = value;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(handle?.lifecycle().state).toBe('submitted');
        if (!handle || !envelope) {
            throw new Error('Expected open handle and pending envelope');
        }
        const waiting = handle.wait();
        admission.resolve(toQueued({ ...envelope, constraints: { ...envelope.constraints, expiresAtMs: 10_100 } }));
        await vi.advanceTimersByTimeAsync(0);
        expect(handle.lifecycle().expiresAtMs).toBe(10_100);
        await vi.advanceTimersByTimeAsync(100);
        expect((await waiting).lifecycle.state).toBe('expired');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('returns a rejected handle for an oversized serializable payload', async () => {
        const fixture = createSender(8);
        const handle = await fixture.sender.sendWs({ typeId: 'room.ready', payload: { text: 'too large' } });
        expect(handle.lifecycle()).toMatchObject({ state: 'rejected', evidence: { reason: 'Payload exceeds 8 bytes.' } });
    });

    it('still throws validation when the payload cannot form an envelope', async () => {
        const fixture = createSender(8);
        await expect(fixture.sender.sendWs({ typeId: 'room.ready', payload: 1n })).rejects.toSatisfy(isRallarValidationError);
    });

    it('returns an unobservable handle without admitting through middleware replaced before sender continuation', async () => {
        const fixture = createSender();
        const admission = vi.spyOn(fixture.middleware.middleware.webSocketQueueBox, 'enqueueOutboxIfAbsent');
        const sending = fixture.sender.sendWs({ typeId: 'room.ready', payload: true });
        fixture.replaceTransport();
        const handle = await sending;
        await vi.waitFor(() => expect(handle.lifecycle().state).toBe('unobservable'), { timeout: 100 });
        expect(admission).not.toHaveBeenCalled();
    });

    it('records a queue wake failure on the already returned handle', async () => {
        const fixture = createSender();
        fixture.middleware.middleware.qboxEngine.wake = () => {
            throw new Error('Queue wake failed');
        };
        const handle = await fixture.sender.sendWs({ typeId: 'room.ready', payload: true });
        await vi.waitFor(() => expect(handle.lifecycle()).toMatchObject({ state: 'failed', evidence: { reason: 'Queue wake failed' } }), { timeout: 100 });
    });

    it('records a carrier rejection as a failed handle instead of an unhandled admission promise', async () => {
        const fixture = createSender();
        fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent = async () => {
            throw new Error('Storage unavailable');
        };
        const handle = await fixture.sender.sendWs({ typeId: 'room.ready', payload: true });
        expect((await handle.wait()).lifecycle).toMatchObject({ state: 'failed', evidence: { reason: 'Storage unavailable' } });
    });
});

function createSender(maxPayloadBytes = 64 * 1024) {
    const registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 60_000, maxEntries: 512, cancel: () => {} });
    const middleware = createDefaultApiMiddlewareTestDouble();
    let activeMiddleware = middleware;
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(registry, { deliverySettlements: feed, readMiddleware: () => activeMiddleware });
    sessionDeliveries.beginSession(middleware.session);
    feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
    const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
    const sender = new BrowserRallarMessageSender({
        deliveries: registry,
        dispatch: new BrowserRallarMessageDispatch({ deliveries: registry, sessionDeliveries, nowMs: Date.now }),
        inputValidator: new BrowserMessageInputValidator({ readMaxPayloadBytes: () => maxPayloadBytes }),
        connect: async () => middleware,
        requireSession: () => middleware.session,
        resolveDefaultRoom: () => roomRef,
        resolveCurrentRoomRef: () => roomRef,
        toRoomId: (room) => typeof room === 'string' ? room : room?.groupId,
        resolveRoomRef: () => roomRef,
        resolveRoomMinSnapshotVersion: (_room, explicit) => explicit
    });
    return {
        sender,
        registry,
        middleware,
        replaceTransport: () => {
            activeMiddleware = createDefaultApiMiddlewareTestDouble();
            feed.close();
            feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
        }
    };
}

function toQueued(message: ALMessage): ALOutboundEnqueueResult {
    return { status: 'enqueued', verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 }, message, entries: [] };
}
