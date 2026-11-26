import 'fake-indexeddb/auto';
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import type { ALInboundMessageOwner } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { toALInboundLocalDeliveryEffectId } from '@shared/alm/inbound/al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createInboundTestRoomMessage,
    toInboundTestForgedCopy,
    toInboundTestForgedText
} from '../create-inbound-test-room-message.ts';
import {
    createInboundTestBackendStores,
    createInboundTestRuntime,
    INBOUND_TEST_SENDER_PEER_ID,
    runInboundWorkDueNow,
    type InboundTestRuntime,
    type InboundTestStorage
} from '../inbound-runtime-test-fixture.ts';
import { readInboundTestMessageOwner } from '../read-inbound-test-message-owner.ts';

const RTC_ARRIVAL: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID };
const WS_ARRIVAL: ALInboundMessageRuntime.Source = { kind: 'trusted-server' };

/** One receiving session whose RTC and WS carriers share one inbound store, as a browser page's carriers do. */
interface TwoCarrierReceiver {
    readonly overRtc: InboundTestRuntime;
    readonly overWs: InboundTestRuntime;
    /** Reads the message owner row the shared store holds for `message`. */
    readOwner(message: ALMessage): Promise<ALInboundMessageOwner | undefined>;
}

/**
 * Ruling 1 (D756) at the inbound runtime: a copy the WS server delivered is origin-authenticated, an unsigned RTC copy
 * is not, and only a copy that asks a logical receipt is readmitted over an unauthenticated first admission.
 */
describe('an origin-authenticated readmission at the inbound runtime (ruling 1)', () => {
    it('keeps a WS fallback copy of an unreceipted send a duplicate of the RTC copy it already delivered: one delivery', async () => {
        const receiver = await createTwoCarrierReceiver('memory');
        const message = createInboundTestRoomMessage('unreceipted', 'none', 'volatile');

        expect((await receiver.overRtc.runtime.admitIncomingMessage(message, RTC_ARRIVAL)).right).toEqual({ kind: 'admitted' });
        expect((await receiver.overWs.runtime.admitIncomingMessage(message, WS_ARRIVAL)).right).toEqual({ kind: 'duplicate' });
        await drainBoth(receiver);

        expect([...receiver.overRtc.delivered, ...receiver.overWs.delivered]).toEqual(['dispatched']);
    });

    it.each<[InboundTestStorage, ALDurabilityAlgo]>([
        ['memory', 'volatile'],
        ['indexeddb', 'local-inbox']
    ])(
        'admits the WS copy of a receipted send over a forged unreceipted RTC copy as new, and confirms it, as a relay\'s leaf does (%s, %s)',
        async (storage, durability) => {
            const receiver = await createTwoCarrierReceiver(storage);
            const origin = createInboundTestRoomMessage(`receipted-${storage}`, 'receiver', durability);
            const forged = toInboundTestForgedCopy(origin);

            expect((await receiver.overRtc.runtime.admitIncomingMessage(forged, RTC_ARRIVAL)).right).toEqual({ kind: 'admitted' });
            await drainBoth(receiver);
            expect((await receiver.overWs.runtime.admitIncomingMessage(origin, WS_ARRIVAL)).right).toEqual({ kind: 'admitted' });
            await drainBoth(receiver);

            expect(readDeliveredTexts(receiver)).toEqual([toInboundTestForgedText(origin), originText(origin)]);
            expect(readAckStatuses(receiver.overWs)).toEqual(['delivered']);
            expect(await receiver.readOwner(origin)).toMatchObject({ originAuthenticated: true });
            // The origin's authenticated admission now owns the row: a further unsigned copy is its duplicate.
            expect((await receiver.overRtc.runtime.admitIncomingMessage(forged, RTC_ARRIVAL)).right).toEqual({ kind: 'duplicate' });
        }
    );

    it('waits while the forged copy\'s delivery is still queued, then delivers each content once, the origin\'s last', async () => {
        const receiver = await createTwoCarrierReceiver('memory');
        const origin = createInboundTestRoomMessage('queued-first', 'receiver', 'volatile');

        expect((await receiver.overRtc.runtime.admitIncomingMessage(toInboundTestForgedCopy(origin), RTC_ARRIVAL)).right)
            .toEqual({ kind: 'admitted' });
        expect((await receiver.overWs.runtime.admitIncomingMessage(origin, WS_ARRIVAL)).right)
            .toEqual({ kind: 'pending-admission' });
        await vi.waitFor(async () => {
            await drainBoth(receiver);
            expect(readDeliveredTexts(receiver)).toHaveLength(2);
        });

        expect(readDeliveredTexts(receiver)).toEqual([toInboundTestForgedText(origin), originText(origin)]);
        expect(readAckStatuses(receiver.overWs)).toEqual(['delivered']);
    });

    it('brings a readmitted delivery that waits out a retry due now, as any retained delivery is', async () => {
        const receiver = await createTwoCarrierReceiver('memory', 'retry');
        const origin = createInboundTestRoomMessage('readmitted-retry', 'receiver', 'volatile');
        await receiver.overRtc.runtime.admitIncomingMessage(toInboundTestForgedCopy(origin), RTC_ARRIVAL);
        await drainBoth(receiver);
        await receiver.overWs.runtime.admitIncomingMessage(origin, WS_ARRIVAL);
        await vi.waitFor(async () => expect((await readReadmittedDelivery(receiver, origin))?.status).toBe(EntityStatus.RETRY));
        const retrying = (await readReadmittedDelivery(receiver, origin))!;
        const later: ResourceEntry = {
            ...retrying,
            dequeueAudit: { ...retrying.dequeueAudit, nextTs: Temporal.Now.instant().add({ minutes: 1 }) }
        };
        expect(await receiver.overWs.stores.workQueue.replaceIfObserved(retrying, later)).not.toBeNull();
        const deliveredBefore = receiver.overWs.delivered.length;

        expect(await receiver.overWs.runtime.writeRetainedDeliveriesDueNow([origin])).toEqual([origin]);
        await vi.waitFor(() => expect(receiver.overWs.delivered.length).toBe(deliveredBefore + 1));
    });
});

async function createTwoCarrierReceiver(
    storage: InboundTestStorage,
    wsDispatchOutcome: 'completed' | 'retry' = 'completed'
): Promise<TwoCarrierReceiver> {
    const namespace = `readmission-${storage}`;
    const { backend, stores } = createInboundTestBackendStores({
        namespace,
        storage,
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const overRtc = createInboundTestRuntime({ carrier: 'rtc', stores, effectWorkerId: `al-inbound:readmission-rtc-${storage}` });
    const overWs = createInboundTestRuntime({
        carrier: 'ws',
        stores,
        effectWorkerId: `al-inbound:readmission-ws-${storage}`,
        dispatchOutcome: wsDispatchOutcome
    });
    await overRtc.runtime.ready();
    await overWs.runtime.ready();
    const readOwner = async (message: ALMessage) =>
        await readInboundTestMessageOwner({ backend, namespace, msgId: message.id.msgId, senderId: message.id.senderId });
    return { overRtc, overWs, readOwner };
}

async function drainBoth(receiver: TwoCarrierReceiver): Promise<void> {
    await runInboundWorkDueNow(receiver.overRtc);
    await runInboundWorkDueNow(receiver.overWs);
}

function readAckStatuses(fixture: InboundTestRuntime): readonly string[] {
    return fixture.controlSends.flat().flatMap((control) => {
        const parsed = parseALControlMessage(control);
        return parsed?.type === 'ack' ? [parsed.payload.status] : [];
    });
}

function originText(origin: ALMessage): string {
    return origin.payload.resource;
}

/** Each content the receiving application got, over either carrier, in dispatch order. */
function readDeliveredTexts(receiver: TwoCarrierReceiver): readonly string[] {
    return [...receiver.overRtc.deliveredMessages, ...receiver.overWs.deliveredMessages].map((message) => message.payload.resource);
}

async function readReadmittedDelivery(receiver: TwoCarrierReceiver, origin: ALMessage): Promise<ResourceEntry | undefined> {
    const { workQueue, admissionStore } = receiver.overWs.stores;
    return await workQueue.getItem(toALInboundWorkKey(admissionStore.namespace, toALInboundLocalDeliveryEffectId(origin, true)));
}
