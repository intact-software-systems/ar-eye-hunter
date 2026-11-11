import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';

import { createCountingSubtleCrypto, type CountingSubtleCrypto } from '../../signature/counting-subtle-crypto-fixtures.ts';
import type { AvailablePublicationCrypto } from '../../signature/publication-crypto-fixtures.ts';
import {
    createOriginReceiverMulticast,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    toOriginDirectedSnapshot,
    toOriginFrozenTargets,
    type RtcOriginOverlayFixture
} from '../rtc-origin-overlay-fixture.ts';
import { createChainHop, createRelayChain, deliverEach, type RelayChain } from '../rtc-relay-chain-test-support.ts';
import { createRtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';

interface CountedOrigin {
    readonly origin: RtcOriginOverlayFixture;
    readonly counting: CountingSubtleCrypto;
}

// The origin's replayed admission of a retained control spends a digest and no verify; `a retained control's replay
// verifies again from the cache` in rtc-receipt-forgery.test.ts pins it.
describe('the receipt signatures a receipted RTC send costs (S8-R10)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('a direct receiver room of two signs two receipts, and the origin verifies two', async () => {
        const chain = await createRelayChain(['a', 'b', 'c'], {});
        const { origin, counting } = createCountedOrigin(chain, ['b', 'c']);
        const recipients = createCountingSubtleCrypto();
        const b = createChainHop(chain, { selfPeerId: 'b', neighbourPeerIds: ['a'], publicationCrypto: toCounted(chain, 'b', recipients) });
        const c = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'], publicationCrypto: toCounted(chain, 'c', recipients) });
        const message = createOriginReceiverMulticast('count-direct');
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');

        await b.receive(origin.channels.b!.sent[0]!, 'a');
        await c.receive(origin.channels.c!.sent[0]!, 'a');
        await acceptEach(origin, [...await b.readSent('a'), ...await c.readSent('a')]);

        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            confirmedRecipientPeerIds: ['b', 'c'],
            complete: true
        });
        expect({ sign: recipients.counts.sign, verify: recipients.counts.verify }).toEqual({ sign: 2, verify: 0 });
        expect({ sign: counting.counts.sign, verify: counting.counts.verify }).toEqual({ sign: 0, verify: 2 });
    });

    it('a chain whose relay is also counted signs three receipts, the relay verifies none, and the origin verifies three', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], {});
        const { origin, counting } = createCountedOrigin(chain, ['r']);
        const relayCounting = createCountingSubtleCrypto();
        const leafCounting = createCountingSubtleCrypto();
        const r = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'], publicationCrypto: toCounted(chain, 'r', relayCounting) });
        const c = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'], publicationCrypto: toCounted(chain, 'c', leafCounting) });
        const message = { ...createOriginReceiverMulticast('count-chain'), targets: toOriginFrozenTargets(['r', 'c'], 3) };
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');

        await r.receive(origin.channels.r!.sent[0]!, 'a');
        await c.receive((await r.readSent('c'))[0]!, 'r');
        await deliverEach(await c.readSent('r'), r, 'c');
        await acceptEach(origin, await r.readSent('a'));

        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            confirmedRecipientPeerIds: ['r', 'c'],
            complete: true
        });
        // `r` signs its own `accepted` and its terminal ACK; it forwards `c`'s ACK with `c`'s proof and verifies nothing.
        expect({ sign: relayCounting.counts.sign, verify: relayCounting.counts.verify }).toEqual({ sign: 2, verify: 0 });
        expect({ sign: leafCounting.counts.sign, verify: leafCounting.counts.verify }).toEqual({ sign: 1, verify: 0 });
        expect({ sign: counting.counts.sign, verify: counting.counts.verify }).toEqual({ sign: 0, verify: 3 });
    });

    it('a leader send to a leaf director signs one receipt, and the origin verifies one', async () => {
        const chain = await createRelayChain(['a', 'b', 'd'], {});
        const directed = toOriginDirectedSnapshot(chain.snapshot, 'd', Date.now());
        const counting = createCountingSubtleCrypto();
        const origin = createRtcOriginOverlayFixture({
            snapshot: directed,
            nextHopPeerIds: ['b', 'd'],
            nextHopsBySessionId: { a: ['b', 'd'], b: ['a'], d: ['a'] },
            publicationCrypto: toCounted(chain, 'a', counting)
        });
        const directorCounting = createCountingSubtleCrypto();
        const d = createRtcRelayOverlayFixture({
            selfPeerId: 'd',
            snapshot: directed,
            neighbourPeerIds: ['a'],
            publicationCrypto: toCounted(chain, 'd', directorCounting)
        });
        const message = newALMulticastMessage(
            'a',
            { topicId: 'chat', resourceId: 'count-leader', contextId: 'room' },
            ORIGIN_ROOM,
            'chat.message.v1',
            {},
            { ack: 'group-leader', reliability: 'at-least-once', ttlMs: 30_000 }
        );
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');

        await d.receive(origin.channels.d!.sent[0]!, 'a');
        await acceptEach(origin, await d.readSent('a'));

        expect(origin.channels.b!.sent).toEqual([]);
        expect(await origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId })).toBeUndefined();
        expect({ sign: directorCounting.counts.sign, verify: directorCounting.counts.verify }).toEqual({ sign: 1, verify: 0 });
        expect({ sign: counting.counts.sign, verify: counting.counts.verify }).toEqual({ sign: 0, verify: 1 });
    });
});

/** The signing origin `a` over `nextHopPeerIds`, its WebCrypto counted. */
function createCountedOrigin(chain: RelayChain, nextHopPeerIds: readonly string[]): CountedOrigin {
    const counting = createCountingSubtleCrypto();
    const origin = createRtcOriginOverlayFixture({
        snapshot: chain.snapshot,
        nextHopPeerIds,
        publicationCrypto: toCounted(chain, 'a', counting)
    });
    return { origin, counting };
}

/** The session's own key over the counted WebCrypto. */
function toCounted(chain: RelayChain, sessionId: string, counting: CountingSubtleCrypto): AvailablePublicationCrypto {
    return { ...chain.keys[sessionId]!, subtle: counting.subtle };
}

/** Hands every message a hop sent the origin to its control admission, in order. */
async function acceptEach(origin: RtcOriginOverlayFixture, messages: readonly ALMessage[]): Promise<void> {
    for (const message of messages) {
        await origin.manager.acceptControlMessage(message);
    }
}
