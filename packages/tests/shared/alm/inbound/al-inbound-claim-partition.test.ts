import '../../../setup-browser-indexeddb.ts';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALDeliveryCarrier } from '@shared/alm/inbound/al-inbound-source-validation.ts';
import { toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

import {
    createInboundTestAdmission,
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    planInboundTestMessage,
    type InboundTestRuntime,
    type InboundTestStorage
} from '../inbound-runtime-test-fixture.ts';

const PARTITION_NAMESPACE = 'al-inbound-claim-partition';
/** Enough rounds for the rotation to walk NEW, RETRY and RESERVED several times over. */
const DRAIN_ROUNDS = 24;
const TRUSTED_SERVER: ALInboundMessageRuntime.Source = { kind: 'trusted-server' };

interface CarrierTestRuntime extends InboundTestRuntime {
    /** The msgId of every message this runtime's dispatcher received, in dispatch order. */
    readonly dispatchedMsgIds: readonly string[];
}

function createStores(storage: InboundTestStorage): ALInboundRuntimeStores {
    return createInboundTestStores({
        namespace: PARTITION_NAMESPACE,
        storage,
        observer: createPassThroughIndexedDbOperationObserver()
    });
}

function createCarrierRuntime(stores: ALInboundRuntimeStores, carrier: ALDeliveryCarrier): CarrierTestRuntime {
    const dispatchedMsgIds: string[] = [];
    const runtime = createInboundTestRuntime({
        stores,
        carrier,
        effectWorkerId: `claim-partition-${carrier}`,
        gateDispatch: async (msg) => {
            dispatchedMsgIds.push(msg.id.msgId);
        }
    });
    return { ...runtime, dispatchedMsgIds };
}

function createSenderMessage(msgId: string, senderId: string): ALMessage {
    return createInboundTestMessage({ msgId, senderId });
}

function toRtcPeer(peerId: string): ALInboundMessageRuntime.Source {
    return { kind: 'rtc-peer', peerId };
}

/** Every engine round of every runtime, with a macrotask between rounds so each claim settles. */
async function drain(runtimes: readonly InboundTestRuntime[]): Promise<void> {
    for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
        for (const runtime of runtimes) {
            await runtime.queueEngine.executeOnce();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function readWorkStatuses(stores: ALInboundRuntimeStores, carrier: ALDeliveryCarrier): Promise<EntityStatus[]> {
    const typeId = toALInboundWorkType(stores.admissionStore.namespace, carrier);
    const entries = await Promise.all((await stores.workQueue.getAllKeys()).map((key) => stores.workQueue.getItem(key)));
    return entries.flatMap((entry) => entry !== undefined && entry.typeId === typeId ? [entry.status] : []);
}

it.each(
    [
        [{ kind: 'rtc-peer', peerId: 'p1' }, 'rtc'],
        [{ kind: 'ws-client', peerId: 's1' }, 'ws'],
        [TRUSTED_SERVER, 'ws']
    ] as const
)('names the carrier a %o source arrived on', (source, carrier) => {
    expect(toALDeliveryCarrier(source)).toBe(carrier);
});

describe.each(['memory', 'indexeddb'] as const)('inbound claims partitioned by carrier over %s', (storage) => {
    it('lets each runtime over one shared store claim only the rows its carrier admitted', async () => {
        const stores = createStores(storage);
        const admission = createInboundTestAdmission(stores);
        // A runtime's own admission runs a claim round of its own, so both rows are committed before
        // either runtime exists; the WS runtime then drains first and could reach both.
        const rtcAdmitted = await admission.attempt(createSenderMessage('m-rtc', 'p1'), toRtcPeer('p1'), planInboundTestMessage);
        const wsAdmitted = await admission.attempt(createSenderMessage('m-ws', 's1'), TRUSTED_SERVER, planInboundTestMessage);
        const ws = createCarrierRuntime(stores, 'ws');
        const rtc = createCarrierRuntime(stores, 'rtc');
        await Promise.all([ws.runtime.ready(), rtc.runtime.ready()]);
        await drain([ws, rtc]);

        expect(rtcAdmitted.right).toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        expect(wsAdmitted.right).toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        expect(rtc.dispatchedMsgIds).toEqual(['m-rtc']);
        expect(ws.dispatchedMsgIds).toEqual(['m-ws']);
    });

    it.each([['rtc', 'ws'], ['ws', 'rtc']] as const)(
        'admits and dispatches one envelope once when it arrives over %s and then %s',
        async (first, second) => {
            const stores = createStores(storage);
            const runtimes = { rtc: createCarrierRuntime(stores, 'rtc'), ws: createCarrierRuntime(stores, 'ws') };
            const sources = { rtc: toRtcPeer('s1'), ws: TRUSTED_SERVER };
            const message = createSenderMessage('m1', 's1');
            await Promise.all([runtimes.rtc.runtime.ready(), runtimes.ws.runtime.ready()]);

            const firstAdmitted = await runtimes[first].runtime.admitIncomingMessage(message, sources[first]);
            await drain([runtimes.rtc, runtimes.ws]);
            const secondAdmitted = await runtimes[second].runtime.admitIncomingMessage(message, sources[second]);
            await drain([runtimes.rtc, runtimes.ws]);

            expect(firstAdmitted.right).toEqual({ kind: 'admitted' });
            expect(secondAdmitted.right).toEqual({ kind: 'duplicate' });
            expect(runtimes[first].dispatchedMsgIds).toEqual(['m1']);
            expect(runtimes[second].dispatchedMsgIds).toEqual([]);
        }
    );

    it('leaves a stored RTC row unclaimed by the WS runtime until an RTC runtime claims it', async () => {
        const stores = createStores(storage);
        const ws = createCarrierRuntime(stores, 'ws');
        await ws.runtime.ready();

        // The admission alone commits the row, so no RTC runtime exists while the WS one runs.
        const admitted = await createInboundTestAdmission(stores).attempt(
            createSenderMessage('m-reloaded', 'p1'),
            toRtcPeer('p1'),
            planInboundTestMessage
        );
        await drain([ws]);

        expect(admitted.right).toMatchObject({ kind: 'completed', acceptance: { kind: 'admitted' } });
        expect(ws.dispatchedMsgIds).toEqual([]);
        expect(await readWorkStatuses(stores, 'rtc')).toEqual([EntityStatus.NEW]);

        const rtc = createCarrierRuntime(stores, 'rtc');
        await rtc.runtime.ready();
        await drain([ws, rtc]);

        expect(ws.dispatchedMsgIds).toEqual([]);
        expect(rtc.dispatchedMsgIds).toEqual(['m-reloaded']);
        expect(await readWorkStatuses(stores, 'rtc')).toEqual([EntityStatus.COMPLETED]);
    });
});
