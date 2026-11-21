import { vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundDurableEffect, ALOutboundPlanner } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRepairRequest,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { isPendingALOutboundWork, toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createDefaultOutboundTestRuntime,
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
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
}

/** A sender page a reload replaces: its runtime, the stores it runs over and the settlements it has stated. */
export interface ReloadableOutboundTimelinePage {
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    settlements: ALDeliverySettlement[];
    readonly reopenable: ReopenableOutboundTestStores;
}

/** How a timeline's sender plans a send and a repair, and what its transport does with each copy. */
export interface OutboundTimelineSender {
    readonly planOutgoingMessage: ALOutboundPlanner<OutboundTestPayload>;
    readonly planRepairMessage: (
        msg: ALMessage,
        request: ALOutboundRepairRequest
    ) => Promise<ALOutboundDispatchPlan<OutboundTestPayload>>;
    readonly sendPreparedMessage: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['sendPreparedMessage'];
}

/** A repair re-plan of one message: the request, the receipt it retries and the one copy it is planned with. */
export interface OutboundTimelineRepairPlanInput {
    readonly msg: ALMessage;
    readonly request: ALOutboundRepairRequest;
    readonly tracking: ALOutboundAckTrackingPlan;
    readonly copy: OutboundTestPayload;
}

/** A `receiver` receipt on `peerIds`, each its own next hop: two-second windows and three retries. */
export function toOutboundTimelineReceiptTracking(peerIds: readonly string[]): ALOutboundAckTrackingPlan {
    return {
        enabled: true,
        timeoutMs: 2_000,
        maxAttempts: 3,
        expectedPeerIds: peerIds,
        nextHopPeerIds: peerIds,
        mode: 'receiver'
    };
}

/** As the RTC planner: a repair copy carries the receipt's tracking, whose receiver mode replaces the expected set. */
export function toOutboundTimelineRepairPlan(
    input: OutboundTimelineRepairPlanInput
): ALOutboundDispatchPlan<OutboundTestPayload> {
    return {
        msg: input.msg,
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: [input.copy],
        ackTracking: { ...input.tracking, expectedPeerIdsUpdate: 'replace' },
        repairTracking: input.request.repair
    };
}

/** A timeline's sender over RTC, stating every settlement into `settlements`. */
export function createOutboundTimelineRuntime(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    settlements: ALDeliverySettlement[],
    sender: OutboundTimelineSender
): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores,
        carrier: 'rtc',
        planOutgoingMessage: sender.planOutgoingMessage,
        planRepairMessage: sender.planRepairMessage,
        settlements: (settlement) => settlements.push(settlement),
        sendPreparedMessage: sender.sendPreparedMessage
    });
}

/** A reload: the page's runtime goes, its stores open again, and a new runtime starts with nothing stated. */
export async function reloadOutboundTimelinePage(
    page: ReloadableOutboundTimelinePage,
    sender: OutboundTimelineSender
): Promise<void> {
    await page.runtime.dispose();
    page.stores = page.reopenable.reopen();
    page.settlements = [];
    page.runtime = createOutboundTimelineRuntime(page.stores, page.settlements, sender);
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

/** The payloads of the store's pending work rows that name `msgId`, in key order. */
export async function readPendingOutboundWorkPayloads(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    msgId: string
): Promise<readonly ALOutboundDurableEffect<OutboundTestPayload>[]> {
    const payloads: ALOutboundDurableEffect<OutboundTestPayload>[] = [];
    const workType = toALOutboundWorkType(stores.admissionStore.namespace);
    for (const key of await stores.workQueue.getAllKeys()) {
        const entry = await stores.workQueue.getItem(key);
        if (entry === undefined || entry.typeId !== workType || !isPendingALOutboundWork(entry)) {
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
