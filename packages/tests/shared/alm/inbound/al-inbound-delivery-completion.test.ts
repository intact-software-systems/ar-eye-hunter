import { afterEach, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundBufferedReleaseReadDto,
    ALInboundDeliveryProgress
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestStores,
    readInboundTestAdmission
} from '../inbound-runtime-test-fixture.ts';

afterEach(() => {
    vi.useRealTimers();
});

const FIRST = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
const TRACK_KEY = toALOrderingTrackKey(FIRST)!;

/** A memory store holding message 1 admitted on its track, ready for its delivery's completion. */
async function createAdmittedStore(): Promise<ALInboundAdmissionStore> {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { admissionStore } = createInboundTestStores({
        namespace: 'inbound-delivery-completion',
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    await admit(admissionStore, FIRST);
    return admissionStore;
}

async function admit(admissionStore: ALInboundAdmissionStore, msg: ALMessage): Promise<void> {
    expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, msg))).toBe('committed');
}

/** The slot and the progress message 1's completion reads after its delivery. */
async function readCompletion(admissionStore: ALInboundAdmissionStore): Promise<ALInboundBufferedReleaseReadDto> {
    const read = await admissionStore.readBufferedRelease({ trackKey: TRACK_KEY, seq: 1, nowMs: Date.now() });
    expect(read?.observations.deliveryProgress?.value?.completedThrough).toBe(0);
    return read!;
}

async function commitCompletion(
    admissionStore: ALInboundAdmissionStore,
    read: ALInboundBufferedReleaseReadDto
): Promise<'committed' | 'conflict'> {
    return await admissionStore.commitDeliveryCompletion({
        trackKey: TRACK_KEY,
        seq: 1,
        observedSlot: read.snapshot,
        observedProgress: read.observations.deliveryProgress!.value!,
        completesThrough: 1
    });
}

async function readStoredProgress(admissionStore: ALInboundAdmissionStore): Promise<ALInboundDeliveryProgress | undefined> {
    const track = await admissionStore.readOrderingTrack({ trackKey: TRACK_KEY, message: FIRST.id, nowMs: Date.now() });
    return track.observations.deliveryProgress?.value;
}

async function readStoredSlot(admissionStore: ALInboundAdmissionStore) {
    return (await admissionStore.readBufferedRelease({ trackKey: TRACK_KEY, seq: 1, nowMs: Date.now() }))?.snapshot;
}

// The next admission on the track extends the progress row's expiry with the same position; a completion fenced on
// that whole row conflicted, and its work handed the delivered message to the application again.
it('completes a delivery whose track\'s expiry another admission extended meanwhile', async () => {
    const admissionStore = await createAdmittedStore();
    const read = await readCompletion(admissionStore);
    vi.setSystemTime(Date.now() + 1_000);
    await admit(admissionStore, createInboundTestMessage({ msgId: 'message-2', seq: 2 }));
    const refreshed = (await readStoredProgress(admissionStore))!;
    expect(refreshed.expireAtTimestamp).toBeGreaterThan(read.observations.deliveryProgress!.value!.expireAtTimestamp);

    expect(await commitCompletion(admissionStore, read)).toBe('committed');

    expect(await readStoredProgress(admissionStore)).toEqual({
        completedThrough: 1,
        expireAtTimestamp: refreshed.expireAtTimestamp
    });
    expect(await readStoredSlot(admissionStore)).toBeUndefined();
});

// A completion that lost its position to another one is a real move: it writes nothing.
it('refuses a completion whose position another completion moved', async () => {
    const admissionStore = await createAdmittedStore();
    const first = await readCompletion(admissionStore);
    const second = await readCompletion(admissionStore);
    expect(await commitCompletion(admissionStore, first)).toBe('committed');
    const progress = await readStoredProgress(admissionStore);

    expect(await commitCompletion(admissionStore, second)).toBe('conflict');

    expect(progress?.completedThrough).toBe(1);
    expect(await readStoredProgress(admissionStore)).toEqual(progress);
    expect(await readStoredSlot(admissionStore)).toBeUndefined();
});

// The slot the completion read is the one it deletes: a slot that holds another message than the read is not it.
it('refuses a completion whose slot holds another message than it read', async () => {
    const admissionStore = await createAdmittedStore();
    const read = await readCompletion(admissionStore);
    const other = createInboundTestMessage({ msgId: 'other-message', seq: 1 });
    const progress = await readStoredProgress(admissionStore);

    expect(await commitCompletion(admissionStore, { ...read, snapshot: { ...read.snapshot, msg: other } }))
        .toBe('conflict');

    expect(await readStoredProgress(admissionStore)).toEqual(progress);
    expect(await readStoredSlot(admissionStore)).toEqual(read.snapshot);
});

// A slot gone since the read leaves nothing to complete: the completion writes nothing.
it('refuses a completion whose slot is gone', async () => {
    const admissionStore = await createAdmittedStore();
    const read = await readCompletion(admissionStore);
    expect(
        await admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: FIRST.id.senderId,
            observations: read.observations,
            mutations: [{ kind: 'delete-buffered', trackKey: TRACK_KEY, seq: 1 }],
            durableEffects: []
        })
    ).toBe('committed');
    const progress = await readStoredProgress(admissionStore);

    expect(await commitCompletion(admissionStore, read)).toBe('conflict');

    expect(await readStoredProgress(admissionStore)).toEqual(progress);
    expect(progress?.completedThrough).toBe(0);
});

// The completion decides on its position and its slot alone; a control row of its message written meanwhile is not
// either, and used to conflict it all the same.
it('refuses nothing for a control row written meanwhile', async () => {
    const admissionStore = await createAdmittedStore();
    const read = await readCompletion(admissionStore);
    expect(
        await admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: FIRST.id.senderId,
            observations: read.observations,
            mutations: [{
                kind: 'set-control-owners',
                msgId: FIRST.id.msgId,
                value: { ambiguous: false, values: [{ peerId: 'downstream', senderId: FIRST.id.senderId }] },
                expireAtTimestamp: read.snapshot.ownerRetainUntilMs
            }],
            durableEffects: []
        })
    ).toBe('committed');

    expect(await commitCompletion(admissionStore, read)).toBe('committed');

    expect((await readStoredProgress(admissionStore))?.completedThrough).toBe(1);
    expect(await readStoredSlot(admissionStore)).toBeUndefined();
});
