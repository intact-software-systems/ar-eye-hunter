import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import {
    AL_VOLATILE_STORE_EVICTION_INTERVAL_MS,
    normalizeALRuntimeStoreRetention
} from '@shared/alm/ALStoreRetention.ts';
import {
    createVolatileALInboundAdmissionStore,
    type ALInboundAdmissionStore
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type {
    ALInboundRuntimeStores,
    ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    readInboundTestDecisionSurface,
    type InboundTestRuntime
} from './inbound-runtime-test-fixture.ts';
import { readInboundTestMessageOwner } from './read-inbound-test-message-owner.ts';

describe('inbound store lanes (S3a, D20, D54)', () => {
    it.each([
        { durability: undefined, lane: 'volatile' },
        { durability: 'local-outbox' as const, lane: 'volatile' },
        { durability: 'local-inbox' as const, lane: 'durable' }
    ])('admits a data message that carries $durability to the $lane pair only', async ({ durability, lane }) => {
        const pairs = createObservedInboundPairs();
        const fixture = await createReadyInboundLaneRuntime(pairs);
        const message = createInboundTestMessage({ msgId: `routed-${lane}-${durability ?? 'none'}`, durability });

        expect((await fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });

        expect(await readOwnerSenders(pairs, message)).toEqual({
            durable: lane === 'durable' ? [INBOUND_TEST_SENDER_PEER_ID] : [],
            volatile: lane === 'volatile' ? [INBOUND_TEST_SENDER_PEER_ID] : []
        });
        // The lane is fixed by the envelope, so a second copy meets its first admission there.
        expect((await fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'duplicate' });
    });

    it('admits a control about a durable message in the durable pair after one memory read that writes nothing', async () => {
        const pairs = createObservedInboundPairs();
        const fixture = await createReadyInboundLaneRuntime(pairs);
        const tracked = createInboundTestMessage({ msgId: 'tracked-durable', durability: 'local-inbox' });
        await seedPendingAcknowledgement(pairs.durable.stores.admissionStore, tracked);
        const volatileRead = vi.spyOn(pairs.volatile.stores.admissionStore, 'readControlDecisionSurface');
        const volatileCommit = vi.spyOn(pairs.volatile.stores.admissionStore, 'commitBundle');
        const durableRead = vi.spyOn(pairs.durable.stores.admissionStore, 'readControlDecisionSurface');
        const volatileRowsBefore = pairs.volatile.state.data.size;

        const admitted = await fixture.runtime.admitIncomingMessage(toSenderAck(tracked), INBOUND_TEST_SOURCE);

        expect(admitted.right).toEqual({ kind: 'control', handled: true });
        expect(volatileRead).toHaveBeenCalledTimes(1);
        expect(volatileCommit).not.toHaveBeenCalled();
        expect(pairs.volatile.state.data.size, 'the memory pair keeps no row for the durable message')
            .toBe(volatileRowsBefore);
        expect(await pairs.volatile.stores.workQueue.getAllKeys()).toEqual([]);
        expect(durableRead).toHaveBeenCalledTimes(1);
    });

    it('admits a control about a volatile message in the memory pair and never reads the durable pair', async () => {
        const pairs = createObservedInboundPairs();
        const fixture = await createReadyInboundLaneRuntime(pairs);
        const tracked = createInboundTestMessage({ msgId: 'tracked-volatile' });
        await seedPendingAcknowledgement(pairs.volatile.stores.admissionStore, tracked);
        const durableRead = vi.spyOn(pairs.durable.stores.admissionStore, 'readControlDecisionSurface');

        const admitted = await fixture.runtime.admitIncomingMessage(toSenderAck(tracked), INBOUND_TEST_SOURCE);

        expect(admitted.right).toEqual({ kind: 'control', handled: true });
        expect(durableRead).not.toHaveBeenCalled();
    });

    it('answers an acknowledgement of its own message without reading either pair', async () => {
        const pairs = createObservedInboundPairs();
        const fixture = await createReadyInboundLaneRuntime(pairs);
        const volatileRead = vi.spyOn(pairs.volatile.stores.admissionStore, 'readControlDecisionSurface');
        const durableRead = vi.spyOn(pairs.durable.stores.admissionStore, 'readControlDecisionSurface');
        const own = newALAckControlMessage(
            { v: 2, msgId: 'ack-own-message', senderId: INBOUND_TEST_SENDER_PEER_ID, ts: Date.now() },
            {
                ackedMsgId: 'own-message',
                fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
                toPeerId: INBOUND_TEST_SELF_PEER_ID,
                originPeerId: INBOUND_TEST_SELF_PEER_ID,
                logicalRecipientPeerId: INBOUND_TEST_SENDER_PEER_ID,
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: Date.now()
            }
        );

        expect((await fixture.runtime.admitIncomingMessage(own, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'control', handled: false });
        expect(volatileRead).not.toHaveBeenCalled();
        expect(durableRead).not.toHaveBeenCalled();
    });

    // Task 5 m2 (D20): the session's one memory pair is shared by both carriers, so a volatile message that
    // arrives over WS and again over RTC meets its first admission and is dispatched once.
    it('answers duplicate for a second copy of a volatile message over the other carrier and dispatches it once', async () => {
        const pairs = createObservedInboundPairs();
        const overWs = await createReadyInboundLaneRuntime(pairs);
        const overRtc = createInboundTestRuntime({
            carrier: 'rtc',
            stores: createInboundTestBackendStores({
                namespace: 'lane-durable-rtc',
                storage: 'memory',
                observer: createPassThroughIndexedDbOperationObserver()
            }).stores,
            volatileStores: pairs.volatile.stores,
            effectWorkerId: 'al-inbound:lanes-rtc'
        });
        await overRtc.runtime.ready();
        const message = createInboundTestMessage({ msgId: 'volatile-both-carriers' });

        expect((await overWs.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        expect(
            (await overRtc.runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID }))
                .right
        ).toEqual({ kind: 'duplicate' });

        await vi.waitFor(() => expect([...overWs.delivered, ...overRtc.delivered]).toEqual(['dispatched']));
        await runInboundRounds(overWs);
        await runInboundRounds(overRtc);
        expect([...overWs.delivered, ...overRtc.delivered]).toEqual(['dispatched']);
    });

    // R-S3a-15: the runner regime reads the IndexedDB lane only, so every event a lane states names the lane.
    it('names the lane on the drain and claim events each store lane states', async () => {
        const pairs = createObservedInboundPairs();
        const fixture = await createReadyInboundLaneRuntime(pairs);

        await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'lane-volatile' }), INBOUND_TEST_SOURCE);
        await fixture.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'lane-durable', durability: 'local-inbox' }),
            INBOUND_TEST_SOURCE
        );
        await vi.waitFor(async () => {
            await runInboundRounds(fixture);
            expect(fixture.delivered).toHaveLength(2);
        });

        const laneEvents = fixture.diagnostics.filter((event) =>
            event.kind === 'effect-drain' || event.kind === 'claim-settled' || event.kind === 'rotation-alive'
        );
        const laneOf = (workerId: string) => workerId.endsWith('/volatile') ? 'volatile' : 'durable';
        for (const event of laneEvents) {
            expect(event, `${event.kind} ${event.workerId}`).toMatchObject({ lane: laneOf(event.workerId) });
        }
        expect(new Set(laneEvents.filter((event) => event.kind === 'claim-settled').map((event) => laneOf(event.workerId))))
            .toEqual(new Set(['durable', 'volatile']));
    });

    it('sweeps its memory pair on its own round once per eviction interval, and the sweep shrinks the admission map', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const startedAtMs = Date.now();
        const pairs = createObservedInboundPairs();
        const fixture = await createReadyInboundLaneRuntime(pairs);
        // The bootstrap round sweeps first.
        expect(pairs.volatile.evictExpired).toHaveBeenCalledTimes(1);
        await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'expiring' }), INBOUND_TEST_SOURCE);
        await vi.waitFor(() => expect(fixture.delivered).toEqual(['dispatched']));
        const rowsAfterDelivery = pairs.volatile.state.data.size;
        expect(rowsAfterDelivery).toBeGreaterThan(0);

        vi.setSystemTime(startedAtMs + AL_VOLATILE_STORE_EVICTION_INTERVAL_MS - 1);
        await runInboundRounds(fixture);
        expect(pairs.volatile.evictExpired, 'no sweep before the interval elapsed').toHaveBeenCalledTimes(1);

        vi.setSystemTime(startedAtMs + AL_VOLATILE_STORE_EVICTION_INTERVAL_MS);
        await runInboundRounds(fixture);
        expect(pairs.volatile.evictExpired, 'one sweep once the interval elapsed').toHaveBeenCalledTimes(2);

        // The owner row keeps the 60 s deadline plus the receipt grace (D74): gone 90 s after the send.
        vi.setSystemTime(startedAtMs + 2 * AL_VOLATILE_STORE_EVICTION_INTERVAL_MS);
        await runInboundRounds(fixture);
        expect(pairs.volatile.evictExpired).toHaveBeenCalledTimes(3);
        expect(pairs.volatile.state.data.size).toBeLessThan(rowsAfterDelivery);
    });
});

interface ObservedInboundPairs {
    readonly durable: Readonly<{ backend: InMemoryAdmissionBackend; stores: ALInboundRuntimeStores; }>;
    readonly volatile: Readonly<{
        backend: InMemoryAdmissionBackend;
        state: ReturnType<typeof createInMemoryALAdmissionState>;
        evictExpired: ReturnType<typeof vi.fn<() => void>>;
        stores: ALVolatileInboundRuntimeStores;
    }>;
}

/** A durable pair and a memory pair whose admission map and sweep the test can observe; `read` expires lazily. */
function createObservedInboundPairs(): ObservedInboundPairs {
    const durable = createInboundTestBackendStores({
        namespace: 'lane-durable',
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const evictExpired = vi.fn(() => backend.evictExpired());
    const stores: ALVolatileInboundRuntimeStores = {
        admissionStore: createVolatileALInboundAdmissionStore({
            nowMs: Date.now,
            namespace: 'lane-volatile',
            backend,
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue,
        evictExpired
    };
    return {
        durable: { backend: durable.backend as InMemoryAdmissionBackend, stores: durable.stores },
        volatile: { backend, state, evictExpired, stores }
    };
}

async function createReadyInboundLaneRuntime(pairs: ObservedInboundPairs): Promise<InboundTestRuntime> {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: pairs.durable.stores,
        volatileStores: pairs.volatile.stores,
        effectWorkerId: 'al-inbound:lanes'
    });
    await fixture.runtime.ready();
    return fixture;
}

async function readOwnerSenders(
    pairs: ObservedInboundPairs,
    message: ALMessage
): Promise<Readonly<{ durable: readonly string[]; volatile: readonly string[]; }>> {
    const read = async (backend: InMemoryAdmissionBackend, stores: ALInboundRuntimeStores) => {
        const owner = await readInboundTestMessageOwner({
            backend,
            namespace: stores.admissionStore.namespace,
            msgId: message.id.msgId,
            senderId: message.id.senderId
        });
        return owner === undefined ? [] : [owner.senderId];
    };
    return {
        durable: await read(pairs.durable.backend, pairs.durable.stores),
        volatile: await read(pairs.volatile.backend, pairs.volatile.stores)
    };
}

/** The relay state an acknowledgement from the fixture's sender completes: one peer owes it. */
async function seedPendingAcknowledgement(store: ALInboundAdmissionStore, message: ALMessage): Promise<void> {
    const expireAtTimestamp = Date.now() + 60_000;
    const { msgId, senderId } = message.id;
    const committed = await store.commitBundle({
        admissionExpiresAtMs: null,
        senderId,
        observations: (await readInboundTestDecisionSurface(store, message)).observations,
        mutations: [{
            kind: 'set-msg-owner',
            value: { msgId, senderId, source: INBOUND_TEST_SOURCE, supersedenceKey: null },
            expireAtTimestamp
        }, {
            kind: 'set-control-pending',
            msgId,
            senderId,
            value: {
                kind: 'pending',
                value: {
                    toPeerId: 'upstream',
                    status: 'subtree-complete',
                    localReady: true,
                    expectedFromPeerIds: [INBOUND_TEST_SENDER_PEER_ID],
                    ackedFromPeerIds: [],
                    expireAtTimestamp,
                    carrier: 'ws'
                }
            },
            expireAtTimestamp
        }, {
            kind: 'set-control-owners',
            msgId,
            value: { ambiguous: false, values: [{ peerId: INBOUND_TEST_SENDER_PEER_ID, senderId }] },
            expireAtTimestamp
        }],
        durableEffects: []
    });
    expect(committed).toBe('committed');
}

function toSenderAck(tracked: ALMessage): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${tracked.id.msgId}`, senderId: INBOUND_TEST_SENDER_PEER_ID, ts: Date.now() },
        {
            ackedMsgId: tracked.id.msgId,
            fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
            toPeerId: INBOUND_TEST_SELF_PEER_ID,
            originPeerId: tracked.id.senderId,
            logicalRecipientPeerId: INBOUND_TEST_SENDER_PEER_ID,
            carrier: 'ws',
            status: 'accepted',
            observedAtEpochMs: Date.now()
        }
    );
}

/** Enough engine rounds for the rotation to run at least one batch: it batches every other idle round. */
async function runInboundRounds(fixture: InboundTestRuntime): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
        await fixture.queueEngine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}
