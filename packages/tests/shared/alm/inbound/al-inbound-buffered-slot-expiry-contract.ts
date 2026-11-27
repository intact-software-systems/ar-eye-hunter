import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { ALAdmissionCorruptionError, type ALAdmissionDecoder } from '@shared/alm/al-admission-decoder.ts';
import type { ALAdmissionReadSession } from '@shared/alm/al-admission-work-backend.ts';
import type { ALInboundDeliveryCompletion } from '@shared/alm/inbound/admission/al-inbound-delivery-progress.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundBufferedReleaseReadDto
} from '@shared/alm/inbound/al-inbound-admission-store.ts';

import {
    createInboundTestMessage,
    createInboundTestOrderedDelivery,
    readInboundTestAdmission,
    readInboundTestDecisionSurface,
    type InboundTestBackendStores
} from '../inbound-runtime-test-fixture.ts';

/** The stores of one backend under a namespace of the case's own; every reader and writer reads `Date.now`. */
export type ALInboundBufferedSlotExpiryStoresFactory = (namespace: string) => Promise<InboundTestBackendStores>;

/** How long the short-lived copy lives: its slot and its message row, which no other work names, expire together. */
const SHORT_LIVED_MS = 2_000;

interface TestClock {
    nowMs: number;
}

/**
 * One track seeded alike into two stores: message 1 delivered, a short-lived copy at `shortSeq`, and a long-lived copy
 * right after it. The clock stands one millisecond before the short-lived copy expires.
 */
interface SeededTrackPair {
    readonly clock: TestClock;
    readonly trackKey: string;
    readonly expiresAtMs: number;
    readonly shortSeq: number;
    /** Its read of the short-lived copy's message row is the one that tears. */
    readonly torn: InboundTestBackendStores;
    /** It reads once the short-lived copy has expired, which is what a read made just after the expiry answers. */
    readonly late: InboundTestBackendStores;
}

/**
 * A read chain that read a buffered copy's slot and then finds the copy's message row expired, or deleted by a writer
 * that met it expired, must answer as a read made just after the expiry: the copy is gone. Before, every such chain
 * failed with `ALAdmissionCorruptionError`, and the operation it served -- an innocent message's admission, its replay,
 * a release or a delivery -- died with it. A slot that outlives its message row is a real fault and still throws.
 */
export function describeALInboundBufferedSlotExpiryContract(
    label: string,
    createStores: ALInboundBufferedSlotExpiryStoresFactory
): void {
    describe(`${label}: a buffered copy that expires while a read chain resolves it`, () => {
        it('admits against a track read without the copy', async () => {
            const pair = await seedTrackPair(createStores, 3);
            const next = createOrderedMessage(5);
            expireBeforeMessageRead(pair);

            const torn = await readInboundTestDecisionSurface(pair.torn.stores.admissionStore, next);
            pair.clock.nowMs = pair.expiresAtMs;
            const late = await readInboundTestDecisionSurface(pair.late.stores.admissionStore, next);

            expect(torn.observations.ordering?.buffered.map((slot) => slot.seq)).toEqual([4]);
            expect(torn.observations.ordering).toEqual(late.observations.ordering);
        });

        it('reads the track without the copy', async () => {
            const pair = await seedTrackPair(createStores, 3);
            expireBeforeMessageRead(pair);

            const torn = await readTrack(pair.torn.stores.admissionStore, pair.trackKey);
            pair.clock.nowMs = pair.expiresAtMs;
            const late = await readTrack(pair.late.stores.admissionStore, pair.trackKey);

            expect(torn.ordering?.buffered.map((slot) => slot.seq)).toEqual([4]);
            expect(torn.ordering).toEqual(late.ordering);
        });

        it('releases nothing for the copy', async () => {
            const pair = await seedTrackPair(createStores, 3);
            expireBeforeMessageRead(pair);

            const torn = await readRelease(pair.torn.stores.admissionStore, pair.trackKey, 3);
            pair.clock.nowMs = pair.expiresAtMs;
            const late = await readRelease(pair.late.stores.admissionStore, pair.trackKey, 3);

            expect(torn).toBeUndefined();
            expect(late).toBeUndefined();
        });

        it('reads a delivery whose predecessor copy expires as one waiting on the track', async () => {
            const pair = await seedTrackPair(createStores, 3);
            expireBeforeMessageRead(pair);

            const torn = await pair.torn.stores.admissionStore.readOrderedDelivery(pair.trackKey, 4);
            pair.clock.nowMs = pair.expiresAtMs;
            const late = await pair.late.stores.admissionStore.readOrderedDelivery(pair.trackKey, 4);

            expect(torn).toEqual({ completedThrough: 1, predecessor: { kind: 'effect' } });
            expect(torn).toEqual(late);
        });

        it('reads a delivery whose next copy expires as one past a missing copy', async () => {
            const pair = await seedTrackPair(createStores, 2);
            expireBeforeMessageRead(pair);

            const torn = await pair.torn.stores.admissionStore.readOrderedDelivery(pair.trackKey, 3);
            pair.clock.nowMs = pair.expiresAtMs;
            const late = await pair.late.stores.admissionStore.readOrderedDelivery(pair.trackKey, 3);

            expect(torn).toEqual({ completedThrough: 1, predecessor: { kind: 'resync-required' } });
            expect(torn).toEqual(late);
        });

        it('answers conflict for an admission whose commit re-reads the track across the expiry, and writes nothing', async () => {
            const pair = await seedTrackPair(createStores, 3);
            const next = createOrderedMessage(5);
            const tornBundle = await readInboundTestAdmission(pair.torn.stores.admissionStore, next);
            const lateBundle = await readInboundTestAdmission(pair.late.stores.admissionStore, next);
            expireBeforeMessageRead(pair);

            const torn = await pair.torn.stores.admissionStore.commitBundle(tornBundle);
            pair.clock.nowMs = pair.expiresAtMs;
            const late = await pair.late.stores.admissionStore.commitBundle(lateBundle);

            expect(torn).toBe('conflict');
            expect(late).toBe('conflict');
            expect(await readRelease(pair.torn.stores.admissionStore, pair.trackKey, 5)).toBeUndefined();
            expect((await readTrack(pair.torn.stores.admissionStore, pair.trackKey)).ordering?.buffered.map((slot) => slot.seq))
                .toEqual([4]);
        });

        it('answers conflict for a delivery completion whose slot read crosses the expiry, and writes nothing', async () => {
            const pair = await seedTrackPair(createStores, 2);
            const tornRead = (await readRelease(pair.torn.stores.admissionStore, pair.trackKey, 2))!;
            const lateRead = (await readRelease(pair.late.stores.admissionStore, pair.trackKey, 2))!;
            expireBeforeMessageRead(pair);

            const torn = await pair.torn.stores.admissionStore.commitDeliveryCompletion(toCompletion(pair, tornRead));
            pair.clock.nowMs = pair.expiresAtMs;
            const late = await pair.late.stores.admissionStore.commitDeliveryCompletion(toCompletion(pair, lateRead));

            expect(torn).toBe('conflict');
            expect(late).toBe('conflict');
            expect((await readTrack(pair.torn.stores.admissionStore, pair.trackKey)).deliveryProgress?.value?.completedThrough)
                .toBe(1);
        });

        // The second form of the same tear, with no clock: a writer that met both rows expired deleted them between the
        // chain's read of the slot and its read of the message row.
        it('admits against a track read without a copy whose rows another writer deleted during the read', async () => {
            const pair = await seedTrackPair(createStores, 3);
            const next = createOrderedMessage(5);
            const { backend, stores } = pair.torn;
            tearBeforeMessageRead(pair.torn, pair.shortSeq, async () => {
                await backend.write(async (transaction) => {
                    await transaction.remove(toSlotKey(pair.torn, pair.trackKey, pair.shortSeq));
                    await transaction.remove(toMessageKey(pair.torn, pair.shortSeq));
                });
            });

            const torn = await readInboundTestDecisionSurface(stores.admissionStore, next);
            const after = await readInboundTestDecisionSurface(stores.admissionStore, next);

            expect(torn.observations.ordering?.buffered.map((slot) => slot.seq)).toEqual([4]);
            expect(torn.observations.ordering).toEqual(after.observations.ordering);
        });

        it('still refuses as corrupt a slot that outlives its message row', async () => {
            const pair = await seedTrackPair(createStores, 3);
            await outliveMessageRow(pair.torn, pair);
            await outliveMessageRow(pair.late, pair);
            expireBeforeMessageRead(pair);

            await expect(readRelease(pair.torn.stores.admissionStore, pair.trackKey, 3))
                .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
            pair.clock.nowMs = pair.expiresAtMs;
            await expect(readRelease(pair.late.stores.admissionStore, pair.trackKey, 3))
                .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        });
    });
}

async function seedTrackPair(createStores: ALInboundBufferedSlotExpiryStoresFactory, shortSeq: number): Promise<SeededTrackPair> {
    const startMs = Date.now();
    const clock: TestClock = { nowMs: startMs };
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    onTestFinished(() => now.mockRestore());
    const expiresAtMs = startMs + SHORT_LIVED_MS;
    const messages = [
        createOrderedMessage(1),
        { ...createOrderedMessage(shortSeq), constraints: { expiresAtMs } },
        createOrderedMessage(shortSeq + 1)
    ];
    const suffix = crypto.randomUUID();
    const torn = await createStores(`buffered-slot-expiry-torn-${suffix}`);
    const late = await createStores(`buffered-slot-expiry-late-${suffix}`);
    await seedTrack(torn.stores.admissionStore, messages);
    await seedTrack(late.stores.admissionStore, messages);
    clock.nowMs = expiresAtMs - 1;
    return { clock, trackKey: toALOrderingTrackKey(messages[0])!, expiresAtMs, shortSeq, torn, late };
}

function createOrderedMessage(seq: number): ALMessage {
    return createInboundTestMessage({ msgId: `message-${seq}`, seq });
}

async function seedTrack(store: ALInboundAdmissionStore, messages: readonly ALMessage[]): Promise<void> {
    for (const message of messages) {
        expect(await store.commitBundle(await readInboundTestAdmission(store, message))).toBe('committed');
        if (message === messages[0]) {
            expect(await createInboundTestOrderedDelivery(store).complete(message)).toMatchObject({ kind: 'completed' });
        }
    }
}

/** The torn store's clock reaches the short-lived copy's expiry after its slot was read, before its message row is. */
function expireBeforeMessageRead(pair: SeededTrackPair): void {
    tearBeforeMessageRead(pair.torn, pair.shortSeq, () => {
        pair.clock.nowMs = pair.expiresAtMs;
    });
}

/**
 * Runs `tear` once, at the store's first read of the message row of `message-<seq>` in a read session or a write. Each
 * operation these cases call reaches that row only through the buffered slot that names it, so the slot has been read
 * and the row's read has not decided yet.
 */
function tearBeforeMessageRead(
    stores: InboundTestBackendStores,
    seq: number,
    tear: () => void | Promise<void>
): void {
    const messageKey = toMessageKey(stores, seq);
    let armed = true;
    const tearing = <Session extends ALAdmissionReadSession>(session: Session): Session =>
        new Proxy(session, {
            get(target, property) {
                if (property === 'read') {
                    return async <V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> => {
                        if (armed && key === messageKey) {
                            armed = false;
                            await tear();
                        }
                        return await target.read(key, decode);
                    };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    const { backend } = stores;
    const readWithin = backend.readWithin.bind(backend);
    vi.spyOn(backend, 'readWithin').mockImplementation(async (read) => await readWithin((session) => read(tearing(session))));
    const write = backend.write.bind(backend);
    vi.spyOn(backend, 'write').mockImplementation(async (operation, executionExpiresAtMs) =>
        await write((context) => operation(tearing(context)), executionExpiresAtMs)
    );
}

/** The slot of the short-lived copy outlives its message row by one millisecond, which no admission ever writes. */
async function outliveMessageRow(stores: InboundTestBackendStores, pair: SeededTrackPair): Promise<void> {
    const slotKey = toSlotKey(stores, pair.trackKey, pair.shortSeq);
    await stores.backend.write(async (transaction) => {
        const slot = await transaction.read(slotKey, (value) => value);
        await transaction.set(slotKey, slot, pair.expiresAtMs + 1);
    });
}

function toMessageKey(stores: InboundTestBackendStores, seq: number): string {
    return `${stores.stores.admissionStore.namespace}:message:sender:message-${seq}`;
}

function toSlotKey(stores: InboundTestBackendStores, trackKey: string, seq: number): string {
    return `${stores.stores.admissionStore.namespace}:buffered:${trackKey}:${seq}`;
}

async function readTrack(store: ALInboundAdmissionStore, trackKey: string) {
    const message = createOrderedMessage(5);
    return (await store.readOrderingTrack({ trackKey, message: message.id, nowMs: Date.now() })).observations;
}

async function readRelease(
    store: ALInboundAdmissionStore,
    trackKey: string,
    seq: number
): Promise<ALInboundBufferedReleaseReadDto | undefined> {
    return await store.readBufferedRelease({ trackKey, seq, nowMs: Date.now() });
}

function toCompletion(pair: SeededTrackPair, read: ALInboundBufferedReleaseReadDto): ALInboundDeliveryCompletion {
    return {
        trackKey: pair.trackKey,
        seq: pair.shortSeq,
        observedSlot: read.snapshot,
        observedProgress: read.observations.deliveryProgress!.value!
    };
}
