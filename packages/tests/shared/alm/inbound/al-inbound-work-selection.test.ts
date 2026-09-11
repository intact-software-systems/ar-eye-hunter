import { Temporal } from '@js-temporal/polyfill';
import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundAdmittedDelivery } from '@shared/alm/inbound/al-inbound-admitted-delivery.ts';
import { toALInboundPendingAdmissionId } from '@shared/alm/inbound/al-inbound-pending-admission.ts';
import { computeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import {
    AL_INBOUND_WORK_PAGE_SIZE,
    createALInboundWorkSelector,
    type ALInboundWorkSelector
} from '@shared/alm/inbound/read-al-inbound-work-selection.ts';
import type { ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createInboundTestDispatch, readInboundTestDispatchEffect } from '../create-inbound-test-dispatch.ts';
import { createInboundTestMessage, createInboundTestStores } from '../inbound-runtime-test-fixture.ts';

const NOW_MS = 1_800_000_000_000;
/** A full page of rows, so a batch that reads its own page size reads every one of them. */
const DISPATCH_PAGE_ROWS = AL_INBOUND_WORK_PAGE_SIZE;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ALInboundWorkSelector readiness', () => {
    it('advertises no readiness from a batch that claimed nothing', async () => {
        const fixture = createSelectorFixture();

        // Two full NEW -> RETRY -> RESERVED rotations: an unfinished scan is due to the probe alone,
        // so no batch of it may hand the engine a time that puts the next batch on the same tick.
        for (let batch = 0; batch < 6; batch += 1) {
            const selection = await fixture.selector.selectReady(fixture.port, AL_INBOUND_WORK_PAGE_SIZE);
            expect(selection.claims).toEqual([]);
            expect(selection.nextReadyAtMs).toBeUndefined();
        }
    });

    it('reports the page it can claim as ready now', async () => {
        const fixture = createSelectorFixture();
        await fixture.port.retainIfAbsent(createPendingAdmissionEntry(fixture.namespace));

        expect(await fixture.selector.readNextReadyAtMs(fixture.port)).toBe(NOW_MS);

        const selection = await fixture.selector.selectReady(fixture.port, AL_INBOUND_WORK_PAGE_SIZE);
        expect(selection.claims).toHaveLength(1);
        expect(selection.nextReadyAtMs).toBe(NOW_MS);
    });

    it('drops the page a probe cached when a commit restarts the scan', async () => {
        const fixture = createSelectorFixture();

        // The probe over an empty NEW page caches a rotation that still owes RETRY and RESERVED.
        expect(await fixture.selector.readNextReadyAtMs(fixture.port)).toBe(NOW_MS);

        await fixture.port.retainIfAbsent(createPendingAdmissionEntry(fixture.namespace));
        fixture.selector.restartScan();

        const selection = await fixture.selector.selectReady(fixture.port, AL_INBOUND_WORK_PAGE_SIZE);
        expect(selection.claims).toHaveLength(1);
    });
});

describe('ALInboundWorkSelector eligibility reads', () => {
    it.each([AL_INBOUND_WORK_PAGE_SIZE, 4])(
        'reads eligibility once for each of the %i rows a batch claims, and for no row beyond them',
        async (pageSize) => {
            const fixture = await createDispatchPageFixture();
            const readReadiness = vi.spyOn(fixture.delivery, 'readReadiness');

            const selection = await fixture.selector.selectReady(fixture.port, pageSize);

            // The page read is bounded by the same page size the claim is, so the rows this batch
            // could never take cost it no eligibility read at all.
            expect(selection.claims).toHaveLength(pageSize);
            expect(readReadiness).toHaveBeenCalledTimes(pageSize);
        }
    );
});

interface SelectorFixture {
    readonly namespace: string;
    readonly port: ALWorkQueuePort;
    readonly selector: ALInboundWorkSelector;
}

function createSelectorFixture(): SelectorFixture {
    const namespace = 'inbound-selection';
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(NOW_MS))
    );
    const admissionStore = createALInboundAdmissionStore({
        nowMs: () => NOW_MS,
        namespace,
        backend: new InMemoryAdmissionBackend(state, () => NOW_MS),
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const stores = { admissionStore, workQueue: state.workQueue };
    const delivery = createInboundTestDispatch(stores, () => NOW_MS).delivery;
    return {
        namespace,
        port: createTestALInboundWorkPort({ ...stores, nowMs: () => NOW_MS }),
        selector: createALInboundWorkSelector({ delivery, namespace, nowMs: () => NOW_MS })
    };
}

function createPendingAdmissionEntry(namespace: string) {
    const original = newALUnicastMessage(
        'peer-1',
        { topicId: 'chat', resourceId: 'selection', contextId: 'chat-1' },
        'self',
        'chat.private-text.v1',
        { text: 'claimable' },
        { ttlMs: 60_000 }
    );
    const msg = { ...original, constraints: { ...original.constraints, expiresAtMs: NOW_MS + 60_000 } };
    return computeALInboundWorkEntry({
        namespace,
        effectId: toALInboundPendingAdmissionId(msg),
        payload: { kind: 'admit-message', msg, source: { kind: 'ws-client', peerId: 'peer-1' } },
        observedAtMs: NOW_MS,
        expireAtTimestamp: NOW_MS + 60_000
    }).entry;
}

interface DispatchPageFixture {
    readonly delivery: ALInboundAdmittedDelivery;
    readonly port: ALWorkQueuePort;
    readonly selector: ALInboundWorkSelector;
}

/** A full page of committed `dispatch-local` rows: every one of them claimable by the next batch. */
async function createDispatchPageFixture(): Promise<DispatchPageFixture> {
    const namespace = 'inbound-dispatch-page';
    const stores = createInboundTestStores({
        namespace,
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    for (let row = 0; row < DISPATCH_PAGE_ROWS; row += 1) {
        await readInboundTestDispatchEffect(stores, createInboundTestMessage({ msgId: `dispatch-${row}` }));
    }
    expect(await stores.workQueue.getAllKeys(), 'one dispatch-local row per admission').toHaveLength(
        DISPATCH_PAGE_ROWS
    );
    const delivery = createInboundTestDispatch(stores, Date.now).delivery;
    return {
        delivery,
        port: createTestALInboundWorkPort({ ...stores, nowMs: Date.now }),
        selector: createALInboundWorkSelector({ delivery, namespace, nowMs: Date.now })
    };
}
