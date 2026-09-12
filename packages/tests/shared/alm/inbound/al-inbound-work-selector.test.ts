import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

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
    ALInboundWorkSelector
} from '@shared/alm/inbound/al-inbound-work-selector.ts';
import type { ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { createInboundTestDispatch, readInboundTestDispatchEffect } from '../create-inbound-test-dispatch.ts';
import { createInboundTestMessage, createInboundTestStores } from '../inbound-runtime-test-fixture.ts';

const NOW_MS = 1_800_000_000_000;
/** A full page of rows, so a batch that reads its own page size reads every one of them. */
const DISPATCH_PAGE_ROWS = AL_INBOUND_WORK_PAGE_SIZE;
// One distinct step per half the selection times, so a field reporting the other is visible on sight.
const PAGE_READ_MS = 9;
const RESERVATION_MS = 4;
/** How long the row had already been due when the page holding it was read. */
const DUE_SINCE_MS = 250;
/** The rotation walks NEW and RETRY before it scans RESERVED, so a row there is three rounds away. */
const SCAN_STATUS_COUNT = 3;

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

    it('reaches work committed behind a cached empty page on a natural rotation', async () => {
        const fixture = createSelectorFixture();

        // The probe over an empty NEW page caches a rotation that still owes RETRY and RESERVED.
        expect(await fixture.selector.readNextReadyAtMs(fixture.port)).toBe(NOW_MS);

        await fixture.port.retainIfAbsent(createPendingAdmissionEntry(fixture.namespace));
        const selection = await readFirstClaimingSelection(fixture, 6);
        expect(selection.claims).toHaveLength(1);
    });
});

describe('ALInboundWorkSelector phase measurement', () => {
    it('times its page read apart from its reservation, and reports the wait of the row it claimed', async () => {
        const fixture = createTimedSelectorFixture();
        await fixture.port.retainIfAbsent(createPendingAdmissionEntry(fixture.namespace, NOW_MS - DUE_SINCE_MS));

        const selection = await fixture.selector.selectReady(fixture.port, AL_INBOUND_WORK_PAGE_SIZE);

        expect(selection.claims).toHaveLength(1);
        expect(selection.selectionDurationMs).toBe(PAGE_READ_MS);
        expect(selection.claimDurationMs).toBe(RESERVATION_MS);
        expect(selection.earliestDueAtMs).toBe(NOW_MS - DUE_SINCE_MS);
    });

    it('reports the wait of an unleased reservation the page recovered without the port', async () => {
        const fixture = createTimedSelectorFixture();
        await fixture.port.retainIfAbsent(
            createUnleasedReservationEntry(fixture.namespace, NOW_MS - DUE_SINCE_MS)
        );

        const selection = await readFirstClaimingSelection(fixture);

        // The port reserved nothing here: the claim is the page's own. A batch holding only these is
        // the expired-lease backlog, and reading the wait from the port's reservations alone would
        // report it as no wait at all. Strictly before the batch start is a positive `queueWaitMs`;
        // the arithmetic itself is pinned in `work/al-work-handler.test.ts`.
        expect(selection.claims).toHaveLength(1);
        expect(selection.earliestDueAtMs).toBe(NOW_MS - DUE_SINCE_MS);
        expect(selection.earliestDueAtMs).toBeLessThan(NOW_MS);
    });
});

describe('ALInboundWorkSelector eligibility reads', () => {
    it.each([AL_INBOUND_WORK_PAGE_SIZE, 4])(
        'reads eligibility once for each of the %i rows a batch claims, and for no row beyond them',
        async (pageSize) => {
            const fixture = await createDispatchPageFixture();
            const readReadiness = vi.spyOn(fixture.delivery, 'readReadiness');

            const selection = await fixture.selector.selectReady(fixture.port, pageSize);

            // No probe ran before this call, so `selectReady` reads the page itself, at the size it
            // was given: every row that page holds is a row this batch claims, and each costs one
            // eligibility read. In production the probe reads the page at `AL_INBOUND_WORK_PAGE_SIZE`
            // and the batch behind it reuses that page rather than reading one of its own.
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
        selector: new ALInboundWorkSelector({ delivery, namespace, nowMs: () => NOW_MS })
    };
}

/** The selector under a clock only its own two measured calls move, so each phase has one source. */
function createTimedSelectorFixture(): SelectorFixture {
    const namespace = 'inbound-selection-phases';
    let nowMs = NOW_MS;
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs))
    );
    const admissionStore = createALInboundAdmissionStore({
        nowMs: () => nowMs,
        namespace,
        backend: new InMemoryAdmissionBackend(state, () => nowMs),
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const stores = { admissionStore, workQueue: state.workQueue };
    const delivery = createInboundTestDispatch(stores, () => nowMs).delivery;
    const port = createTestALInboundWorkPort({ ...stores, nowMs: () => nowMs });
    return {
        namespace,
        port: {
            ...port,
            readPage: async (input) => {
                const page = await port.readPage(input);
                nowMs += PAGE_READ_MS;
                return page;
            },
            claim: async (input) => {
                const claims = await port.claim(input);
                nowMs += RESERVATION_MS;
                return claims;
            }
        },
        selector: new ALInboundWorkSelector({ delivery, namespace, nowMs: () => nowMs })
    };
}

/** The rotation's next few rounds, stopped at the one that took work. */
async function readFirstClaimingSelection(fixture: SelectorFixture, maxRounds = SCAN_STATUS_COUNT) {
    for (let round = 0; round < maxRounds; round += 1) {
        const selection = await fixture.selector.selectReady(fixture.port, AL_INBOUND_WORK_PAGE_SIZE);
        if (selection.claims.length > 0) {
            return selection;
        }
    }
    throw new Error('The rotation scanned every status without claiming the seeded row');
}

/** A reservation with no lease start: timeout reservation can never reach it, so the page recovers it. */
function createUnleasedReservationEntry(namespace: string, observedAtMs: number): ResourceEntry {
    return { ...createPendingAdmissionEntry(namespace, observedAtMs), status: EntityStatus.RESERVED };
}

function createPendingAdmissionEntry(namespace: string, observedAtMs: number = NOW_MS) {
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
        observedAtMs,
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
        selector: new ALInboundWorkSelector({ delivery, namespace, nowMs: Date.now })
    };
}
