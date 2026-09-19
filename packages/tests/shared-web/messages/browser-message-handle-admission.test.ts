import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import { createBrowserMessageSenderFixture, toQueuedMessageAdmission } from './browser-message-sender-fixture.ts';

afterEach(() => vi.useRealTimers());

describe('message handle admission', () => {
    it.each(['ws', 'rtc', 'unicast', 'fallback'] as const)('captures the once-validated payload before deferred %s connection', async (path) => {
        const fixture = createBrowserMessageSenderFixture(20);
        const connection = Promise.withResolvers<ApiMiddleware>();
        fixture.connect.mockReturnValue(connection.promise);
        const payload = { text: 'a' };
        const envelope = vi.spyOn(
            fixture.middleware.middleware[path === 'rtc' || path === 'fallback' ? 'rtcRxStreamer' : 'webSocketQueueBox'],
            'enqueueOutboxIfAbsent'
        );
        const sending = path === 'unicast'
            ? fixture.sender.sendWsUnicast({ peerId: 'peer', typeId: 'app.ready', payload, route: { topicId: 'app.ready', contextId: 'all' } })
            : path === 'fallback'
            ? fixture.sender.sendTyped({ typeId: 'app.ready', payload })
            : path === 'rtc'
            ? fixture.sender.sendRtc({ typeId: 'app.ready', payload })
            : fixture.sender.sendWs({ typeId: 'app.ready', payload });
        payload.text = 'x'.repeat(100);
        connection.resolve(fixture.middleware);
        const handle = await sending;
        await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(envelope.mock.calls[0][0].payload.resource).toBe('{"text":"a"}');
        expect(handle.lifecycle().state).toBe('queued');
    });

    it.each(['rtc', 'ws'] as const)('returns the %s handle while carrier admission is pending', async (carrier) => {
        const admission = Promise.withResolvers<ALOutboundEnqueueResult>();
        const fixture = createBrowserMessageSenderFixture();
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
                admission.resolve(toQueuedMessageAdmission(envelope));
            }
            await sending;
        }
        expect((await handle?.wait({ until: AL_DELIVERY_ADMITTED_STATES }))?.lifecycle.state).toBe('queued');
    });

    it('retains synchronous transport settlement that arrives before admission returns', async () => {
        const fixture = createBrowserMessageSenderFixture();
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
            return toQueuedMessageAdmission(message);
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
        const fixture = createBrowserMessageSenderFixture();
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
        admission.resolve(toQueuedMessageAdmission({ ...envelope, constraints: { ...envelope.constraints, expiresAtMs: 10_100 } }));
        await vi.advanceTimersByTimeAsync(0);
        expect(handle.lifecycle().expiresAtMs).toBe(10_100);
        await vi.advanceTimersByTimeAsync(100);
        expect((await waiting).lifecycle.state).toBe('expired');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('returns a rejected handle for an oversized serializable payload', async () => {
        const fixture = createBrowserMessageSenderFixture(8);
        const handle = await fixture.sender.sendWs({ typeId: 'room.ready', payload: { text: 'too large' } });
        expect(handle.lifecycle()).toMatchObject({ state: 'rejected', evidence: { reason: 'Payload exceeds 8 bytes.' } });
    });

    it('still throws validation when the payload cannot form an envelope', async () => {
        const fixture = createBrowserMessageSenderFixture(8);
        await expect(fixture.sender.sendWs({ typeId: 'room.ready', payload: 1n })).rejects.toSatisfy(isRallarValidationError);
    });

    it('returns an unobservable handle without admitting through middleware replaced before sender continuation', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const sending = fixture.sender.sendWs({ typeId: 'room.ready', payload: true });
        fixture.replaceTransport();
        const handle = await sending;
        await vi.waitFor(() => expect(handle.lifecycle().state).toBe('unobservable'), { timeout: 100 });
    });

    it('records a queue wake failure on the already returned handle', async () => {
        const fixture = createBrowserMessageSenderFixture();
        fixture.middleware.middleware.qboxEngine.wake = () => {
            throw new Error('Queue wake failed');
        };
        const handle = await fixture.sender.sendWs({ typeId: 'room.ready', payload: true });
        await vi.waitFor(() => expect(handle.lifecycle()).toMatchObject({ state: 'failed', evidence: { reason: 'Queue wake failed' } }), { timeout: 100 });
    });

    it('records a carrier rejection as a failed handle instead of an unhandled admission promise', async () => {
        const fixture = createBrowserMessageSenderFixture();
        fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent = async () => {
            throw new Error('Storage unavailable');
        };
        const handle = await fixture.sender.sendWs({ typeId: 'room.ready', payload: true });
        expect((await handle.wait()).lifecycle).toMatchObject({ state: 'failed', evidence: { reason: 'Storage unavailable' } });
    });
});
