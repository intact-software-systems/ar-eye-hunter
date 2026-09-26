import '../../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundAdmittedDelivery } from '@shared/alm/inbound/al-inbound-admitted-delivery.ts';
import { toALInboundPendingAdmissionId } from '@shared/alm/inbound/al-inbound-pending-admission.ts';
import {
    computeALInboundWorkEntry,
    decodeALInboundWorkEntry,
    resolveALInboundWorkDueAtMs,
    type ALPersistedInboundEffect
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import {
    AL_INBOUND_WORK_PAGE_SIZE,
    computeALInboundClaimOrder,
    createALInboundWorkSelector,
    type ALInboundWorkSelector
} from '@shared/alm/inbound/read-al-inbound-work-selection.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    EntityStatus,
    toKeyAsString,
    type ResourceEntry,
    type ResourceEntryKeyString
} from '@shared/queuebox/ResourceEntry.ts';

import type { ALInboundDurableEffect } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { createInboundTestDispatch, readInboundTestDispatchEffect } from '../create-inbound-test-dispatch.ts';
import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    readInboundTestAdmission,
    type CreateInboundTestRuntimeInput,
    type InboundTestRuntime
} from '../inbound-runtime-test-fixture.ts';

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
/** Rounds a drain needs at worst: the rotation walks three statuses before it scans NEW again. */
const ROTATION_ROUND_LIMIT = 16;

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

    it('reports a due row its eligibility read deferred, with its due time, and claims nothing', async () => {
        const fixture = await createDispatchPageFixture(1);
        const [deferred] = fixture.effects;
        vi.spyOn(fixture.delivery, 'readReadiness').mockResolvedValue({ ready: false, observed: undefined });

        const selection = await fixture.selector.selectReady(fixture.port, AL_INBOUND_WORK_PAGE_SIZE);

        expect(selection.claims).toEqual([]);
        expect(fixture.selector.getUnreservedDue()).toEqual([
            { effectId: deferred!.effectId, dueAtMs: resolveALInboundWorkDueAtMs(deferred!.entry) }
        ]);
    });
});

describe('ALInboundWorkSelector claim order', () => {
    it.each(['memory', 'indexeddb'] as const)(
        'dispatches an acknowledged message before it sends the acknowledgement over %s',
        async (storage) => {
            const fixture = createInboundTestRuntime({
                carrier: 'ws',
                stores: createInboundTestStores({
                    namespace: 'claim-order',
                    storage,
                    observer: createPassThroughIndexedDbOperationObserver()
                }),
                effectWorkerId: 'al-inbound:claim-order'
            });
            await fixture.runtime.ready();
            fixture.queueEngine.start();
            onTestFinished(() => fixture.queueEngine.stop());

            await fixture.runtime.admitIncomingMessage(
                createInboundTestMessage({ msgId: 'claim-order', acknowledged: true }),
                INBOUND_TEST_SOURCE
            );

            // One commit, one batch: both rows are on the page that batch reads, and today
            // the `ack:` key sorts ahead of the `dispatch:` key.
            await expect.poll(() => fixture.sequence).toEqual(['dispatched', 'control-sent']);
        }
    );

    it.each(['memory', 'indexeddb'] as const)(
        'sends the acknowledgements of one batch in one control-send call over %s',
        async (storage) => {
            const fixture = await createControlRoundFixture(storage, {});

            await runRotationUntilControlSent(fixture);

            await expect.poll(() => fixture.sequence).toEqual(['dispatched', 'dispatched', 'control-sent']);
            expect(
                fixture.controlSends.map((sends) => sends.map((msg) => readAcknowledgedMsgId(msg)))
            ).toEqual([['first-acknowledged', 'second-acknowledged']]);
        }
    );

    it.each(['memory', 'indexeddb'] as const)(
        'settles each control claim of a round on its own message when the round send throws over %s',
        async (storage) => {
            const fixture = await createControlRoundFixture(storage, {
                failControlSend: (msg) => readAcknowledgedMsgId(msg) === 'second-acknowledged'
            });

            await runRotationUntilControlSent(fixture);

            // The round refused as a whole; each claim then answers for its own message alone.
            await expect.poll(async () => await readControlRowStatuses(fixture)).toEqual({
                'first-acknowledged': EntityStatus.COMPLETED,
                'second-acknowledged': EntityStatus.NON_RETRYABLE
            });
        }
    );

    it('keeps the control batch intact when a commit arrives mid-batch', async () => {
        let releaseHeld: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
            releaseHeld = resolve;
        });
        let heldEntered = false;
        const fixture = await createControlRoundFixture('memory', {
            gateDispatch: async () => {
                if (!heldEntered) {
                    heldEntered = true;
                    await held;
                }
            }
        });

        for (let round = 0; round < ROTATION_ROUND_LIMIT && !heldEntered; round += 1) {
            await fixture.queueEngine.executeOnce();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        // New committed work does not rewind the rotation or split its already claimed control batch.
        await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'late' }), INBOUND_TEST_SOURCE);
        releaseHeld?.();

        await expect.poll(() => fixture.controlSends.length).toBe(1);
        expect(fixture.controlSends.map((sends) => sends.map((msg) => readAcknowledgedMsgId(msg))))
            .toEqual([['first-acknowledged', 'second-acknowledged']]);
    });

    it(
        'each admission wakes the running engine while an earlier dispatch is held',
        async () => {
            let releaseHeld: (() => void) | undefined;
            const held = new Promise<void>((resolve) => {
                releaseHeld = resolve;
            });
            let signalHeldEntered: (() => void) | undefined;
            const heldEntered = new Promise<void>((resolve) => {
                signalHeldEntered = resolve;
            });
            const dispatchedIds: string[] = [];
            const fixture = createInboundTestRuntime({
                carrier: 'ws',
                stores: createInboundTestStores({
                    namespace: 'ingress-wake',
                    storage: 'memory',
                    observer: createPassThroughIndexedDbOperationObserver()
                }),
                effectWorkerId: 'al-inbound:ingress-wake',
                gateDispatch: async (msg) => {
                    dispatchedIds.push(msg.id.msgId);
                    if (msg.id.msgId !== 'held') {
                        return;
                    }
                    signalHeldEntered?.();
                    await held;
                }
            });
            const wake = vi.spyOn(fixture.queueEngine, 'wake');
            await fixture.runtime.ready();
            fixture.queueEngine.start();
            onTestFinished(() => fixture.queueEngine.stop());
            wake.mockClear();

            // The caller-owned engine is running, but each admission must still announce its
            // own write, including one that lands while a claim is held by the current batch.
            await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'held' }), INBOUND_TEST_SOURCE);
            await heldEntered;
            expect(wake).toHaveBeenCalledTimes(1);

            // A second commit lands while the batch above is still running the first claim's
            // dispatch. R-S2a-6: its own admission still reaches the same wake, even though the
            // batch cannot claim the new row until its follow-up round.
            await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'second' }), INBOUND_TEST_SOURCE);
            expect(wake).toHaveBeenCalledTimes(2);

            releaseHeld?.();
            // The test does not execute a batch manually; the running worker must discover
            // and deliver the second message after the first claim is released.
            await expect.poll(() => dispatchedIds).toEqual(['held', 'second']);
        }
    );

    it('ranks page deliveries first, then admission replays and undecoded rows, then control sends', () => {
        const claims = [
            createTestClaim('forward-message'),
            createTestClaim('send-control'),
            createTestClaim('undecoded'),
            createTestClaim('admit-control'),
            createTestClaim('admit-message'),
            createTestClaim('release-buffered'),
            createTestClaim('dispatch-local')
        ];
        const effectKinds = new Map<ResourceEntryKeyString, ALInboundDurableEffect['kind']>([
            [toKeyAsString(claims[0]!.entry.key), 'forward-message'],
            [toKeyAsString(claims[1]!.entry.key), 'send-control'],
            [toKeyAsString(claims[3]!.entry.key), 'admit-control'],
            [toKeyAsString(claims[4]!.entry.key), 'admit-message'],
            [toKeyAsString(claims[5]!.entry.key), 'release-buffered'],
            [toKeyAsString(claims[6]!.entry.key), 'dispatch-local']
        ]);

        const ordered = computeALInboundClaimOrder(claims, effectKinds);

        expect(ordered.map((claim) => claim.entry.key.resourceId)).toEqual([
            'release-buffered',
            'dispatch-local',
            'undecoded',
            'admit-control',
            'admit-message',
            'forward-message',
            'send-control'
        ]);
    });
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
        port: createTestALInboundWorkPort({ carrier: 'ws', ...stores, nowMs: () => NOW_MS }),
        selector: createALInboundWorkSelector({ delivery, namespace, nowMs: () => NOW_MS })
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
    const port = createTestALInboundWorkPort({ carrier: 'ws', ...stores, nowMs: () => nowMs });
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
        selector: createALInboundWorkSelector({ delivery, namespace, nowMs: () => nowMs })
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

/**
 * Two acknowledged messages committed straight into the store, so no commit wakes a batch of its
 * own: the rotation reaches NEW again, and the one batch that reads it claims all four rows.
 */
async function createControlRoundFixture(
    storage: 'memory' | 'indexeddb',
    ports: Pick<CreateInboundTestRuntimeInput, 'failControlSend' | 'gateDispatch'>
): Promise<InboundTestRuntime> {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: 'control-round',
            storage,
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: 'al-inbound:control-round',
        ...ports
    });
    await fixture.runtime.ready();
    const admissionStore = fixture.stores.admissionStore;
    for (const msgId of ['first-acknowledged', 'second-acknowledged']) {
        const message = createInboundTestMessage({ msgId, acknowledged: true });
        expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, message)))
            .toBe('committed');
    }
    return fixture;
}

async function runRotationUntilControlSent(fixture: InboundTestRuntime): Promise<void> {
    for (let round = 0; round < ROTATION_ROUND_LIMIT && fixture.sequence.length === 0; round += 1) {
        await fixture.queueEngine.executeOnce();
        // The engine pass that starts a batch does not await it: let it run.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

/** The queue status of each `send-control` row, by the message its acknowledgement names. */
async function readControlRowStatuses(fixture: InboundTestRuntime): Promise<Record<string, string>> {
    const statuses: Record<string, string> = {};
    for (const key of await fixture.stores.workQueue.getAllKeys()) {
        const entry = await fixture.stores.workQueue.getItem(key);
        const payload = entry === undefined
            ? undefined
            : decodeALInboundWorkEntry(entry, fixture.stores.admissionStore.namespace).payload;
        const acknowledged = payload?.kind === 'send-control' ? readAcknowledgedMsgId(payload.msg) : undefined;
        if (entry !== undefined && acknowledged !== undefined) {
            statuses[acknowledged] = entry.status;
        }
    }
    return statuses;
}

function readAcknowledgedMsgId(msg: ALMessage): string | undefined {
    const control = parseALControlMessage(msg);
    return control?.type === 'ack' ? control.payload.ackedMsgId : undefined;
}

/** A bare claim keyed by `resourceId`, so a rank test can name and re-identify it by that alone. */
function createTestClaim(resourceId: string): ALWorkClaim {
    return {
        entry: {
            key: { topicId: 'claim-order', resourceId, contextId: 'rank' },
            resource: '',
            typeId: '',
            audit: {
                date: Temporal.PlainTime.from('00:00'),
                createdBy: 'test',
                createdTs: Temporal.PlainDateTime.from('2024-01-01T00:00'),
                expiryTs: Temporal.Instant.fromEpochMilliseconds(NOW_MS)
            },
            status: EntityStatus.NEW,
            dequeueAudit: { attempts: 0 }
        },
        attempts: 0,
        leaseUntilMs: NOW_MS
    };
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
        carrier: 'ws',
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
    readonly effects: readonly ALPersistedInboundEffect[];
}

/** A page of committed `dispatch-local` rows, full by default: every one of them claimable by the next batch. */
async function createDispatchPageFixture(rowCount: number = DISPATCH_PAGE_ROWS): Promise<DispatchPageFixture> {
    const namespace = 'inbound-dispatch-page';
    const stores = createInboundTestStores({
        namespace,
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const effects: ALPersistedInboundEffect[] = [];
    for (let row = 0; row < rowCount; row += 1) {
        effects.push(
            await readInboundTestDispatchEffect(stores, createInboundTestMessage({ msgId: `dispatch-${row}` }))
        );
    }
    expect(await stores.workQueue.getAllKeys(), 'one dispatch-local row per admission').toHaveLength(rowCount);
    const delivery = createInboundTestDispatch(stores, Date.now).delivery;
    return {
        delivery,
        port: createTestALInboundWorkPort({ carrier: 'ws', ...stores, nowMs: Date.now }),
        selector: createALInboundWorkSelector({ delivery, namespace, nowMs: Date.now }),
        effects
    };
}
