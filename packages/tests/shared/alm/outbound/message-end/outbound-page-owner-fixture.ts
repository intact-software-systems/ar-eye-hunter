import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeStores,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { toALOutboundEndMessageEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import '../../../../setup-browser-indexeddb.ts';
import {
    createDefaultOutboundTestRuntime,
    createIndexedDbOutboundTestStores,
    createVolatileOutboundTestStores,
    OUTBOUND_TEST_SEND_PLANNER
} from '../../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../../outbound-test-payload.ts';
import type { SessionOutboundTestRuntime, TestDurableWorkOwnership } from '../../session-outbound-test-runtime.ts';

/** One page's outbound owner: its durable pair over IndexedDB, counted, beside a memory pair. */
export interface PageOwner {
    readonly dbName: string;
    readonly namespace: string;
    readonly observer: CountingIndexedDbOperationObserver;
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly volatileStores: ALVolatileOutboundRuntimeStores<OutboundTestPayload>;
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    /** The msgId of every frame this owner's carrier was handed, in send order. */
    readonly sent: string[];
}

/**
 * A message whose resource id starts with `volatile` goes to the memory pair; any other to IndexedDB. The supplied
 * engine is never started, so only the test's batches run the owner's work.
 */
export function openPageOwner(dbName: string, namespace: string): PageOwner {
    const observer = createCountingIndexedDbOperationObserver();
    const stores = createIndexedDbOutboundTestStores({ observer, namespace, dbName });
    const sent: string[] = [];
    const volatileStores = createVolatileOutboundTestStores();
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        volatileStores,
        queueEngine: new InboxOutboxEngine(),
        planOutgoingMessage: (msg, authority) => ({
            ...OUTBOUND_TEST_SEND_PLANNER(msg, authority),
            lane: msg.route.resourceId.startsWith('volatile') ? 'volatile' : 'durable'
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage.id.msgId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { dbName, namespace, observer, stores, volatileStores, runtime, sent };
}

/** The page reloads: its owner is gone with every in-memory send control, and a new one opens the same database. */
export async function reloadPage(page: PageOwner): Promise<PageOwner> {
    await page.runtime.dispose();
    const reloaded = openPageOwner(page.dbName, page.namespace);
    await reloaded.runtime.ready();
    return reloaded;
}

export async function readSendGuardKind(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    message: ALMessage
): Promise<string> {
    return (await stores.admissionStore.readSendGuards(message)).kind;
}

/** The `end-message` row a conflicting end of the message retained, in whatever status it reached. */
export async function readEndMessageRow(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    msgId: string
): Promise<ResourceEntry | undefined> {
    const key = toALOutboundWorkKey(stores.admissionStore.namespace, toALOutboundEndMessageEffectId(msgId));
    return await stores.workQueue.getItem(key);
}

/** Hands every commit the tab announced to the owning tab, as the session channel does. */
export function relayAnnouncedCommits(
    from: SessionOutboundTestRuntime<TestDurableWorkOwnership>,
    to: SessionOutboundTestRuntime<TestDurableWorkOwnership>
): void {
    from.ownership.announced.forEach((commit) => to.ownership.deliver(commit));
}
