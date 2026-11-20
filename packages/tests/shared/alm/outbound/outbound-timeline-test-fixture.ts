import { vi } from 'vitest';

import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundDurableEffect } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { isPendingALOutboundWork } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createDefaultOutboundTestStores,
    createIndexedDbOutboundTestStores,
    drainOutboundWorkDueNow
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

/** The clock step a timeline drains at: the work due at each step runs before the next. */
export const OUTBOUND_TIMELINE_STEP_MS = 25;

export type OutboundTimelineStoreKind = 'memory' | 'indexeddb';

/** A pair whose stores a second runtime can open again, as a reload does. */
export interface ReopenableOutboundTestStores {
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    reopen(): ALOutboundRuntimeStores<OutboundTestPayload>;
}

/** A sender page: its runtime and the stores it runs over, both replaced by a reload. */
export interface OutboundTimelinePage {
    readonly runtime: object;
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
}

/** Memory stores reopen as themselves; IndexedDB stores reopen on the same database, as a reloaded page does. */
export function createReopenableOutboundTestStores(
    store: OutboundTimelineStoreKind,
    namespace: string
): ReopenableOutboundTestStores {
    if (store === 'memory') {
        const stores = createDefaultOutboundTestStores();
        return { stores, reopen: () => stores };
    }
    const dbName = `${namespace}-${crypto.randomUUID()}`;
    const open = () =>
        createIndexedDbOutboundTestStores({
            observer: createPassThroughIndexedDbOperationObserver(),
            namespace,
            dbName
        });
    return { stores: open(), reopen: open };
}

/** Moves the fake clock to `atMs` in 25 ms steps, draining the work due at each. */
export async function advanceOutboundClockTo(page: OutboundTimelinePage, atMs: number): Promise<void> {
    while (Date.now() < atMs) {
        vi.setSystemTime(Math.min(Date.now() + OUTBOUND_TIMELINE_STEP_MS, atMs));
        await drainOutboundWorkDueNow(page.runtime, page.stores);
    }
    await drainOutboundWorkDueNow(page.runtime, page.stores);
}

/** The payloads of the pending work rows that name `msgId`, in key order. */
export async function readPendingOutboundWorkPayloads(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    msgId: string
): Promise<readonly ALOutboundDurableEffect<OutboundTestPayload>[]> {
    const payloads: ALOutboundDurableEffect<OutboundTestPayload>[] = [];
    for (const key of await stores.workQueue.getAllKeys()) {
        const entry = await stores.workQueue.getItem(key);
        if (entry === undefined || !isPendingALOutboundWork(entry)) {
            continue;
        }
        const { payload } = await stores.admissionStore.readWorkSnapshot(entry, undefined);
        const named = 'message' in payload ? payload.message.msgId : 'msgId' in payload ? payload.msgId : undefined;
        if (named === msgId) {
            payloads.push(payload);
        }
    }
    return payloads;
}

/** The kinds of the pending work rows that name `msgId`, sorted. */
export async function readPendingOutboundWorkKinds(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    msgId: string
): Promise<readonly string[]> {
    return (await readPendingOutboundWorkPayloads(stores, msgId)).map((payload) => payload.kind).sort();
}

/** The facts that end `msgId`'s message, each as a pair of its kind and its reason. */
export function toOutboundTerminalFacts(
    settlements: readonly ALDeliverySettlement[],
    msgId: string
): readonly (readonly [string, string])[] {
    return settlements.flatMap((settlement): (readonly [string, string])[] => {
        if (settlement.msgId !== msgId) {
            return [];
        }
        switch (settlement.kind) {
            case 'admission':
                return settlement.verdict.kind === 'skipped' || settlement.verdict.kind === 'refused'
                    ? [['admission', settlement.verdict.reason]]
                    : [];
            case 'receipt-exhausted':
                return [['receipt-exhausted', settlement.cause]];
            case 'relay-rejected':
                return [['relay-rejected', settlement.relayRejection.reason]];
            case 'acknowledgement':
                return settlement.complete ? [['acknowledgement', 'complete']] : [];
            default:
                return [];
        }
    });
}
