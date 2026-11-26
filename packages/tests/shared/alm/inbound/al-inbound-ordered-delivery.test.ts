import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestOrderedDelivery,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
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

// The last of the bounded attempts still reads, decides and writes.
it('completes on the last attempt after two lost writes', async () => {
    const admissionStore = await createAdmittedStore();
    loseNextCompletionWrites(admissionStore, 2);

    expect(await createInboundTestOrderedDelivery(admissionStore).complete(FIRST)).toBe('completed');

    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 2)).completedThrough).toBe(1);
    expect(await readSlot(admissionStore)).toBeUndefined();
});

// A fresh attempt reads the track again: a write that merely went out again would meet the moved position each time and
// hand the work back, to be dispatched again.
it('answers a completion whose position another completion moved, without writing', async () => {
    const admissionStore = await createAdmittedStore();
    const commitDeliveryCompletion = admissionStore.commitDeliveryCompletion.bind(admissionStore);
    vi.spyOn(admissionStore, 'commitDeliveryCompletion').mockImplementationOnce(async (completion) => {
        const competing = (await readSlot(admissionStore))!;
        expect(
            await commitDeliveryCompletion({
                trackKey: TRACK_KEY,
                seq: 1,
                observedSlot: competing.snapshot,
                observedProgress: competing.observations.deliveryProgress!.value!
            })
        ).toBe('committed');
        return await commitDeliveryCompletion(completion);
    });
    const competitorPosition = async () =>
        (await admissionStore.readOrderingTrack({ trackKey: TRACK_KEY, message: FIRST.id, nowMs: Date.now() }))
            .observations.deliveryProgress?.value;

    expect(await createInboundTestOrderedDelivery(admissionStore).complete(FIRST)).toBe('completed');

    expect((await competitorPosition())?.completedThrough).toBe(1);
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

// A copy records its carrier on the slot only while its sequence is held behind a gap, and the release answers that
// pair `delivered`. Sequence 2 is held, released by sequence 1, and its copy on another carrier arrives during its
// completion: the sequence is no longer held, so the slot stays as the completion read it, and the copy is answered
// `delivered` on its own carrier, as a pair recorded on the slot would have been.
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
    expect((await fixture.runtime.admitIncomingMessage(createAcknowledgedMessage(1), INBOUND_TEST_SOURCE)).right?.kind)
        .toBe('admitted');
    const draining = runInboundWorkDueNow(fixture);
    await completionRead.promise;
    expect(fixture.deliveredMessages.map((delivered) => delivered.id.msgId)).toEqual(['message-1', 'message-2']);
    const read = await readBufferedRelease({ trackKey: TRACK_KEY, seq: 2, nowMs: Date.now() });

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

/** Each ACK of `msgId` the store holds a `send-control` row for: its carrier, recipient and status. */
async function readStoredAcks(stores: ALInboundRuntimeStores, msgId: string) {
    return (await readInboundTestWorkRows(stores)).flatMap((row) => {
        const parsed = row.payload.kind === 'send-control' ? parseALControlMessage(row.payload.msg) : undefined;
        return parsed?.type === 'ack' && parsed.payload.ackedMsgId === msgId
            ? [{ carrier: row.carrier, toPeerId: parsed.payload.toPeerId, status: parsed.payload.status }]
            : [];
    });
}
