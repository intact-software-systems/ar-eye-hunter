import { describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALPublicationProofSigningInput } from '@shared/al-contracts/publication-proof/al-publication-proof.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

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
import { createRelayChain, drainUntil, type RelayChain } from '../rtc-relay-chain-test-support.ts';
import { createRtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';

/** The receipt window of an `at-least-once` send, after which its origin retries what is unconfirmed. */
const ACK_TIMEOUT_MS = 2_000;

type HeldReceipt = 'receiver' | 'leader' | 'none';

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

    it('answers a replay that meets the freezing dequeue while it signs with the one stored row and its one proof', async () => {
        const chain = await createRelayChain(['a', 'c'], {});
        const counting = createCountingSubtleCrypto();
        const origin = createHeldOrigin(chain.snapshot, toCounted(chain, counting));
        const message = createHeldSend('held-replayed', 'receiver');
        const held = await origin.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(200);
        const releaseFreezingSign = counting.holdNextSign();
        origin.groups.accept('room', chain.snapshot);
        for (let step = 0; step < 20 && counting.counts.sign === 0; step++) {
            await vi.advanceTimersByTimeAsync(100);
            await drainUntil(() => counting.counts.sign > 0, 20);
        }

        const replaying = origin.manager.enqueueLegIfAbsent(message, 'hold');
        releaseFreezingSign();
        const replayed = await replaying;
        await drainUntil(() => origin.channels.c!.sent.length > 0);
        await vi.advanceTimersByTimeAsync(200);
        const canonical = await readCanonical(origin, held);

        // The replay waits behind the freezing dequeue in the sender's commit queue, so it signs nothing of its own.
        expect(counting.counts.sign).toBe(1);
        expect(replayed.verdict.kind).toBe('duplicate');
        expect(replayed.message.proof).toEqual(canonical.proof);
        expect(new Set(origin.channels.c!.sent.map((copy) => copy.proof?.signature))).toEqual(new Set([canonical.proof!.signature]));
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

/** The origin `a` over `c`, its room snapshot not yet cached. */
function createHeldOrigin(snapshot: GroupSnapshot, publicationCrypto: PublicationCrypto): RtcOriginOverlayFixture {
    const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['c'], publicationCrypto });
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
