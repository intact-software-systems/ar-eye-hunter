import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RallarTopicSubscription } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { BrowserTopicSubscriptions } from '@shared-web/browser/messages/topic-subscription/browser-topic-subscriptions.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage, newALNackControlMessage, type ALPeerControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundSettlementFact } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { RtcTopicSubscriptionReader } from '@shared/multicast/publication/rtc-topic-subscription-reader.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import { createDefaultOutboundTestRuntime, enqueueOutboundOrThrow } from '../alm/outbound-runtime-test-fixture.ts';
import { createRtcGrantedTopicsFixture } from './rtc-granted-topic-reader-fixtures.ts';
import { createRtcOriginOverlayFixture, ORIGIN_ROOM } from './rtc-origin-overlay-fixture.ts';
import {
    createFrozenGrantedMulticast,
    PUBLICATION_TOPIC_ID,
    PUBLISH_AND_SUBSCRIBE,
    PUBLISH_ONLY,
    signPublication,
    SUBSCRIBE_ONLY
} from './rtc-publication-proof-fixtures.ts';
import {
    createChainHop,
    createRelayChain,
    deliverEach,
    readOrderingPositions,
    signOrderedReceiptedPublication,
    signTrack,
    toControlTuples,
    type RelayChain
} from './rtc-relay-chain-test-support.ts';
import { createRtcTopicSubscriptionsFixture } from './rtc-topic-subscription-reader-fixtures.ts';

import { toTestALNackPayload, verifyTestALReceiptControl } from '../../al-control-test-payloads.ts';

interface ReceiptedPublicationInput {
    readonly resourceId: string;
    /** The audience the origin froze the frame to, which the proof signs. */
    readonly recipientPeerIds: readonly string[];
    readonly nextHopPeerId: string;
}

/** The origin's receipt for a frame, fed the controls its next hop sent it. */
interface OriginReceipt {
    accept(controls: readonly ALMessage[]): Promise<void>;
    readonly facts: readonly ALOutboundSettlementFact[];
}

const ACTIVE_TOKEN = createRtcTopicSubscriptionsFixture([PUBLICATION_TOPIC_ID]);

describe('a receipted granted publication at a frozen recipient that is not subscribed', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('forwards a leaf\'s not-subscribed answer through the relay naming the leaf, ends the leaf\'s hop there, and the origin records it outside', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, r: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'], topicSubscriptions: ACTIVE_TOKEN });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'] });
        const signed = await signReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['r', 'c'], nextHopPeerId: 'r' });
        const origin = await createOriginReceipt(signed, { expectedPeerIds: ['r', 'c'], nextHopPeerIds: ['r'] });

        await relay.receive(signed, 'a');
        await leaf.receive((await relay.readSent('c'))[0]!, 'r');
        await deliverEach(await leaf.readSent('r'), relay, 'c');
        await origin.accept(await relay.readSent('a'));

        expect(leaf.delivered).toEqual([]);
        expect(toControlTuples(await leaf.readSentControls('r')).toSorted()).toEqual([
            ['ack', 'c', 'subtree-complete-not-subscribed'],
            ['nack', 'c', 'not-subscribed']
        ]);
        // The leaf's hop-end arrives first and is forwarded as the leaf signed it; the NACK after it moves nothing.
        expect(toControlTuples(await relay.readSentControls('a')).toSorted()).toEqual([
            ['ack', 'c', 'subtree-complete-not-subscribed'],
            ['ack', 'r', 'accepted'],
            ['ack', 'r', 'subtree-complete']
        ]);
        const hopEnd = (await relay.readSent('a')).find((sent) => {
            const control = decodeALControlMessage(sent).right;
            return control?.type === 'ack' && control.payload.logicalRecipientPeerId === 'c';
        })!;
        expect([await verifyTestALReceiptControl(chain.keys.c!, hopEnd), await verifyTestALReceiptControl(chain.keys.r!, hopEnd)])
            .toEqual([true, false]);
        expect(toReceiptStatement(origin.facts)).toEqual({ confirmed: ['r'], outside: ['c'], complete: true });
    });

    it.each<[string, (controls: readonly ALMessage[]) => readonly ALMessage[], readonly string[]]>([
        [
            'its NACK lost on the way',
            (controls) => controls.filter((control) => decodeALControlMessage(control).right?.type === 'ack'),
            ['ack', 'c', 'subtree-complete-not-subscribed']
        ],
        ['its NACK first', (controls) => toSortedByControlType(controls, ['nack', 'ack']), ['nack', 'c', 'not-subscribed']],
        [
            'its hop-completion ACK first',
            (controls) => toSortedByControlType(controls, ['ack', 'nack']),
            ['ack', 'c', 'subtree-complete-not-subscribed']
        ]
    ])('records a not-subscribed leaf outside at the origin once, with %s', async (_shape, toArrivals, forwarded) => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, r: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'], topicSubscriptions: ACTIVE_TOKEN });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'] });
        const signed = await signReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['r', 'c'], nextHopPeerId: 'r' });
        const origin = await createOriginReceipt(signed, { expectedPeerIds: ['r', 'c'], nextHopPeerIds: ['r'] });

        await relay.receive(signed, 'a');
        await leaf.receive((await relay.readSent('c'))[0]!, 'r');
        await deliverEach(toArrivals(await leaf.readSent('r')), relay, 'c');
        await origin.accept(await relay.readSent('a'));

        // The relay forwards whichever of the leaf's two answers arrives first, and nothing for the other.
        expect(toControlTuples(await relay.readSentControls('a')).toSorted()).toEqual([
            ['ack', 'r', 'accepted'],
            ['ack', 'r', 'subtree-complete'],
            forwarded
        ].toSorted());
        expect(toReceiptStatement(origin.facts)).toEqual({ confirmed: ['r'], outside: ['c'], complete: true });
    });

    it('reaches a recipient below a nested not-subscribed relay by retry: that relay\'s hop stays open until its subtree answers', async () => {
        const chain = await createRelayChain(['a', 'p', 'q', 'l'], {
            a: PUBLISH_AND_SUBSCRIBE,
            p: SUBSCRIBE_ONLY,
            q: SUBSCRIBE_ONLY,
            l: SUBSCRIBE_ONLY
        });
        const p = createChainHop(chain, { selfPeerId: 'p', neighbourPeerIds: ['a', 'q'], topicSubscriptions: ACTIVE_TOKEN });
        const q = createChainHop(chain, { selfPeerId: 'q', neighbourPeerIds: ['p', 'l'] });
        const l = createChainHop(chain, { selfPeerId: 'l', neighbourPeerIds: ['q'], topicSubscriptions: ACTIVE_TOKEN });
        const signed = await signReceiptedPublication(chain, {
            resourceId: 'feed-1',
            recipientPeerIds: ['p', 'q', 'l'],
            nextHopPeerId: 'p'
        });
        const origin = await createOriginReceipt(signed, { expectedPeerIds: ['p', 'q', 'l'], nextHopPeerIds: ['p'] });

        await p.receive(signed, 'a');
        await q.receive((await p.readSent('q'))[0]!, 'p');
        // `l`'s first copy is lost.
        await deliverEach(await q.readSent('p'), p, 'q');
        const beforeRetry = toControlTuples(await p.readSentControls('a'));

        // The origin's missing-recipient retry still goes through `p`, whose hop is open.
        await p.receive(signed, 'a');
        await q.receive((await p.readSent('q')).at(-1)!, 'p');
        await l.receive((await q.readSent('l')).at(-1)!, 'q');
        const qSentBefore = (await q.readSent('p')).length;
        await deliverEach(await l.readSent('q'), q, 'l');
        await deliverEach((await q.readSent('p')).slice(qSentBefore), p, 'q');
        await origin.accept(await p.readSent('a'));

        expect(beforeRetry.toSorted()).toEqual([['ack', 'p', 'accepted'], ['nack', 'q', 'not-subscribed']]);
        expect(l.delivered.map((message) => message.id.msgId)).toEqual([signed.id.msgId]);
        expect(toControlTuples(await p.readSentControls('a'))).toContainEqual(['ack', 'p', 'subtree-complete']);
        // The retried copy is answered with every NACK `p` forwarded, as with every ACK.
        expect(toControlTuples(await p.readSentControls('a')).filter(([type]) => type === 'nack')).toEqual([
            ['nack', 'q', 'not-subscribed'],
            ['nack', 'q', 'not-subscribed']
        ]);
        expect(toReceiptStatement(origin.facts)).toEqual({ confirmed: ['p', 'l'], outside: ['q'], complete: true });
    });

    it('records a nested not-subscribed relay outside at the origin when its NACK is lost, from its completion ACK alone', async () => {
        const chain = await createRelayChain(['a', 'p', 'q', 'l'], {
            a: PUBLISH_AND_SUBSCRIBE,
            p: SUBSCRIBE_ONLY,
            q: SUBSCRIBE_ONLY,
            l: SUBSCRIBE_ONLY
        });
        const p = createChainHop(chain, { selfPeerId: 'p', neighbourPeerIds: ['a', 'q'], topicSubscriptions: ACTIVE_TOKEN });
        const q = createChainHop(chain, { selfPeerId: 'q', neighbourPeerIds: ['p', 'l'] });
        const l = createChainHop(chain, { selfPeerId: 'l', neighbourPeerIds: ['q'], topicSubscriptions: ACTIVE_TOKEN });
        const signed = await signReceiptedPublication(chain, {
            resourceId: 'feed-1',
            recipientPeerIds: ['p', 'q', 'l'],
            nextHopPeerId: 'p'
        });
        const origin = await createOriginReceipt(signed, { expectedPeerIds: ['p', 'q', 'l'], nextHopPeerIds: ['p'] });

        await p.receive(signed, 'a');
        await q.receive((await p.readSent('q'))[0]!, 'p');
        await l.receive((await q.readSent('l'))[0]!, 'q');
        await deliverEach(await l.readSent('q'), q, 'l');
        // `q`'s own NACK is lost on its way to `p`; its ACKs, its hop's completion included, arrive.
        const qAcks = (await q.readSent('p')).filter((control) => decodeALControlMessage(control).right?.type === 'ack');
        await deliverEach(qAcks, p, 'q');
        await origin.accept(await p.readSent('a'));

        expect(l.delivered.map((message) => message.id.msgId)).toEqual([signed.id.msgId]);
        expect(q.delivered).toEqual([]);
        // `p` forwards `q`'s hop-end, which stands for the lost NACK, as `q` signed it.
        expect(toControlTuples(await p.readSentControls('a')).filter(([, recipient]) => recipient === 'q')).toEqual([
            ['ack', 'q', 'subtree-complete-not-subscribed']
        ]);
        expect(toReceiptStatement(origin.facts)).toEqual({ confirmed: ['p', 'l'], outside: ['q'], complete: true });
    });

    it.each<[string, readonly number[]]>([
        ['its first copy arriving where a gap would have been', [2]],
        ['a later copy arriving past where a gap would have been', [1, 3]]
    ])('witnesses an ordered copy, answering not-subscribed and confirming nobody, with %s', async (_shape, seqs) => {
        const chain = await createRelayChain(['a', 'c'], { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'] });
        const frames: ALMessage[] = [];
        for (const seq of seqs) {
            frames.push(await signOrderedReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['c'], nextHopPeerId: 'c', seq }));
        }
        const gapped = frames.at(-1)!;
        const origin = await createOriginReceipt(gapped, { expectedPeerIds: ['c'], nextHopPeerIds: ['c'] });

        for (const frame of frames) {
            await leaf.receive(frame, 'a');
        }
        const gappedControls = (await leaf.readSentControls('a')).filter((control) => toControlledMsgId(control) === gapped.id.msgId);
        await origin.accept((await leaf.readSent('a')).filter((sent) => {
            const control = decodeALControlMessage(sent).right;
            return control !== undefined && control.type !== 'receipt' && toControlledMsgId(control) === gapped.id.msgId;
        }));

        expect(leaf.delivered).toEqual([]);
        expect(readOrderingPositions(leaf)).toEqual(seqs.map((seq) => ['witnessed', seq, null]));
        // A witness never asks for the track's history: its position moved past the would-be gap.
        expect(toControlTuples(gappedControls).toSorted()).toEqual([
            ['ack', 'c', 'subtree-complete-not-subscribed'],
            ['nack', 'c', 'not-subscribed']
        ]);
        // A receipt whose every recipient is outside confirmed nothing, so it stays open until its deadline.
        expect(toReceiptStatement(origin.facts)).toEqual({ confirmed: [], outside: ['c'], complete: false });
    });

    it('ends a not-subscribed relay\'s hop past a would-be gap with a completion that confirms nobody, its leaf answering likewise', async () => {
        const chain = await createRelayChain(['a', 'q', 'l'], { a: PUBLISH_AND_SUBSCRIBE, q: SUBSCRIBE_ONLY, l: SUBSCRIBE_ONLY });
        const q = createChainHop(chain, { selfPeerId: 'q', neighbourPeerIds: ['a', 'l'] });
        const l = createChainHop(chain, { selfPeerId: 'l', neighbourPeerIds: ['q'] });
        const gapped = await signOrderedReceiptedPublication(chain, {
            resourceId: 'feed-1',
            recipientPeerIds: ['q', 'l'],
            nextHopPeerId: 'q',
            seq: 2
        });
        const origin = await createOriginReceipt(gapped, { expectedPeerIds: ['q', 'l'], nextHopPeerIds: ['q'] });

        await q.receive(gapped, 'a');
        await l.receive((await q.readSent('l'))[0]!, 'q');
        await deliverEach(await l.readSent('q'), q, 'l');
        await origin.accept(await q.readSent('a'));

        expect([q.delivered, l.delivered]).toEqual([[], []]);
        expect(toControlTuples(await q.readSentControls('a')).toSorted()).toEqual([
            ['ack', 'l', 'subtree-complete-not-subscribed'],
            ['ack', 'q', 'subtree-complete-not-subscribed'],
            ['nack', 'q', 'not-subscribed']
        ]);
        // A receipt whose every recipient is outside confirmed nothing, so it stays open until its deadline.
        expect(toReceiptStatement(origin.facts)).toEqual({ confirmed: [], outside: ['q', 'l'], complete: false });
    });

    it('answers not-subscribed for a subscribe holder whose own token is still pending, delivering nothing (PL12)', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, r: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'], topicSubscriptions: ACTIVE_TOKEN });
        const tokens = createPendingTopicSubscriptions();
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'], topicSubscriptions: tokens.reader });
        const signed = await signReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['r', 'c'], nextHopPeerId: 'r' });

        await relay.receive(signed, 'a');
        await leaf.receive((await relay.readSent('c'))[0]!, 'r');

        expect([tokens.token.status(), leaf.delivered]).toEqual(['pending', []]);
        expect(toControlTuples(await leaf.readSentControls('r'))).toContainEqual(['nack', 'c', 'not-subscribed']);
    });

    it('answers for an unsubscribed relay with its own NACK, forwards its children\'s answers, and never confirms itself', async () => {
        const chain = await createRelayChain(['a', 'r', 'c', 'd'], {
            a: PUBLISH_AND_SUBSCRIBE,
            r: SUBSCRIBE_ONLY,
            c: SUBSCRIBE_ONLY,
            d: SUBSCRIBE_ONLY
        });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c', 'd'] });
        const subscribed = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'], topicSubscriptions: ACTIVE_TOKEN });
        const unsubscribed = createChainHop(chain, { selfPeerId: 'd', neighbourPeerIds: ['r'] });
        const signed = await signReceiptedPublication(chain, {
            resourceId: 'feed-1',
            recipientPeerIds: ['r', 'c', 'd'],
            nextHopPeerId: 'r'
        });

        await relay.receive(signed, 'a');
        await subscribed.receive((await relay.readSent('c'))[0]!, 'r');
        await unsubscribed.receive((await relay.readSent('d'))[0]!, 'r');
        await deliverEach(await subscribed.readSent('r'), relay, 'c');
        await deliverEach(await unsubscribed.readSent('r'), relay, 'd');

        expect(relay.delivered).toEqual([]);
        expect(toControlTuples(await relay.readSentControls('a')).toSorted()).toEqual([
            ['ack', 'c', 'delivered'],
            ['ack', 'd', 'subtree-complete-not-subscribed'],
            ['ack', 'r', 'subtree-complete-not-subscribed'],
            ['nack', 'r', 'not-subscribed']
        ]);
    });

    it('refuses at the relay a NACK naming a peer outside the frame\'s frozen audience, carrying nothing upward', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, r: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'], topicSubscriptions: ACTIVE_TOKEN });
        const signed = await signReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['r', 'c'], nextHopPeerId: 'r' });
        await relay.receive(signed, 'a');
        const sentBefore = (await relay.readSentControls('a')).length;

        await relay.receive(createStrayNotSubscribed(signed, 'stranger'), 'c');

        expect((await relay.readSentControls('a')).slice(sentBefore)).toEqual([]);
    });

    it('says nothing at an unsubscribed relay outside the frozen audience: it only forwards', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'] });
        const signed = await signReceiptedPublication(chain, { resourceId: 'feed-1', recipientPeerIds: ['c'], nextHopPeerId: 'r' });

        await relay.receive(signed, 'a');

        expect(await relay.readSent('c')).toHaveLength(1);
        expect(toControlTuples(await relay.readSentControls('a')).filter(([type]) => type === 'nack')).toEqual([]);
    });
});

describe('a recorded ordered track at its frozen recipients', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('states one witnessed position for a copy and none for its receipt-retried duplicate', async () => {
        const chain = await createRelayChain(['a', 'c'], { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'] });
        const [frame] = await signTrack(chain, [{ seq: 1, recipientPeerIds: ['c'], priorSeqByRecipient: {} }]);

        await leaf.receive(frame!, 'a');
        await leaf.receive(frame!, 'a');

        expect(readOrderingPositions(leaf)).toEqual([['witnessed', 1, 0]]);
    });

    it('witnesses 1 and 2 while its token is pending, then delivers 3 in order once active, never asking for 1 or 2', async () => {
        const chain = await createRelayChain(['a', 'c'], { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY });
        const token = createSwitchableTopicSubscriptions();
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'], topicSubscriptions: token.reader });
        const frames = await signTrack(chain, [1, 2, 3].map((seq) => ({ seq, recipientPeerIds: ['c'], priorSeqByRecipient: {} })));

        await leaf.receive(frames[0]!, 'a');
        await leaf.receive(frames[1]!, 'a');
        token.activate();
        await leaf.receive(frames[2]!, 'a');

        expect(leaf.delivered.map((message) => message.ordering?.seq)).toEqual([3]);
        expect(readOrderingPositions(leaf)).toEqual([['witnessed', 1, 0], ['witnessed', 2, 1]]);
        expect(toControlTuples(await leaf.readSentControls('a')).filter(isRepairRequest)).toEqual([]);
    });

    it('delivers a subscriber\'s copy past the sends it was excluded from as an omission, asking for none of them', async () => {
        const chain = await createRelayChain(['a', 'b', 'c'], { a: PUBLISH_AND_SUBSCRIBE, b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'], topicSubscriptions: ACTIVE_TOKEN });
        const frames = await signTrack(chain, [
            { seq: 1, recipientPeerIds: ['b', 'c'], priorSeqByRecipient: {} },
            { seq: 2, recipientPeerIds: ['b', 'c'], priorSeqByRecipient: {} },
            { seq: 5, recipientPeerIds: ['b', 'c'], priorSeqByRecipient: { c: 2 } }
        ]);

        for (const frame of frames) {
            await leaf.receive(frame, 'a');
        }

        expect(leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 5]);
        expect(readOrderingPositions(leaf)).toEqual([['entered', 1, 0], ['omitted', 5, 2]]);
        expect(toControlTuples(await leaf.readSentControls('a')).filter(isRepairRequest)).toEqual([]);
    });

    it('opens the track at an entry frame lost in transit when its repaired copy arrives alone', async () => {
        const chain = await createRelayChain(['a', 'c'], { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'], topicSubscriptions: ACTIVE_TOKEN });
        const [entry] = await signTrack(chain, [{ seq: 7, recipientPeerIds: ['c'], priorSeqByRecipient: { c: 0 } }]);

        // The first copy is lost; the origin's retry is the only copy that arrives.
        await leaf.receive(entry!, 'a');

        expect(leaf.delivered.map((message) => message.ordering?.seq)).toEqual([7]);
        expect(readOrderingPositions(leaf)).toEqual([['entered', 7, 0]]);
        expect(toControlTuples(await leaf.readSentControls('a')).filter(isRepairRequest)).toEqual([]);
    });

    it('answers a copy below its position before-entry, carried through a relay and recorded outside at the origin, never ending its receipt', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'] });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'], topicSubscriptions: ACTIVE_TOKEN });
        const [below, entry] = await signTrack(chain, [
            { seq: 3, recipientPeerIds: ['c'], priorSeqByRecipient: { c: 0 }, nextHopPeerId: 'r' },
            { seq: 5, recipientPeerIds: ['c'], priorSeqByRecipient: { c: 0 }, nextHopPeerId: 'r' }
        ]);
        const origin = await createOriginReceipt(below!, { expectedPeerIds: ['c'], nextHopPeerIds: ['r'] });

        await relay.receive(entry!, 'a');
        await leaf.receive((await relay.readSent('c'))[0]!, 'r');
        await relay.receive(below!, 'a');
        await leaf.receive((await relay.readSent('c'))[1]!, 'r');
        await deliverEach((await leaf.readSent('r')).filter((control) => toControlledMsgIdOf(control) === below!.id.msgId), relay, 'c');
        await origin.accept((await relay.readSent('a')).filter((control) => toControlledMsgIdOf(control) === below!.id.msgId));
        // A retried copy of the entry is a duplicate: it commits no position, so it states none.
        await leaf.receive((await relay.readSent('c'))[0]!, 'r');

        expect(leaf.delivered.map((message) => message.ordering?.seq)).toEqual([5]);
        expect(readOrderingPositions(leaf)).toEqual([['entered', 5, 0], ['before-entry', 3, 0]]);
        expect(toControlTuples(await relay.readSentControls('a')).filter(([type]) => type === 'nack')).toEqual([['nack', 'c', 'before-entry']]);
        // A before-entry NACK places its recipient outside; it never ends the receipt as a refusal would.
        expect(toReceiptStatement(origin.facts)).toEqual({ confirmed: [], outside: ['c'], complete: false });
    });

    it('answers each arrival of a copy below its position: a refused copy keeps no row that would make a retry a duplicate', async () => {
        const chain = await createRelayChain(['a', 'r', 'c'], { a: PUBLISH_AND_SUBSCRIBE, c: SUBSCRIBE_ONLY });
        const relay = createChainHop(chain, { selfPeerId: 'r', neighbourPeerIds: ['a', 'c'] });
        const leaf = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['r'], topicSubscriptions: ACTIVE_TOKEN });
        const [below, entry] = await signTrack(chain, [
            { seq: 3, recipientPeerIds: ['c'], priorSeqByRecipient: { c: 0 }, nextHopPeerId: 'r' },
            { seq: 5, recipientPeerIds: ['c'], priorSeqByRecipient: { c: 0 }, nextHopPeerId: 'r' }
        ]);
        await relay.receive(entry!, 'a');
        await leaf.receive((await relay.readSent('c'))[0]!, 'r');
        await relay.receive(below!, 'a');
        const belowCopy = (await relay.readSent('c'))[1]!;

        await leaf.receive(belowCopy, 'r');
        await leaf.receive(belowCopy, 'r');

        expect(readOrderingPositions(leaf)).toEqual([['entered', 5, 0], ['before-entry', 3, 0], ['before-entry', 3, 0]]);
        expect(toControlTuples(await leaf.readSentControls('r')).filter(([type]) => type === 'nack'))
            .toEqual([['nack', 'c', 'before-entry'], ['nack', 'c', 'before-entry']]);
    });
});

describe('a receipted granted send its own RTC origin signs', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('freezes to the subscribe holders, and a holder whose token is pending receives nothing while the sender\'s receipt records it outside', async () => {
        const chain = await createRelayChain(['a', 'b', 'c', 'd'], { a: PUBLISH_ONLY, b: SUBSCRIBE_ONLY, c: SUBSCRIBE_ONLY });
        const origin = createRtcOriginOverlayFixture({
            snapshot: chain.snapshot,
            nextHopPeerIds: ['b', 'c', 'd'],
            grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
            publicationCrypto: chain.keys.a
        });
        const subscribed = createChainHop(chain, { selfPeerId: 'b', neighbourPeerIds: ['a'], topicSubscriptions: ACTIVE_TOKEN });
        const tokens = createPendingTopicSubscriptions();
        const pending = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'], topicSubscriptions: tokens.reader });
        const message = newALMulticastMessage(
            'a',
            { topicId: PUBLICATION_TOPIC_ID, resourceId: 'feed-1', contextId: ORIGIN_ROOM.groupId },
            ORIGIN_ROOM,
            'room.granted-feed.v1',
            { text: 'feed' },
            { ack: 'receiver', reliability: 'at-least-once', ttlMs: 30_000, traceId: 'trace-origin-signed' }
        );

        const admitted = await origin.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(0);
        await subscribed.receive(origin.channels.b!.sent[0]!, 'a');
        await pending.receive(origin.channels.c!.sent[0]!, 'a');
        for (const control of [...await subscribed.readSent('a'), ...await pending.readSent('a')]) {
            await origin.manager.acceptControlMessage(control);
        }

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toMatchObject({ recipientPeerIds: ['b', 'c'] });
        expect(subscribed.delivered.map((delivered) => delivered.id.msgId)).toEqual([message.id.msgId]);
        expect([tokens.token.status(), pending.delivered]).toEqual(['pending', []]);
        expect(toDeliveryReceiptStatement(origin.settlements)).toEqual({
            expected: ['b', 'c'],
            confirmed: ['b'],
            outside: ['c'],
            complete: true
        });
    });

    it('signs a receipted granted list at its origin, a listed holder without an election recorded outside, an unlisted subscriber delivering nothing', async () => {
        const chain = await createRelayChain(['a', 'b', 'c', 'd'], {
            a: PUBLISH_ONLY,
            b: SUBSCRIBE_ONLY,
            c: SUBSCRIBE_ONLY,
            d: SUBSCRIBE_ONLY
        });
        const origin = createRtcOriginOverlayFixture({
            snapshot: chain.snapshot,
            nextHopPeerIds: ['b', 'c', 'd'],
            grantedTopics: createRtcGrantedTopicsFixture([PUBLICATION_TOPIC_ID]),
            publicationCrypto: chain.keys.a
        });
        const listed = createChainHop(chain, { selfPeerId: 'b', neighbourPeerIds: ['a'], topicSubscriptions: ACTIVE_TOKEN });
        const unelected = createChainHop(chain, { selfPeerId: 'c', neighbourPeerIds: ['a'] });
        const unlisted = createChainHop(chain, { selfPeerId: 'd', neighbourPeerIds: ['a'], topicSubscriptions: ACTIVE_TOKEN });
        const message: ALMessage = {
            ...newALMulticastMessage(
                'a',
                { topicId: PUBLICATION_TOPIC_ID, resourceId: 'feed-1', contextId: ORIGIN_ROOM.groupId },
                ORIGIN_ROOM,
                'room.granted-feed.v1',
                { text: 'feed' },
                { ack: 'receiver', reliability: 'at-least-once', ttlMs: 30_000, traceId: 'trace-origin-signed-list' }
            ),
            targets: { mode: 'broadcast', scope: 'room', groupRef: ORIGIN_ROOM, recipientPeerIds: ['b', 'c'] }
        };

        const admitted = await origin.manager.enqueueLegIfAbsent(message, 'hold');
        await vi.advanceTimersByTimeAsync(0);
        await listed.receive(origin.channels.b!.sent[0]!, 'a');
        await unelected.receive(origin.channels.c!.sent[0]!, 'a');
        // Relaying is distinct from delivery: the unlisted subscriber is still an overlay next hop.
        await unlisted.receive(origin.channels.d!.sent[0]!, 'a');
        for (const control of [...await listed.readSent('a'), ...await unelected.readSent('a')]) {
            await origin.manager.acceptControlMessage(control);
        }

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toMatchObject({ mode: 'multicast', recipientPeerIds: ['b', 'c'], snapshotVersion: 3 });
        expect(admitted.message.proof).toBeDefined();
        expect(listed.delivered.map((delivered) => delivered.id.msgId)).toEqual([message.id.msgId]);
        expect(unelected.delivered).toEqual([]);
        expect(origin.channels.d!.sent.map((relayed) => relayed.targets)).toMatchObject([{ mode: 'multicast', recipientPeerIds: ['b', 'c'] }]);
        expect(unlisted.delivered).toEqual([]);
        expect(toDeliveryReceiptStatement(origin.settlements)).toEqual({
            expected: ['b', 'c'],
            confirmed: ['b'],
            outside: ['c'],
            complete: true
        });
    });
});

/** A receipted granted frame as the origin `a` signs it. */
async function signReceiptedPublication(chain: RelayChain, input: ReceiptedPublicationInput): Promise<ALMessage> {
    const frozen = createFrozenGrantedMulticast({
        senderId: 'a',
        resourceId: input.resourceId,
        recipientPeerIds: input.recipientPeerIds,
        snapshotVersion: 3,
        ack: 'receiver'
    });
    return await signPublication(chain.keys.a!, {
        ...frozen,
        forwarding: { ...frozen.forwarding, nextHopPeerIds: [input.nextHopPeerId] }
    });
}

/** The origin's own `receiver` receipt for the frame, as its RTC dispatch tracks it. */
async function createOriginReceipt(
    signed: ALMessage,
    tracking: Readonly<{ expectedPeerIds: readonly string[]; nextHopPeerIds: readonly string[]; }>
): Promise<OriginReceipt> {
    const facts: ALOutboundSettlementFact[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        settlements: (fact) => facts.push(fact),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true }),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            ackTracking: { enabled: true, timeoutMs: 10_000, maxAttempts: 0, mode: 'receiver', ...tracking }
        })
    });
    await enqueueOutboundOrThrow(runtime, signed);
    return {
        facts,
        accept: async (controls) => {
            for (const control of controls) {
                await runtime.acceptControlMessage(control, 'peer');
            }
        }
    };
}

function toSortedByControlType(
    controls: readonly ALMessage[],
    order: readonly ('ack' | 'nack')[]
): readonly ALMessage[] {
    const rank = (control: ALMessage) => order.indexOf(decodeALControlMessage(control).right?.type as 'ack' | 'nack');
    return controls.toSorted((left, right) => rank(left) - rank(right));
}

function toDeliveryReceiptStatement(settlements: readonly ALDeliverySettlement[]) {
    const last = settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1);
    return last?.kind === 'acknowledgement'
        ? {
            expected: last.expectedRecipientPeerIds,
            confirmed: last.confirmedRecipientPeerIds,
            outside: last.outsideAudienceRecipientPeerIds,
            complete: last.complete
        }
        : undefined;
}

function toReceiptStatement(facts: readonly ALOutboundSettlementFact[]) {
    const last = facts.filter((fact) => fact.kind === 'acknowledgement').at(-1);
    return last?.kind === 'acknowledgement'
        ? { confirmed: last.confirmedRecipientPeerIds, outside: last.outsideAudienceRecipientPeerIds, complete: last.complete }
        : undefined;
}

/** The message a control answers. */
function toControlledMsgId(control: ALPeerControlMessage): string {
    return control.type === 'ack' ? control.payload.ackedMsgId : control.payload.msgId;
}

/** The message a sent control answers; undefined for a data copy. */
function toControlledMsgIdOf(message: ALMessage): string | undefined {
    const control = decodeALControlMessage(message).right;
    return control === undefined || control.type === 'receipt' ? undefined : toControlledMsgId(control);
}

/** A NACK or repair that asks the origin for history, as opposed to one placing the recipient outside. */
function isRepairRequest(control: readonly string[]): boolean {
    return control[0] === 'repair' || (control[0] === 'nack' && control[2] !== 'not-subscribed');
}

/** A token the test activates, as the tab's held subscription does once its subscribe call answers. */
function createSwitchableTopicSubscriptions(): Readonly<{ reader: RtcTopicSubscriptionReader; activate: () => void; }> {
    let active = false;
    return {
        reader: { isSubscriptionActive: (_groupRef, topicId) => active && topicId === PUBLICATION_TOPIC_ID },
        activate: () => {
            active = true;
        }
    };
}

/** A `not-subscribed` NACK from the leaf `c` naming a peer the frame never froze. */
function createStrayNotSubscribed(signed: ALMessage, logicalRecipientPeerId: string): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: 'stray-nack', ts: Date.now(), senderId: 'c', traceId: signed.id.traceId },
        toTestALNackPayload({
            msgId: signed.id.msgId,
            fromPeerId: 'c',
            toPeerId: 'r',
            logicalRecipientPeerId,
            reason: 'not-subscribed',
            observedAtEpochMs: Date.now()
        })
    );
}

/** The tab's real token store holding the topic: its subscribe call never answers, so the token stays pending. */
function createPendingTopicSubscriptions(): Readonly<{ reader: RtcTopicSubscriptionReader; token: RallarTopicSubscription; }> {
    const unanswered = () => new Promise<never>(() => {});
    const store = new BrowserTopicSubscriptions({
        http: { subscribeGroupTopic: unanswered, unsubscribeGroupTopic: unanswered },
        timers: createDefaultTimers(),
        newRequestId: () => 'request-pending'
    });
    return { reader: store, token: store.hold({ roomRef: ORIGIN_ROOM, topicId: PUBLICATION_TOPIC_ID }) };
}
