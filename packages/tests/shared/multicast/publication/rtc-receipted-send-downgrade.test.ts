import { describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';

import {
    createOriginReceiverMulticast,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    toOriginFrozenTargets,
    useFakeClock,
    type RtcOriginOverlayFixture
} from '../rtc-origin-overlay-fixture.ts';
import { createChainHop, createRelayChain, toControlTuples, type RelayChain } from '../rtc-relay-chain-test-support.ts';
import type { RtcRelayOverlayFixture } from '../rtc-relay-overlay-fixture.ts';

const FORGED_RESOURCE = JSON.stringify({ text: 'forged by b' });

/** The receipt window of an `at-least-once` send, after which its origin retries what is unconfirmed. */
const ACK_TIMEOUT_MS = 2_000;

/** The origin `a`, the forger `b` and the recipient `c`, each with its own registered key. */
interface DowngradeRoom {
    readonly chain: RelayChain;
    readonly origin: RtcOriginOverlayFixture;
    readonly recipient: RtcRelayOverlayFixture;
}

/**
 * Ruling 1 (D756): an origin-authenticated copy that asks a `receiver` or `leader` receipt is never a duplicate of an
 * admission that was not origin-authenticated. A forger's unsigned copy that asks no receipt can no longer turn the
 * origin's signed copy into a confirmed duplicate: the origin's copy is admitted as new, and answered for what the
 * recipient's application actually got.
 */
describe('a forged unreceipted copy before the origin\'s receipted one (ruling 1)', () => {
    useFakeClock();

    it('answers no delivered for the origin\'s ordered copy whose sequence the forged copy already released', async () => {
        const room = await createDowngradeRoom();
        const originCopy = await sendFromOrigin(room, 'ordered', {}, { orderingKey: 'chat', seq: 1 });

        await room.recipient.receive(toDowngradedCopy(originCopy), 'b');
        await room.recipient.receive(originCopy, 'a');
        await acceptEach(room.origin, await room.recipient.readSent('a'));

        for (let retry = 1; retry <= 3; retry++) {
            await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 2 ** retry);
            for (const copy of room.origin.channels.c!.sent.slice(1)) {
                await room.recipient.receive(structuredClone(copy), 'a');
            }
        }
        await vi.advanceTimersByTimeAsync(30_000);

        // The ordering layer released that sequence for the forged copy: the origin's copy is dropped unanswered, so
        // its receipt runs out with the recipient unconfirmed.
        expect(readDeliveredResources(room.recipient)).toEqual([FORGED_RESOURCE]);
        expect(await room.recipient.readSentControls('a')).toEqual([]);
        expect(readConfirmed(room.origin, originCopy)).toBe(false);
        expect(room.origin.settlements.filter((settlement) => settlement.kind === 'receipt-exhausted')).toMatchObject([
            { msgId: originCopy.id.msgId, confirmedPeerIds: [], unconfirmedPeerIds: expect.arrayContaining(['c']) }
        ]);
    });

    it('answers no delivered for the origin\'s superseding copy whose key the forged copy already holds', async () => {
        const room = await createDowngradeRoom();
        const originCopy = await sendFromOrigin(room, 'superseding', {
            supersedence: { algo: 'latest-wins', opts: { supersedenceKey: 'board' } }
        });

        await room.recipient.receive(toDowngradedCopy(originCopy), 'b');
        await room.recipient.receive(originCopy, 'a');
        await acceptEach(room.origin, await room.recipient.readSent('a'));

        const delivered = readDeliveredResources(room.recipient);
        const confirmed = readConfirmed(room.origin, originCopy);
        // Confirmed only when the origin's content reached the application.
        // The forged copy names the key's latest message by the same id, so the origin's copy is current and delivered.
        expect(confirmed).toBe(delivered.includes(originCopy.payload.resource));
        expect(delivered).toEqual([FORGED_RESOURCE, originCopy.payload.resource]);
        expect(delivered[0]).toBe(FORGED_RESOURCE);
    });

    it('keeps a forged unreceipted copy that arrives after the origin\'s copy a duplicate: neither delivered nor answered', async () => {
        const room = await createDowngradeRoom();
        const originCopy = await sendFromOrigin(room, 'reverse', {});

        await room.recipient.receive(originCopy, 'a');
        await room.recipient.receive(toDowngradedCopy(originCopy), 'b');

        expect(readDeliveredResources(room.recipient)).toEqual([originCopy.payload.resource]);
        expect(toControlTuples(await room.recipient.readSentControls('b'))).toEqual([]);
        expect(toControlTuples(await room.recipient.readSentControls('a'))).toEqual([['ack', 'c', 'delivered']]);
    });

    it.each(['hop', 'subtree'] as const)('never upgrades a %s receipted copy: it stays a duplicate of the forged admission', async (algo) => {
        const room = await createDowngradeRoom();
        const originCopy = await sendFromOrigin(room, `never-${algo}`, { ack: { algo } });
        expect(originCopy.proof).toBeUndefined();

        await room.recipient.receive(toDowngradedCopy(originCopy), 'b');
        await room.recipient.receive(originCopy, 'a');

        expect(readDeliveredResources(room.recipient)).toEqual([FORGED_RESOURCE]);
    });
});

describe('a relay that admitted a forged unreceipted copy (ruling 1)', () => {
    useFakeClock();

    // Limit: a stored canonical row is an immutable fact, so the relay never replaces the forged copy it forwarded with
    // other content under the same id. It readmits the origin's copy for itself only: it delivers it, answers for
    // itself, and forwards nothing more. Its leaf keeps only the forged content and is never confirmed over RTC; under
    // `rtc-with-ws-fallback` the exhausted receipt hands the send to WS, whose copy the leaf readmits, authenticated by
    // the server, and confirms (`al-inbound-origin-authenticated-readmission.test.ts`, the WS copy over a forged RTC
    // copy).
    it('readmits the origin\'s signed copy for itself only: its leaf holds the forged content alone and is not confirmed', async () => {
        const chain = await createRelayChain(['a', 'b', 'r', 'c'], {});
        const origin = createRtcOriginOverlayFixture({
            snapshot: chain.snapshot,
            nextHopPeerIds: ['r'],
            publicationCrypto: chain.keys.a
        });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'b', 'c'] });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'] });
        const message = { ...createOriginReceiverMulticast('relayed-downgrade'), targets: toOriginFrozenTargets(['r', 'c'], 3) };
        expect((await enqueueAndDrain(origin.manager, message)).verdict.kind).toBe('admitted');
        const originCopy = origin.channels.r!.sent[0]!;

        await relay.receive(toDowngradedCopy(originCopy), 'b');
        await relay.receive(originCopy, 'a');
        for (const forwarded of await relay.readSent('c')) {
            await leaf.receive(forwarded, 'r');
        }
        for (const control of await leaf.readSent('r')) {
            await relay.receive(control, 'c');
        }
        await acceptEach(origin, await relay.readSent('a'));

        expect(readDeliveredResources(relay)).toEqual([FORGED_RESOURCE, originCopy.payload.resource]);
        expect((await relay.readSent('c')).map((copy) => copy.payload.resource)).toEqual([FORGED_RESOURCE]);
        expect(readDeliveredResources(leaf)).toEqual([FORGED_RESOURCE]);
        expect(toControlTuples(await leaf.readSentControls('r'))).toEqual([]);
        expect(toControlTuples(await relay.readSentControls('a'))).toEqual([['ack', 'r', 'delivered']]);
        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            confirmedRecipientPeerIds: ['r'],
            complete: false
        });
    });
});

async function createDowngradeRoom(): Promise<DowngradeRoom> {
    const chain = await createRelayChain(['a', 'b', 'c'], {});
    const origin = createRtcOriginOverlayFixture({ snapshot: chain.snapshot, nextHopPeerIds: ['b', 'c'], publicationCrypto: chain.keys.a });
    const recipient = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a', 'b'] });
    return { chain, origin, recipient };
}

/** The origin's copy to `c` of a `receiver` room multicast frozen to `b` and `c`, with `qos` and `ordering` as given. */
async function sendFromOrigin(
    room: DowngradeRoom,
    resourceId: string,
    qos: ALQosPolicyRequest,
    ordering?: ALMessage['ordering']
): Promise<ALMessage> {
    const base = createOriginReceiverMulticast(resourceId);
    const message: ALMessage = {
        ...base,
        targets: toOriginFrozenTargets(['b', 'c'], 3),
        qos: { ...base.qos, ...qos },
        ...(ordering === undefined ? {} : { ordering })
    };
    expect((await enqueueAndDrain(room.origin.manager, message)).verdict.kind).toBe('admitted');
    return room.origin.channels.c!.sent[0]!;
}

/** The forger's copy: the origin's id, sender, audience and ordering, its own content, asking no receipt and unsigned. */
function toDowngradedCopy(originCopy: ALMessage): ALMessage {
    return {
        ...originCopy,
        payload: { ...originCopy.payload, resource: FORGED_RESOURCE },
        delivery: { reliability: 'best-effort', ack: 'none' },
        qos: { ...originCopy.qos, ack: undefined },
        proof: undefined
    };
}

async function acceptEach(origin: RtcOriginOverlayFixture, controls: readonly ALMessage[]): Promise<void> {
    for (const control of controls) {
        await origin.manager.acceptControlMessage(control);
    }
}

function readConfirmed(origin: RtcOriginOverlayFixture, message: ALMessage): boolean {
    return origin.settlements.some((settlement) =>
        settlement.kind === 'acknowledgement' && settlement.msgId === message.id.msgId &&
        settlement.confirmedRecipientPeerIds.includes('c')
    );
}

/** Each payload the session's application received, as the JSON string its envelope carries. */
function readDeliveredResources(fixture: RtcRelayOverlayFixture): readonly string[] {
    return fixture.delivered.map((message) => message.payload.resource);
}
