import 'fake-indexeddb/auto';
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALInboundLocalDeliveryEffectId } from '@shared/alm/inbound/al-inbound-effect-intent.ts';
import { toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime,
    type InboundTestStorage
} from './inbound-runtime-test-fixture.ts';

interface RetriedDeliveryFixture {
    readonly inbound: InboundTestRuntime;
    readonly msg: ALMessage;
    readonly retried: ResourceEntry;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe.each(['memory', 'indexeddb'] satisfies InboundTestStorage[])('retained local delivery brought due now (%s)', (storage) => {
    it('moves only the due time of a delivery waiting out its retry and runs it again at once', async () => {
        const fixture = await createRetriedDeliveryFixture(storage);
        const replacements = vi.spyOn(fixture.inbound.stores.workQueue, 'replaceIfObserved');

        expect(await fixture.inbound.runtime.writeRetainedDeliveriesDueNow([fixture.msg])).toBe(1);

        expect(replacements).toHaveBeenCalledTimes(1);
        const [observed, broughtDue] = replacements.mock.calls[0];
        expect(observed).toEqual(fixture.retried);
        expect(broughtDue?.status).toBe(EntityStatus.RETRY);
        expect(broughtDue?.resource).toBe(fixture.retried.resource);
        expect(broughtDue?.dequeueAudit.attempts).toBe(fixture.retried.dequeueAudit.attempts);
        expect(broughtDue?.audit.expiryTs.epochMilliseconds).toBe(fixture.retried.audit.expiryTs.epochMilliseconds);
        expect(broughtDue?.dequeueAudit.nextTs?.epochMilliseconds).toBeLessThanOrEqual(Date.now());
        await vi.waitFor(() => expect(fixture.inbound.delivered).toHaveLength(2));
    });

    it('leaves a delivery already due, and a message it never retained, as they are', async () => {
        const fixture = await createRetriedDeliveryFixture(storage);
        const neverAdmitted = createInboundTestMessage({ msgId: 'never-admitted' });
        const dueNow: ResourceEntry = {
            ...fixture.retried,
            dequeueAudit: { ...fixture.retried.dequeueAudit, nextTs: Temporal.Instant.fromEpochMilliseconds(Date.now()) }
        };
        expect(await fixture.inbound.stores.workQueue.replaceIfObserved(fixture.retried, dueNow)).not.toBeNull();

        expect(await fixture.inbound.runtime.writeRetainedDeliveriesDueNow([fixture.msg, neverAdmitted])).toBe(0);
        expect(fixture.inbound.delivered).toHaveLength(1);
    });

    it('treats a row claimed between its read and its replacement as a lost race, not a failure', async () => {
        const fixture = await createRetriedDeliveryFixture(storage);
        vi.spyOn(fixture.inbound.stores.workQueue, 'replaceIfObserved').mockResolvedValueOnce(null);

        expect(await fixture.inbound.runtime.writeRetainedDeliveriesDueNow([fixture.msg])).toBe(0);
        expect(fixture.inbound.delivered).toHaveLength(1);
        expect((await readDeliveryRow(fixture.inbound, fixture.msg))?.dequeueAudit.nextTs?.epochMilliseconds)
            .toBe(fixture.retried.dequeueAudit.nextTs?.epochMilliseconds);
    });
});

/** The first retry is pushed a minute out, as a late retry stage is, so no wait in a test reaches it. */
async function createRetriedDeliveryFixture(storage: InboundTestStorage): Promise<RetriedDeliveryFixture> {
    const namespace = `retained-delivery-${storage}`;
    const inbound = createInboundTestRuntime({
        stores: createInboundTestStores({ namespace, storage, observer: createPassThroughIndexedDbOperationObserver() }),
        carrier: 'ws',
        effectWorkerId: namespace,
        dispatchOutcome: 'retry'
    });
    const msg = createInboundTestMessage({ msgId: 'held' });
    expect((await inbound.runtime.admitIncomingMessage(msg, INBOUND_TEST_SOURCE)).right?.kind).toBe('admitted');
    await vi.waitFor(() => expect(inbound.delivered).toHaveLength(1));
    await vi.waitFor(async () => expect((await readDeliveryRow(inbound, msg))?.status).toBe(EntityStatus.RETRY));
    const firstRetry = (await readDeliveryRow(inbound, msg))!;
    const retried: ResourceEntry = {
        ...firstRetry,
        dequeueAudit: { ...firstRetry.dequeueAudit, nextTs: Temporal.Now.instant().add({ minutes: 1 }) }
    };
    expect(await inbound.stores.workQueue.replaceIfObserved(firstRetry, retried)).not.toBeNull();
    return { inbound, msg, retried };
}

async function readDeliveryRow(inbound: InboundTestRuntime, msg: ALMessage): Promise<ResourceEntry | undefined> {
    return await inbound.stores.workQueue.getItem(
        toALInboundWorkKey(inbound.stores.admissionStore.namespace, toALInboundLocalDeliveryEffectId(msg))
    );
}
