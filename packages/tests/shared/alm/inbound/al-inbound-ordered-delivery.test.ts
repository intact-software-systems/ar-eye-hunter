import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALInboundAdmissionStore, ALInboundPlanner } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundOrderedDelivery } from '@shared/alm/inbound/al-inbound-ordered-delivery.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestOrderedDelivery,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    planInboundTestMessage,
    readInboundTestAdmission,
    readInboundTestWorkRows,
    runInboundWorkDueNow
} from '../inbound-runtime-test-fixture.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const FIRST = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
const TRACK_KEY = toALOrderingTrackKey(FIRST)!;

/** A memory store holding message 1 admitted on its track, ready for its delivery's completion. */
async function createAdmittedStore(): Promise<ALInboundAdmissionStore> {
    const { admissionStore } = createInboundTestStores({
        namespace: 'inbound-ordered-delivery',
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, FIRST))).toBe('committed');
    return admissionStore;
}

/** The store's next `count` completion writes lose, as a write whose row versions moved does; the rest are its own. */
function loseNextCompletionWrites(admissionStore: ALInboundAdmissionStore, count: number): void {
    const spy = vi.spyOn(admissionStore, 'commitDeliveryCompletion');
    for (let lost = 0; lost < count; lost += 1) {
        spy.mockResolvedValueOnce('conflict');
    }
}

/** The answer of a delivery on the fixture's track whose progress stands at `position`. */
function completedThrough(position: number): ALInboundOrderedDelivery.Completed {
    return { kind: 'completed', position: { trackKey: TRACK_KEY, completedThrough: position } };
}

async function readSlot(admissionStore: ALInboundAdmissionStore) {
    return await admissionStore.readBufferedRelease({ trackKey: TRACK_KEY, seq: 1, nowMs: Date.now() });
}

// A completion runs after the application was handed the message, so a lost write is read and decided again; when
// every bounded attempt loses, the work goes back, to be dispatched again as after a crash. A fourth attempt would
// reach the store and commit.
it('hands the work back when every attempt of its completion conflicts', async () => {
    const admissionStore = await createAdmittedStore();
    loseNextCompletionWrites(admissionStore, 3);

    expect(await createInboundTestOrderedDelivery(admissionStore).complete(FIRST)).toBe('retry');

    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 2)).completedThrough).toBe(0);
    expect(await readSlot(admissionStore)).toBeDefined();
});

// The last of the bounded attempts still reads, decides and writes, and answers the position its write committed.
it('completes on the last attempt after two lost writes', async () => {
    const admissionStore = await createAdmittedStore();
    loseNextCompletionWrites(admissionStore, 2);

    expect(await createInboundTestOrderedDelivery(admissionStore).complete(FIRST)).toEqual(completedThrough(1));

    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 2)).completedThrough).toBe(1);
    expect(await readSlot(admissionStore)).toBeUndefined();
});

// A fresh attempt reads the track again: a write that merely went out again would meet the moved position each time and
// hand the work back, to be dispatched again. The competitor's later expiry marks its row, so a fresh attempt that
// wrote the position again would show in it. The answer states the position the fresh attempt read.
it('answers a completion whose position another completion moved, without writing', async () => {
    const admissionStore = await createAdmittedStore();
    const commitDeliveryCompletion = admissionStore.commitDeliveryCompletion.bind(admissionStore);
    const readProgress = async () =>
        (await admissionStore.readOrderingTrack({ trackKey: TRACK_KEY, message: FIRST.id, nowMs: Date.now() }))
            .observations.deliveryProgress?.value;
    let competitorProgress: Awaited<ReturnType<typeof readProgress>>;
    vi.spyOn(admissionStore, 'commitDeliveryCompletion').mockImplementationOnce(async (completion) => {
        const competing = (await readSlot(admissionStore))!;
        const observedProgress = competing.observations.deliveryProgress!.value!;
        const extendedExpiry = observedProgress.expireAtTimestamp + 60_000;
        expect(
            await commitDeliveryCompletion({
                trackKey: TRACK_KEY,
                seq: 1,
                observedSlot: competing.snapshot,
                observedProgress: { ...observedProgress, expireAtTimestamp: extendedExpiry }
            })
        ).toBe('committed');
        competitorProgress = await readProgress();
        expect(competitorProgress).toEqual({ completedThrough: 1, expireAtTimestamp: extendedExpiry });
        const stale = await commitDeliveryCompletion(completion);
        expect(stale).toBe('conflict');
        return stale;
    });

    expect(await createInboundTestOrderedDelivery(admissionStore).complete(FIRST)).toEqual(completedThrough(1));

    expect(await readProgress()).toEqual(competitorProgress);
    expect(await readSlot(admissionStore)).toBeUndefined();
});

// A completion that reads its message already completed answers the position it read, not its message's own sequence:
// a later delivery is handed on from that position. It stands for a second claim of the same row, taken after the
// first claim's lease expired, whose completion commits between the store's read of the slot and its read of the
// track's progress, which are separate reads; a later message's completion follows it, so the progress read is past
// the message. The hold sits in the store's own progress read.
it('answers the position it read for a completion that finds its message already completed', async () => {
    const namespace = 'inbound-ordered-delivery-already-completed';
    const { backend, stores } = createInboundTestBackendStores({
        namespace,
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const { admissionStore } = stores;
    for (const msg of [FIRST, SECOND]) {
        expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, msg))).toBe('committed');
    }
    const competing = createInboundTestOrderedDelivery(admissionStore);
    const read = backend.read.bind(backend);
    let held = false;
    vi.spyOn(backend, 'read').mockImplementation(async (key, decode) => {
        if (!held && key === `${namespace}:delivered:${TRACK_KEY}`) {
            held = true;
            expect(await competing.complete(FIRST)).toEqual(completedThrough(1));
            expect(await competing.complete(SECOND)).toEqual(completedThrough(2));
        }
        return await read(key, decode);
    });

    expect(await createInboundTestOrderedDelivery(admissionStore).complete(FIRST)).toEqual(completedThrough(2));

    expect(held).toBe(true);
    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 3)).completedThrough).toBe(2);
    expect(await readSlot(admissionStore)).toBeUndefined();
});

// The position a completion wrote is the track's progress, not its message's own sequence: a slot whose delivery
// reaches past its sequence moves the track through that reach, and the answer states it. The fixture sets the
// admitted slot's reach to 3 directly; it stands for a bounded hold that entered the track with the copies after the
// message expired, which no delivery will complete.
it('answers the position its write committed for a slot that reaches past its own sequence', async () => {
    const { admissionStore } = createInboundTestStores({
        namespace: 'inbound-ordered-delivery-reaching',
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const admission = await readInboundTestAdmission(admissionStore, FIRST);
    const reaching = {
        ...admission,
        mutations: admission.mutations.map((mutation) =>
            mutation.kind === 'set-buffered' ? { ...mutation, snapshot: { ...mutation.snapshot, completesThrough: 3 } } : mutation
        )
    };
    expect(await admissionStore.commitBundle(reaching)).toBe('committed');
    expect((await readSlot(admissionStore))?.snapshot.completesThrough).toBe(3);

    expect(await createInboundTestOrderedDelivery(admissionStore).complete(FIRST)).toEqual(completedThrough(3));

    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 4)).completedThrough).toBe(3);
    expect(await readSlot(admissionStore)).toBeUndefined();
});

// Only a lost write is attempted again: a store that fails otherwise fails the completion, and nothing is written.
it('lets a store failure that is not a conflict out of the completion', async () => {
    const admissionStore = await createAdmittedStore();
    const failure = new Error('admission storage unavailable');
    vi.spyOn(admissionStore, 'commitDeliveryCompletion').mockRejectedValueOnce(failure);

    await expect(createInboundTestOrderedDelivery(admissionStore).complete(FIRST)).rejects.toBe(failure);

    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 2)).completedThrough).toBe(0);
    expect(await readSlot(admissionStore)).toBeDefined();
});

/** The acknowledged message at `seq` of the fixture's track. */
function createAcknowledgedMessage(seq: number): ALMessage {
    return createInboundTestMessage({ msgId: `message-${seq}`, seq, acknowledged: true });
}

// Sequence 2 is held behind the gap at 1, released by sequence 1, and its copy on another carrier arrives during its
// completion: the slot stays as the completion read it, and the copy is answered `delivered` on its own carrier.
it('answers a copy on another carrier that arrives during a released message\'s completion delivered on that carrier', async () => {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: 'inbound-ordered-delivery-copy',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: 'inbound-ordered-delivery-copy'
    });
    const { admissionStore } = fixture.stores;
    const released = createAcknowledgedMessage(2);
    const completionRead = Promise.withResolvers<void>();
    const releaseCompletion = Promise.withResolvers<void>();
    const readBufferedRelease = admissionStore.readBufferedRelease.bind(admissionStore);
    let completionReadDone = false;
    const isReleasedDispatched = () => fixture.deliveredMessages.some((delivered) => delivered.id.msgId === 'message-2');
    vi.spyOn(admissionStore, 'readBufferedRelease').mockImplementation(async (input) => {
        const read = await readBufferedRelease(input);
        // The release reads the slot before the dispatch; the completion reads it after.
        if (input.seq === 2 && isReleasedDispatched() && !completionReadDone) {
            completionReadDone = true;
            completionRead.resolve();
            await releaseCompletion.promise;
        }
        return read;
    });
    onTestFinished(() => releaseCompletion.resolve());
    expect((await fixture.runtime.admitIncomingMessage(released, INBOUND_TEST_SOURCE)).right?.kind).toBe('admitted');
    expect(await admissionStore.readOrderingSnapshot(TRACK_KEY, Date.now())).toMatchObject({
        lastContiguousSeq: 0,
        bufferedSeqs: [2]
    });
    expect((await fixture.runtime.admitIncomingMessage(createAcknowledgedMessage(1), INBOUND_TEST_SOURCE)).right?.kind)
        .toBe('admitted');
    const draining = runInboundWorkDueNow(fixture);
    await completionRead.promise;
    expect(fixture.deliveredMessages.map((delivered) => delivered.id.msgId)).toEqual(['message-1', 'message-2']);
    const read = await readBufferedRelease({ trackKey: TRACK_KEY, seq: 2, nowMs: Date.now() });
    expect(read?.snapshot.msg.id.msgId).toBe('message-2');

    const copy = await fixture.runtime.admitIncomingMessage(released, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });
    expect(copy.right?.kind).toBe('duplicate');
    expect((await readBufferedRelease({ trackKey: TRACK_KEY, seq: 2, nowMs: Date.now() }))?.snapshot).toEqual(read?.snapshot);
    releaseCompletion.resolve();
    await draining;
    await runInboundWorkDueNow(fixture);

    expect(fixture.deliveredMessages.map((delivered) => delivered.id.msgId)).toEqual(['message-1', 'message-2']);
    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 3)).completedThrough).toBe(2);
    expect(await readStoredAcks(fixture.stores, released.id.msgId)).toEqual([
        { carrier: 'ws', toPeerId: INBOUND_TEST_SENDER_PEER_ID, status: 'delivered' },
        { carrier: 'rtc', toPeerId: INBOUND_TEST_SENDER_PEER_ID, status: 'delivered' }
    ]);
});

const SECOND = createInboundTestMessage({ msgId: 'message-2', seq: 2 });
const SECOND_DELIVERY = { kind: 'dispatch-local', message: { senderId: INBOUND_TEST_SENDER_PEER_ID, msgId: 'message-2' } };
/** The ACK a committed release of message 2 writes, which its admission behind the gap did not. */
const SECOND_DELIVERED_ACK = { carrier: 'ws', toPeerId: INBOUND_TEST_SENDER_PEER_ID, status: 'delivered' };

interface ReleasableStore {
    readonly stores: ALInboundRuntimeStores;
    readonly admissionStore: ALInboundAdmissionStore;
    readonly release: ALInboundOrderedDelivery.ReleaseInput;
}

/**
 * Memory stores holding acknowledged message 2 held behind the gap at 1 and released by message 1's admission, with
 * message 1's delivery `completed` or still `pending`.
 */
async function createReleasableStore(predecessor: 'completed' | 'pending'): Promise<ReleasableStore> {
    const stores = createInboundTestStores({
        namespace: 'inbound-ordered-release',
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const { admissionStore } = stores;
    const first = createAcknowledgedMessage(1);
    for (const msg of [createAcknowledgedMessage(2), first]) {
        expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, msg))).toBe('committed');
    }
    if (predecessor === 'completed') {
        expect(await createInboundTestOrderedDelivery(admissionStore).complete(first)).toEqual(completedThrough(1));
    }
    const effectId = (await readReleaseSlot(admissionStore))!.snapshot.delivery!.effectId;
    return { stores, admissionStore, release: { trackKey: TRACK_KEY, seq: 2, effectId } };
}

async function readReleaseSlot(admissionStore: ALInboundAdmissionStore) {
    return await admissionStore.readBufferedRelease({ trackKey: TRACK_KEY, seq: 2, nowMs: Date.now() });
}

/** What a release writes or leaves: message 2's slot, its owner and the track's progress, and its stored ACKs. */
async function readReleaseFacts(stores: ALInboundRuntimeStores) {
    const slot = await readReleaseSlot(stores.admissionStore);
    return {
        snapshot: slot?.snapshot,
        observations: slot?.observations,
        acks: await readStoredAcks(stores, 'message-2')
    };
}

/** The store's next `count` writes lose, as a write whose observed rows moved does; the rest are its own. */
function loseNextReleaseWrites(admissionStore: ALInboundAdmissionStore, count: number): void {
    const spy = vi.spyOn(admissionStore, 'commitBundle');
    for (let lost = 0; lost < count; lost += 1) {
        spy.mockResolvedValueOnce('conflict');
    }
}

/** A planner that appends to `plans` each time it plans, so the attempts of a release are counted in a list. */
function createRecordingPlanner(plans: string[]): ALInboundPlanner {
    return (msg, source, observations) => {
        plans.push(`plan ${msg.id.msgId}`);
        return planInboundTestMessage(msg, source, observations);
    };
}

// A release whose write lost to an admission on its track went back as RETRY and waited out a retry delay past its
// message's lifetime; a fresh attempt reads the moved progress and releases the message in the same call.
it('releases a held message whose first write lost to an admission on its track, in the same call', async () => {
    const { stores, admissionStore, release } = await createReleasableStore('completed');
    const third = createInboundTestMessage({ msgId: 'message-3', seq: 3 });
    const laterThird: ALMessage = { ...third, constraints: { ...third.constraints, expiresAtMs: Date.now() + 120_000 } };
    const readBufferedRelease = admissionStore.readBufferedRelease.bind(admissionStore);
    vi.spyOn(admissionStore, 'readBufferedRelease').mockImplementationOnce(async (input) => {
        const read = (await readBufferedRelease(input))!;
        expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, laterThird))).toBe(
            'committed'
        );
        const moved = (await readBufferedRelease(input))!.observations.deliveryProgress!.value!;
        expect(moved.expireAtTimestamp).toBeGreaterThan(read.observations.deliveryProgress!.value!.expireAtTimestamp);
        return read;
    });
    expect(await readStoredAcks(stores, 'message-2')).toEqual([]);

    expect(await createInboundTestOrderedDelivery(admissionStore).release(release)).toEqual(SECOND_DELIVERY);

    expect(await readStoredAcks(stores, 'message-2')).toEqual([SECOND_DELIVERED_ACK]);
    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 2)).completedThrough).toBe(1);
});

// The bound of a release's fresh attempts: when each loses, the work goes back and nothing is written. A fourth
// attempt would reach the store and commit.
it('hands a release back when every attempt of its write is lost', async () => {
    const { stores, admissionStore, release } = await createReleasableStore('completed');
    const before = await readReleaseFacts(stores);
    loseNextReleaseWrites(admissionStore, 3);

    expect(await createInboundTestOrderedDelivery(admissionStore).release(release)).toBe('retry');

    expect(await readReleaseFacts(stores)).toEqual(before);
});

// The last of the bounded attempts still reads, decides and writes.
it('releases a held message on the last attempt after two lost writes', async () => {
    const { stores, admissionStore, release } = await createReleasableStore('completed');
    loseNextReleaseWrites(admissionStore, 2);

    expect(await createInboundTestOrderedDelivery(admissionStore).release(release)).toEqual(SECOND_DELIVERY);

    expect(await readStoredAcks(stores, 'message-2')).toEqual([SECOND_DELIVERED_ACK]);
});

// Only a lost write is attempted again: a predecessor that has not completed writes nothing, and a second read finds
// the same. The planner's list is the only record of the attempts, since the waiting release writes nothing.
it('answers retry at once for a release whose predecessor has not completed', async () => {
    const { stores, admissionStore, release } = await createReleasableStore('pending');
    const before = await readReleaseFacts(stores);
    const plans: string[] = [];
    const delivery = createInboundTestOrderedDelivery(admissionStore, { planIncomingMessage: createRecordingPlanner(plans) });

    expect(await delivery.release(release)).toBe('retry');

    expect(plans).toEqual(['plan message-2']);
    expect(await readReleaseFacts(stores)).toEqual(before);
});

// A disposed owner must not keep attempting: a release whose write lost while its shutdown signal aborted answers
// retry and plans no second attempt.
it('makes no further attempt once its shutdown signal aborted during a lost write', async () => {
    const { stores, admissionStore, release } = await createReleasableStore('completed');
    const before = await readReleaseFacts(stores);
    const plans: string[] = [];
    const shutdown = new AbortController();
    vi.spyOn(admissionStore, 'commitBundle').mockImplementationOnce(async () => {
        shutdown.abort();
        return 'conflict';
    });
    const delivery = createInboundTestOrderedDelivery(admissionStore, {
        planIncomingMessage: createRecordingPlanner(plans),
        signal: shutdown.signal
    });

    expect(await delivery.release(release)).toBe('retry');

    expect(plans).toEqual(['plan message-2']);
    expect(await readReleaseFacts(stores)).toEqual(before);
});

// A release whose readiness reads its message completed answers the position that read found, not its message's own
// sequence: another delivery completed message 2, and message 3 after it, between the release's slot read and its
// readiness read, so it hands nothing to the application, writes nothing, and states where the track stands (3).
it('answers the position its readiness read for a release whose message completed after its slot read', async () => {
    const { stores, admissionStore, release } = await createReleasableStore('completed');
    const third = createAcknowledgedMessage(3);
    const readBufferedRelease = admissionStore.readBufferedRelease.bind(admissionStore);
    vi.spyOn(admissionStore, 'readBufferedRelease').mockImplementationOnce(async (input) => {
        const read = (await readBufferedRelease(input))!;
        expect(
            await admissionStore.commitDeliveryCompletion({
                trackKey: TRACK_KEY,
                seq: 2,
                observedSlot: read.snapshot,
                observedProgress: read.observations.deliveryProgress!.value!
            })
        ).toBe('committed');
        expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, third))).toBe('committed');
        expect(await createInboundTestOrderedDelivery(admissionStore).complete(third)).toEqual(completedThrough(3));
        return read;
    });

    expect(await createInboundTestOrderedDelivery(admissionStore).release(release)).toEqual(completedThrough(3));

    expect(await readReleaseSlot(admissionStore)).toBeUndefined();
    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 4)).completedThrough).toBe(3);
    expect(await readStoredAcks(stores, 'message-2')).toEqual([]);
});

// A fresh attempt reads what the winner left: a slot another release took and completed during this release's lost
// write reads as completed at the position the winner moved the track to, so this release hands nothing to the
// application a second time. Message 3 is admitted and completed after it, so the position the confirmation reads (3)
// is not the message's own sequence.
it('answers completed for a release whose slot another release took and completed during its lost write', async () => {
    const { stores, admissionStore, release } = await createReleasableStore('completed');
    const third = createAcknowledgedMessage(3);
    const commitBundle = admissionStore.commitBundle.bind(admissionStore);
    vi.spyOn(admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
        expect(await commitBundle(bundle)).toBe('committed');
        const competing = (await readReleaseSlot(admissionStore))!;
        expect(
            await admissionStore.commitDeliveryCompletion({
                trackKey: TRACK_KEY,
                seq: 2,
                observedSlot: competing.snapshot,
                observedProgress: competing.observations.deliveryProgress!.value!
            })
        ).toBe('committed');
        expect(await commitBundle(await readInboundTestAdmission(admissionStore, third))).toBe('committed');
        expect(await createInboundTestOrderedDelivery(admissionStore).complete(third)).toEqual(completedThrough(3));
        const stale = await commitBundle(bundle);
        expect(stale).toBe('conflict');
        return stale;
    });

    expect(await createInboundTestOrderedDelivery(admissionStore).release(release)).toEqual(completedThrough(3));

    expect(await readReleaseSlot(admissionStore)).toBeUndefined();
    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 4)).completedThrough).toBe(3);
});

// A release's dispatch follows its committed write: a fresh attempt that dispatched as well as the committed one would
// hand message 2 twice. A lost first write that went back as RETRY took a second claim of the release's work; here a
// RETRY row is due at once, so its claims, not the delivery, tell the two apart.
it('delivers a held message once when its release\'s first write is lost', async () => {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: 'inbound-ordered-release-runtime',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: 'inbound-ordered-release-runtime'
    });
    const { admissionStore } = fixture.stores;
    expect((await fixture.runtime.admitIncomingMessage(SECOND, INBOUND_TEST_SOURCE)).right?.kind).toBe('admitted');
    expect((await fixture.runtime.admitIncomingMessage(FIRST, INBOUND_TEST_SOURCE)).right?.kind).toBe('admitted');
    // After both admissions, the release is the run's only bundle write: each completion has its own.
    loseNextReleaseWrites(admissionStore, 1);

    await runInboundWorkDueNow(fixture);

    expect(fixture.deliveredMessages.map((delivered) => delivered.id.msgId)).toEqual(['message-1', 'message-2']);
    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 3)).completedThrough).toBe(2);
    expect(
        (await readInboundTestWorkRows(fixture.stores)).flatMap((row) =>
            row.payload.kind === 'release-buffered'
                ? [{ status: row.entry.status, attempts: row.entry.dequeueAudit.attempts }]
                : []
        )
    ).toEqual([{ status: 'COMPLETED', attempts: 1 }]);
});

// Only a lost write is attempted again: a store that fails otherwise fails the release from any attempt as the very
// error it threw, not wrapped by the retry's exhaustion at the third, and nothing is written.
it('lets a store failure that is no conflict out of the release, from the first attempt and from the third', async () => {
    const { stores, admissionStore, release } = await createReleasableStore('completed');
    const before = await readReleaseFacts(stores);
    const failure = new Error('admission storage unavailable');
    const delivery = createInboundTestOrderedDelivery(admissionStore);
    vi.spyOn(admissionStore, 'commitBundle').mockRejectedValueOnce(failure);

    await expect(delivery.release(release)).rejects.toBe(failure);
    expect(await readReleaseFacts(stores)).toEqual(before);

    vi.spyOn(admissionStore, 'commitBundle').mockResolvedValueOnce('conflict').mockResolvedValueOnce('conflict')
        .mockRejectedValueOnce(failure);

    await expect(delivery.release(release)).rejects.toBe(failure);
    expect(await readReleaseFacts(stores)).toEqual(before);
});

/** Each ACK of `msgId` the store holds a `send-control` row for: its carrier, recipient and status. */
async function readStoredAcks(stores: ALInboundRuntimeStores, msgId: string) {
    return (await readInboundTestWorkRows(stores)).flatMap((row) => {
        const parsed = row.payload.kind === 'send-control' ? parseALControlMessage(row.payload.msg) : undefined;
        return parsed?.type === 'ack' && parsed.payload.ackedMsgId === msgId
            ? [{ carrier: row.carrier, toPeerId: parsed.payload.toPeerId, status: parsed.payload.status }]
            : [];
    });
}
