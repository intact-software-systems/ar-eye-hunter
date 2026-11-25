import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALPublicationProofSigningInput } from '@shared/al-contracts/publication-proof/al-publication-proof.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundReadMessageEndBundle } from '@shared/alm/outbound/message-end/to-al-outbound-message-end-bundle.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

import { advanceUntil, drainUntil } from '../../advance-until.ts';
import { createIndexedDbOriginStores } from '../../alm/create-indexed-db-origin-stores.ts';
import { loseOutboundCommitAttempts } from '../../alm/outbound-runtime-test-fixture.ts';
import { createCountingSubtleCrypto, type CountingSubtleCrypto } from '../../signature/counting-subtle-crypto-fixtures.ts';
import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO
} from '../../signature/publication-crypto-fixtures.ts';
import {
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    toOriginDirectedSnapshot,
    useFakeClock,
    type RtcOriginOverlayFixture
} from '../rtc-origin-overlay-fixture.ts';
import { createRelayChain, type RelayChain } from '../rtc-relay-chain-test-support.ts';
import { createRtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';

/** The receipt window of an `at-least-once` send, after which its origin retries what is unconfirmed. */
const ACK_TIMEOUT_MS = 2_000;
/** A commit that loses its fence reads, decides and writes again, this many attempts in all. */
const COMMIT_ATTEMPTS = 3;

type HeldReceipt = 'receiver' | 'leader' | 'none';
type HeldStore = 'memory' | 'indexeddb';

/**
 * D585 and D756: a durable room send admitted before its origin caches the room snapshot is held, as before, and the
 * dequeue that first reads the snapshot freezes its audience; a receipted one is signed there, once, so the stored
 * canonical row every retry resends already carries the proof.
 */
describe('a receipted RTC room send held without its room snapshot (D585, D756)', () => {
    useFakeClock();

    it.each(['receiver', 'leader'] as const)(
        'is held unsigned, signed once by the dequeue that freezes it, and its retry resends the stored proof (%s)',
        async (receipt) => {
            const chain = await createRelayChain(['a', 'c'], {});
            const snapshot = toRoomSnapshot(chain, receipt);
            const counting = createCountingSubtleCrypto();
            const origin = createHeldOrigin(snapshot, toCounted(chain, counting));
            const c = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['a'], publicationCrypto: chain.keys.c });
            const message = createHeldSend(`held-${receipt}`, receipt);

            const held = await holdAndAcceptSnapshot(origin, message, snapshot);
            const signsAtFreeze = counting.counts.sign;
            const [frozen] = origin.channels.c!.sent;
            const canonical = await readCanonical(origin, held);
            await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 100);
            await drainUntil(() => origin.channels.c!.sent.length > 1);
            const retried = origin.channels.c!.sent[1]!;
            await c.receive(structuredClone(retried), 'a');
            for (const control of await c.readSent('a')) {
                await origin.manager.acceptControlMessage(control);
            }

            expect(held.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 0 });
            expect(frozen!.targets).toMatchObject({ mode: 'multicast', recipientPeerIds: ['c'] });
            expect(frozen!.proof).toMatchObject({ alg: 'ES256', keyId: chain.keys.a!.keyPair.keyId });
            expect(canonical.proof).toEqual(frozen!.proof);
            expect(toALPublicationProofSigningInput(canonical)).toBe(toALPublicationProofSigningInput(frozen!));
            expect(retried.proof).toEqual(frozen!.proof);
            expect([signsAtFreeze, counting.counts.sign]).toEqual([1, 1]);
            expect(c.delivered.map((delivered) => delivered.id.msgId)).toEqual([message.id.msgId]);
            expect(await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
                .toBeUndefined();
        }
    );

    it.each<[string, (chain: RelayChain) => Promise<PublicationCrypto>]>([
        ['a page without WebCrypto', async () => UNAVAILABLE_PUBLICATION_CRYPTO],
        ['a page whose key the arriving snapshot does not name', async () => await createAvailablePublicationCryptoFixture()]
    ])('settles a held receiver send rejected unsupported at its freezing dequeue on %s, sending nothing', async (_name, toCrypto) => {
        const chain = await createRelayChain(['a', 'c'], {});
        const origin = createHeldOrigin(chain.snapshot, await toCrypto(chain));
        const message = createHeldSend('held-unsignable', 'receiver');

        const held = await holdAndAcceptSnapshot(origin, message, chain.snapshot);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(held.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 0 });
        expect(origin.channels.c!.sent).toEqual([]);
        expect(origin.settlements.filter((settlement) => settlement.kind === 'admission').map(({ verdict }) => verdict)).toEqual([
            expect.objectContaining({ kind: 'refused', reason: 'unsupported' })
        ]);
        expect(await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
    });

    it.each<HeldStore>(['memory', 'indexeddb'])(
        'answers a replay that settles while the freezing dequeue still signs with the proof the replay stored, which the dequeue then sends (%s)',
        async (store) => {
            const chain = await createRelayChain(['a', 'c'], {});
            const counting = createCountingSubtleCrypto();
            const origin = createHeldOrigin(chain.snapshot, toCounted(chain, counting), store);
            const message = createHeldSend('held-replay-first', 'receiver');
            const { held, releaseFreezingSign } = await holdUntilFreezingSign(origin, message, counting, chain.snapshot);

            const replayed = await origin.manager.enqueueLegIfAbsent(message, 'hold');
            const storedAtAnswer = await readCanonical(origin, held);
            releaseFreezingSign();
            await advanceUntil(() => origin.channels.c!.sent.length > 0, 100, 50);

            // Nothing orders the two (ruling 22). The dequeue's write lost the fence; each of its attempts may sign once
            // before it reads the stored proof.
            expect(replayed.verdict.kind).toBe('duplicate');
            expect(replayed.message.proof).toMatchObject({ alg: 'ES256', keyId: chain.keys.a!.keyPair.keyId });
            expect(storedAtAnswer.proof).toEqual(replayed.message.proof);
            expect((await readCanonical(origin, held)).proof).toEqual(replayed.message.proof);
            expect(origin.channels.c!.sent.map((copy) => copy.proof)).toEqual([replayed.message.proof]);
            expect(counting.counts.sign).toBeLessThanOrEqual(1 + COMMIT_ATTEMPTS);
        }
    );

    it('answers a replay whose own sign lost to the freezing dequeue with the proof the dequeue stored', async () => {
        const chain = await createRelayChain(['a', 'c'], {});
        const counting = createCountingSubtleCrypto();
        const origin = createHeldOrigin(chain.snapshot, toCounted(chain, counting));
        const message = createHeldSend('held-dequeue-first', 'receiver');
        const { held, releaseFreezingSign } = await holdUntilFreezingSign(origin, message, counting, chain.snapshot);
        const releaseReplaySign = counting.holdNextSign();

        const replaying = origin.manager.enqueueLegIfAbsent(message, 'hold');
        await drainUntil(() => counting.counts.sign === 2);
        releaseFreezingSign();
        await advanceUntil(() => origin.channels.c!.sent.length > 0, 100, 50);
        releaseReplaySign();
        const replayed = await replaying;
        const canonical = await readCanonical(origin, held);

        expect(replayed.verdict.kind).toBe('duplicate');
        expect(canonical.proof).toMatchObject({ alg: 'ES256', keyId: chain.keys.a!.keyPair.keyId });
        expect(replayed.message.proof).toEqual(canonical.proof);
        expect(origin.channels.c!.sent.map((copy) => copy.proof)).toEqual([canonical.proof]);
        expect(counting.counts.sign).toBe(2);
    });

    it('answers a replay whose every write lost the fence to other sends with the row as stored, retaining no second admission', async () => {
        const chain = await createRelayChain(['a', 'c'], {});
        const counting = createCountingSubtleCrypto();
        const origin = createHeldOrigin(chain.snapshot, toCounted(chain, counting));
        const message = createHeldSend('held-replay-outpaced', 'receiver');
        const { held, releaseFreezingSign } = await holdUntilFreezingSign(origin, message, counting, chain.snapshot);
        const readLostCommits = loseOutboundCommitAttempts(origin.resources.admissionStore);

        const answers: ALOutboundEnqueueResult[] = [];
        void origin.manager.enqueueLegIfAbsent(message, 'hold').then((answer) => answers.push(answer));
        // The last attempt of a commit that keeps losing waits out its backoff on the fake clock.
        await advanceUntil(() => answers.length > 0, 10, 50);
        releaseFreezingSign();
        await advanceUntil(() => origin.channels.c!.sent.length > 0, 100, 50);
        const canonical = await readCanonical(origin, held);

        expect(readLostCommits()).toBe(COMMIT_ATTEMPTS);
        expect(answers.map((answer) => [answer.verdict.kind, answer.message.proof])).toEqual([['duplicate', undefined]]);
        expect(canonical.proof).toMatchObject({ alg: 'ES256', keyId: chain.keys.a!.keyPair.keyId });
        expect(origin.channels.c!.sent.map((copy) => copy.proof)).toEqual([canonical.proof]);
    });

    it('leaves a held send whose terminal settlement was committed ended when a replay then reads its room snapshot', async () => {
        const chain = await createRelayChain(['a', 'c'], {});
        const origin = createHeldOrigin(chain.snapshot, chain.keys.a!);
        const message = createHeldSend('held-ended', 'receiver');
        const held = await origin.manager.enqueueLegIfAbsent(message, 'hold');
        const store = origin.resources.admissionStore;
        const read = await store.readRepairMessage(message.id.msgId, (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'durable',
            preparedMessages: []
        }));
        expect(await store.commitBundle(toALOutboundReadMessageEndBundle(message, read))).toBe('committed');
        origin.groups.accept('room', chain.snapshot);

        const replayed = await origin.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(5_000);

        expect(replayed.verdict.kind).toBe('duplicate');
        expect((await store.readStoredMessage(message.id.msgId))?.ended).toBe(true);
        expect((await readCanonical(origin, held)).proof).toBeUndefined();
        expect(origin.channels.c!.sent).toEqual([]);
    });

    it('freezes a held send that asks no receipt at its dequeue and sends it unsigned, signing nothing', async () => {
        const chain = await createRelayChain(['a', 'c'], {});
        const counting = createCountingSubtleCrypto();
        const origin = createHeldOrigin(chain.snapshot, toCounted(chain, counting));
        const message = createHeldSend('held-unreceipted', 'none');

        const held = await holdAndAcceptSnapshot(origin, message, chain.snapshot);
        const [frozen] = origin.channels.c!.sent;

        expect(held.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 0 });
        expect(frozen!.targets).toMatchObject({ mode: 'multicast', recipientPeerIds: ['c'] });
        expect([frozen!.proof, (await readCanonical(origin, held)).proof, counting.counts.sign]).toEqual([undefined, undefined, 0]);
    });
});

/** The origin `a` over `c`, its room snapshot not yet cached, admitting to the named store pair. */
function createHeldOrigin(
    snapshot: GroupSnapshot,
    publicationCrypto: PublicationCrypto,
    store: HeldStore = 'memory'
): RtcOriginOverlayFixture {
    if (store === 'indexeddb') {
        // fake-indexeddb schedules on setImmediate, which stays real so its requests settle.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    }
    const origin = createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: ['c'],
        publicationCrypto,
        stores: store === 'indexeddb'
            ? createIndexedDbOriginStores(createCountingIndexedDbOperationObserver(), 'rtc-held-send')
            : undefined
    });
    origin.groups.delete('room');
    return origin;
}

/** Admits `message` while the room is uncached, then caches `snapshot` and drains the dequeue that freezes it. */
async function holdAndAcceptSnapshot(
    origin: RtcOriginOverlayFixture,
    message: ALMessage,
    snapshot: GroupSnapshot
): Promise<ALOutboundEnqueueResult> {
    const held = await origin.manager.enqueueLegIfAbsent(message, 'hold');
    await vi.advanceTimersByTimeAsync(200);
    origin.groups.accept('room', snapshot);
    // The held row's next dequeue is due after its not-ready delay; its freezing read then signs with real WebCrypto.
    for (let step = 0; step < 20 && !isFrozenOrEnded(origin); step++) {
        await vi.advanceTimersByTimeAsync(100);
        await drainUntil(() => isFrozenOrEnded(origin), 20);
    }
    return held;
}

/** Admits `message` while the room is uncached, caches `snapshot`, and stops the freezing dequeue inside its sign. */
async function holdUntilFreezingSign(
    origin: RtcOriginOverlayFixture,
    message: ALMessage,
    counting: CountingSubtleCrypto,
    snapshot: GroupSnapshot
): Promise<Readonly<{ held: ALOutboundEnqueueResult; releaseFreezingSign: () => void; }>> {
    const held = await origin.manager.enqueueLegIfAbsent(message, 'hold');
    await vi.advanceTimersByTimeAsync(200);
    const releaseFreezingSign = counting.holdNextSign();
    origin.groups.accept('room', snapshot);
    await advanceUntil(() => counting.counts.sign > 0);
    return { held, releaseFreezingSign };
}

function isFrozenOrEnded(origin: RtcOriginOverlayFixture): boolean {
    return origin.channels.c!.sent.length > 0 || origin.settlements.some((settlement) => settlement.kind === 'admission');
}

/** The room of `a` and `c`; under a leader receipt, `c` is its director. */
function toRoomSnapshot(chain: RelayChain, receipt: HeldReceipt): GroupSnapshot {
    return receipt === 'leader' ? toOriginDirectedSnapshot(chain.snapshot, 'c', Date.now()) : chain.snapshot;
}

function toCounted(chain: RelayChain, counting: CountingSubtleCrypto): PublicationCrypto {
    return { ...chain.keys.a!, subtle: counting.subtle };
}

function createHeldSend(resourceId: string, receipt: HeldReceipt): ALMessage {
    return newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: { topicId: 'chat', resourceId, contextId: 'room' },
        groupRef: ORIGIN_ROOM,
        typeId: 'chat.message.v1',
        resource: { text: resourceId },
        options: {
            ack: receipt === 'receiver' ? 'receiver' : receipt === 'leader' ? 'group-leader' : 'none',
            reliability: 'at-least-once',
            ttlMs: 30_000,
            traceId: `trace-${resourceId}`,
            qos: { durability: { algo: 'local-outbox' } }
        }
    });
}

/** The canonical row the origin's outbox holds for `held`. */
async function readCanonical(origin: RtcOriginOverlayFixture, held: ALOutboundEnqueueResult): Promise<ALMessage> {
    return JSON.parse((await origin.resources.workQueue.getItem(held.entries[0]!.key))!.resource) as ALMessage;
}
