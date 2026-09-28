import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryCarrier,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const FROZEN_AUDIENCE = { recipientPeerIds: ['peer-1'], snapshotVersion: 4 };
const EXHAUSTED_DETAIL = 'The receipt ran out of retries after 3 of 3.';
const ADMITTED: ALDeliveryAdmissionVerdict = { kind: 'admitted', durable: false, queuedAttempts: 1 };

interface FallbackAdmission {
    readonly carrier: ALDeliveryCarrier;
    readonly message: ALMessage;
}

interface FallbackFixture {
    readonly admissions: FallbackAdmission[];
    readonly handedOver: string[];
    settle(settlement: ALDeliverySettlement): void;
    /** `canFallback: false` is a plain single-carrier send (D65). */
    send(firstCarrier: ALDeliveryCarrier, ttlMs: number, canFallback?: boolean): Promise<RallarMessageHandle>;
}

/**
 * The production dispatch, registry and session owner over carrier doubles: RTC admits everything, WS
 * answers with `wsVerdict`, and the RTC hand-over rejects with `handOverError` when one is given.
 */
function createFallbackFixture(
    wsVerdict: ALDeliveryAdmissionVerdict = ADMITTED,
    handOverError?: Error
): FallbackFixture {
    const admissions: FallbackAdmission[] = [];
    const handedOver: string[] = [];
    const admit = async (
        carrier: ALDeliveryCarrier,
        message: ALMessage
    ): Promise<ALOutboundEnqueueResult> => {
        // The RTC admission freezes the room, as the overlay planner does; WS takes the envelope it is handed.
        const admitted = carrier === 'rtc'
            ? toALFrozenMulticastMessage(message, FROZEN_AUDIENCE)
            : message;
        admissions.push({ carrier, message: admitted });
        return {
            verdict: carrier === 'rtc' ? ADMITTED : wsVerdict,
            message: admitted,
            entries: [],
            trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(admitted)
        };
    };
    const context = createDefaultApiMiddlewareTestDouble({
        middleware: {
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: (message) => admit('rtc', message),
                handOverOutbox: async (msgId) => {
                    handedOver.push(msgId);
                    if (handOverError !== undefined) {
                        throw handOverError;
                    }
                }
            },
            webSocketQueueBox: { enqueueOutboxIfAbsent: (message) => admit('ws', message) }
        }
    });
    const deliveries = new BrowserRallarDeliveryRegistry({
        nowMs: Date.now,
        retainTerminalMs: 60_000,
        maxEntries: 512,
        cancel: () => {}
    });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, {
        deliverySettlements: feed,
        readMiddleware: () => context
    });
    sessionDeliveries.beginSession(context.session);
    const epoch = feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
    const dispatch = new BrowserRallarMessageDispatch({
        deliveries,
        sessionDeliveries,
        nowMs: Date.now
    });
    return {
        admissions,
        handedOver,
        settle: (settlement) => epoch.settlements[settlement.carrier](settlement),
        send: async (firstCarrier, ttlMs, canFallback = true) => {
            const message = newALMulticastMessage(
                context.session.sessionId,
                { topicId: 'room.command', resourceId: crypto.randomUUID(), contextId: 'room-1' },
                ROOM,
                'room.command.v1',
                { action: 'ready' },
                { reliability: 'at-least-once', ack: 'receiver', ttlMs }
            );
            const handle = deliveries.open(message, firstCarrier);
            dispatch.send({
                context,
                carrier: firstCarrier,
                message,
                canFallback,
                payloadIssues: []
            });
            await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });
            return handle;
        }
    };
}

function toNotReady(
    msgId: string,
    attemptId: string
): Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-settled'; }>> {
    return {
        kind: 'attempt-settled',
        msgId,
        carrier: 'rtc',
        atMs: Date.now(),
        attemptId,
        outcome: 'not-ready',
        submissionAttempted: false,
        detail: 'The RTC frame was dropped.',
        willRetry: true
    };
}

function toExhausted(msgId: string, carrier: ALDeliveryCarrier): ALDeliverySettlement {
    return {
        kind: 'receipt-exhausted',
        msgId,
        carrier,
        atMs: Date.now(),
        mode: 'receiver',
        confirmedPeerIds: [],
        unconfirmedPeerIds: ['peer-1'],
        cause: 'budget',
        detail: EXHAUSTED_DETAIL
    };
}

function toNotYetInSyncExhausted(msgId: string): ALDeliverySettlement {
    return {
        kind: 'not-yet-in-sync-exhausted',
        msgId,
        carrier: 'rtc',
        atMs: Date.now(),
        detail: 'The not-yet-in-sync retry budget of 3 ran out.'
    };
}

function toReceipt(
    msgId: string,
    carrier: ALDeliveryCarrier,
    confirmed: readonly string[]
): ALDeliverySettlement {
    return {
        kind: 'acknowledgement',
        msgId,
        carrier,
        atMs: Date.now(),
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: ['peer-1'],
        confirmedRecipientPeerIds: confirmed,
        unconfirmedRecipientPeerIds: ['peer-1'].filter((peerId) => !confirmed.includes(peerId)),
        complete: confirmed.length === 1
    };
}

/** The WS admission's own settlement follows its carrier call in a later microtask; one task turn lands it. */
async function waitForCarriers(
    fixture: FallbackFixture,
    carriers: readonly ALDeliveryCarrier[]
): Promise<void> {
    await vi.waitFor(() => expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(carriers));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('post-admission fallback within the deadline (D56)', () => {
    it('hands the RTC leg to WS on the third consecutive not-ready attempt, with the frozen envelope and its deadline', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle(toNotReady(handle.msgId, 'send-a'));
        fixture.settle(toNotReady(handle.msgId, 'send-b'));
        expect(fixture.handedOver).toEqual([]);
        fixture.settle(toNotReady(handle.msgId, 'send-a'));

        await waitForCarriers(fixture, ['rtc', 'ws']);
        expect(fixture.handedOver).toEqual([handle.msgId]);
        // Same msgId, frozen audience and `expiresAtMs`: the WS leg is the envelope the RTC admission returned.
        expect(fixture.admissions[1]!.message).toEqual(fixture.admissions[0]!.message);
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            from: 'rtc',
            to: 'ws',
            reason: 'not-ready'
        });
        expect(handle.lifecycle().state).toBe('queued');
    });

    it('restarts the count when an RTC attempt is sent', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle(toNotReady(handle.msgId, 'send-a'));
        fixture.settle(toNotReady(handle.msgId, 'send-a'));
        fixture.settle({
            ...toNotReady(handle.msgId, 'send-b'),
            outcome: 'sent',
            submissionAttempted: true,
            willRetry: false
        });
        fixture.settle(toNotReady(handle.msgId, 'send-a'));
        fixture.settle(toNotReady(handle.msgId, 'send-a'));

        expect(fixture.handedOver).toEqual([]);
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['rtc']);
    });

    it('hands over a receipt that ran out on RTC instead of failing the handle', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle(toExhausted(handle.msgId, 'rtc'));

        await waitForCarriers(fixture, ['rtc', 'ws']);
        expect(handle.lifecycle().state).not.toBe('failed');
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            reason: 'receipt-exhausted',
            detail: EXHAUSTED_DETAIL
        });
        // The evidence row reached the reducer instead of the RTC exhaustion, so nothing ended the handle.
        expect(handle.lifecycle().evidence.reason).toBeUndefined();
    });

    it('hands over a spent not-yet-in-sync budget', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle(toNotYetInSyncExhausted(handle.msgId));

        await waitForCarriers(fixture, ['rtc', 'ws']);
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            reason: 'not-yet-in-sync-exhausted'
        });
    });

    it('falls back once, and a late RTC receipt moves nothing once WS owns the receipt', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);
        fixture.settle(toExhausted(handle.msgId, 'rtc'));
        await waitForCarriers(fixture, ['rtc', 'ws']);

        // The RTC owner states its NYIS exhaustion on every later NACK; the open handle hands over only once.
        fixture.settle(toNotYetInSyncExhausted(handle.msgId));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fixture.handedOver).toEqual([handle.msgId]);
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['rtc', 'ws']);
        expect(handle.lifecycle().state).toBe('queued');

        fixture.settle(toReceipt(handle.msgId, 'ws', ['peer-1']));
        const acknowledged = handle.lifecycle();
        fixture.settle(toReceipt(handle.msgId, 'rtc', []));
        fixture.settle(toExhausted(handle.msgId, 'rtc'));

        expect(acknowledged.state).toBe('acknowledged');
        expect(handle.lifecycle().evidence).toEqual(acknowledged.evidence);
        expect(fixture.handedOver).toEqual([handle.msgId]);
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['rtc', 'ws']);
    });

    it('stays on RTC once the deadline passed: the receipt end is the message end', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 50);
        await new Promise((resolve) => setTimeout(resolve, 60));

        fixture.settle(toExhausted(handle.msgId, 'rtc'));

        expect(handle.lifecycle().state).toBe('failed');
        expect(fixture.handedOver).toEqual([]);
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['rtc']);
    });

    it('leaves the receipt end of a WS-first leg the message end (Q1)', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('ws', 30_000);

        fixture.settle(toExhausted(handle.msgId, 'ws'));

        expect(handle.lifecycle().state).toBe('failed');
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['ws']);
    });

    it('never watches a plain RTC send: its receipt end is the message end (D65)', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000, false);

        fixture.settle(toExhausted(handle.msgId, 'rtc'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(handle.lifecycle().state).toBe('failed');
        expect(fixture.handedOver).toEqual([]);
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['rtc']);
    });

    it('ends the handle rejected when WS refuses the handed-over message, after one hand-over', async () => {
        const fixture = createFallbackFixture({
            kind: 'refused',
            reason: 'oversized',
            detail: 'The frame exceeds the WS limit.'
        });
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle(toExhausted(handle.msgId, 'rtc'));
        await waitForCarriers(fixture, ['rtc', 'ws']);

        expect(handle.lifecycle().state).toBe('rejected');
        expect(fixture.handedOver).toEqual([handle.msgId]);
    });

    it('admits the message on WS even when the RTC hand-over rejects', async () => {
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        const fixture = createFallbackFixture(ADMITTED, new Error('The RTC owner is disposed.'));
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle(toExhausted(handle.msgId, 'rtc'));
        await waitForCarriers(fixture, ['rtc', 'ws']);

        expect(fixture.handedOver).toEqual([handle.msgId]);
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({ reason: 'receipt-exhausted' });
        fixture.settle(toReceipt(handle.msgId, 'ws', ['peer-1']));
        expect(handle.lifecycle().state).toBe('acknowledged');
        quiet.mockRestore();
    });

    it('releases the candidate when the handle is cancelled: a later RTC trigger hands nothing over', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);

        handle.cancel();
        fixture.settle(toExhausted(handle.msgId, 'rtc'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(handle.lifecycle().state).toBe('cancelled');
        expect(fixture.handedOver).toEqual([]);
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['rtc']);
    });
});
