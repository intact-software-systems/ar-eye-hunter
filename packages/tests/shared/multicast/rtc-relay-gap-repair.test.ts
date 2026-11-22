import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newALBroadcastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    newALNackControlMessage,
    type ALNackPayload,
    type ALPeerControlMessage
} from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALSeqRangesText } from '@shared/al-contracts/al-seq-range.ts';
import type { ALAdmissionMemoryState, ALAdmissionStoredValue } from '@shared/alm/al-admission-backend.ts';
import { toALInboundControlPendingKey } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import { toALOutboundReceiptClasses } from '@shared/alm/outbound/control/to-al-outbound-receipt-classes.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';

import { ORIGIN_ROOM } from './rtc-origin-overlay-fixture.ts';
import { PUBLICATION_TOPIC_ID, PUBLISH_AND_SUBSCRIBE, PUBLISH_ONLY, SUBSCRIBE_ONLY } from './rtc-publication-proof-fixtures.ts';
import {
    createChainHop,
    createOriginRelayChain,
    deliverEach,
    drainUntil,
    publishOrderedFromOrigin,
    readOrderingPositions,
    toControlTuples,
    toGrantsSnapshot,
    type OriginRelayChain
} from './rtc-relay-chain-test-support.ts';
import { createObservedVolatileInboundPair, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';
import { createRtcTopicSubscriptionsFixture } from './rtc-topic-subscription-reader-fixtures.ts';

import { signTestALReceiptControl, toTestALNackPayload, verifyTestALReceiptControl } from '../../al-control-test-payloads.ts';

type ChainGrants = Readonly<Record<string, GroupPublicationTopicPermissions>>;

type GapNackControl = Extract<ALPeerControlMessage, { type: 'nack'; }>;

/** The origin `a`, its publish-only relay `r` and the subscribed leaf `c`, with `a`'s copies of seq 1..3 to `r`. */
interface GapChain {
    readonly chain: OriginRelayChain;
    readonly relay: RtcRelayOverlayFixture;
    readonly leaf: RtcRelayOverlayFixture;
    /** The relay session's inbound rows. */
    readonly relayRows: ALAdmissionMemoryState;
    readonly frames: readonly ALMessage[];
}

/** Every track of the chain is `at-least-once`, so the origin repairs it whatever receipt it asks for. */
interface GapChainInput {
    readonly ack: 'none' | 'receiver';
    /** The relay's children; absent, the leaf alone. */
    readonly relayChildPeerIds?: readonly string[];
    /** The grants the origin's room holds as it freezes a sequence; absent, the chain's own for every sequence. */
    readonly grantsBySeq?: Readonly<Record<number, ChainGrants>>;
}

/** The frames each link had carried when they were read. */
interface ChainLinks {
    readonly originToRelay: number;
    readonly relayToLeaf: number;
    readonly leafToRelay: number;
    readonly relayToOrigin: number;
}

interface GapNackInput {
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    /** The copy whose arrival revealed the gap: the NACK names it. */
    readonly revealing: ALMessage;
    /** The control's own id; absent, `leaf-gap-` and its sender. */
    readonly controlMsgId?: string;
}

/** The publish-only relay `r` is frozen into nothing: only the leaf `c` subscribes. */
const GRANTS: ChainGrants = { a: PUBLISH_AND_SUBSCRIBE, r: PUBLISH_ONLY, c: SUBSCRIBE_ONLY };

/** Seq 2 is frozen while the relay holds subscribe and the leaf does not; seq 3 under the chain's own grants again. */
const SEQ_2_WITHOUT_LEAF: Readonly<Record<number, ChainGrants>> = {
    2: { a: PUBLISH_AND_SUBSCRIBE, r: PUBLISH_AND_SUBSCRIBE, c: PUBLISH_ONLY },
    3: GRANTS
};

const RELAY_NAMESPACE = 'relay-gap-repair';

const CHAIN_STEP_MS = 250;

describe('a gap below a publish-only RTC relay on a receipted ordered granted track (S4ii-R4)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('forwards the leaf\'s gap NACK toward the origin, writing nothing, and forwards the origin\'s repair to the leaf', async () => {
        const gap = await createGapChain({ ack: 'receiver' });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1, 3]);
        const leafControls = await readLeafControls(gap);
        const nack = readGapNack(leafControls);
        const rowBefore = readRelayRow(gap, nack.payload.msgId);

        await deliverEach(leafControls, gap.relay, 'c');
        const admissions = await acceptAtOrigin(gap, await readRelayUpwardControls(gap));
        await repairThroughRelay(gap);

        expect(gap.leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 3]);
        expect(readOrderingPositions(gap.leaf)).toEqual([['entered', 1, 0]]);
        expect(readRelayedNacks(await gap.relay.readSentControls('a'))).toEqual([
            { control: ['nack', 'c', 'gap'], orderingKey: nack.payload.orderingKey, missingRanges: '2-2' }
        ]);
        expect(readOrderingPositions(gap.relay)).toEqual([]);
        expect(rowBefore).toBeDefined();
        expect(readRelayRow(gap, nack.payload.msgId)).toEqual(rowBefore);
        expect(admissions.get('gap')).toBe('committed');
        expect(readControlAdmissions(gap)).toContainEqual(
            expect.objectContaining({ outcome: 'committed', nackReason: 'gap', nackOrderingKey: nack.payload.orderingKey })
        );
        // The relay had seq 2 already: the origin's repair copy is a duplicate there, and its retried forward reaches `c`.
        expect(readAdmissionOutcomes(gap.relay, gap.frames[1]!.id.msgId)).toEqual([
            ['committed', 'admitted'],
            ['not-handled', 'duplicate']
        ]);
    });

    it('forwards the origin\'s repair as a first admission at the relay when the sequence was lost before it', async () => {
        const gap = await createGapChain({ ack: 'receiver' });
        await forwardTrack(gap, [1, 3]);
        await receiveAtLeaf(gap, [1, 3]);

        await deliverEach(await readLeafControls(gap), gap.relay, 'c');
        await acceptAtOrigin(gap, await readRelayUpwardControls(gap));
        await repairThroughRelay(gap);

        expect(gap.leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 3]);
        expect(readOrderingPositions(gap.leaf)).toEqual([['entered', 1, 0]]);
        expect(readAdmissionOutcomes(gap.relay, gap.frames[1]!.id.msgId)).toEqual([['committed', 'admitted']]);
    });

    it('verifies the gap NACK the leaf\'s own sign step signed at the signature origin, and repairs the gap', async () => {
        const gap = await createGapChain({ ack: 'receiver' });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1, 3]);

        const leafGap = (await readLeafControls(gap)).find((control) => findGapNack([control]) !== undefined);
        await deliverEach(await readLeafControls(gap), gap.relay, 'c');
        const relayedGap = (await readRelayUpwardControls(gap)).find((control) => findGapNack([control]) !== undefined);
        const admissions = await acceptAtOrigin(gap, await readRelayUpwardControls(gap));
        await repairThroughRelay(gap);

        expect(leafGap === undefined ? false : await verifyTestALReceiptControl(gap.chain.keys.c!, leafGap)).toBe(true);
        expect(relayedGap === undefined ? false : await verifyTestALReceiptControl(gap.chain.keys.c!, relayedGap)).toBe(true);
        expect(admissions.get('gap')).toBe('committed');
        expect(gap.chain.origin.diagnostics.some((event) => event.kind === 'control-admission' && event.proofRefusal !== undefined))
            .toBe(false);
        expect(gap.leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 3]);
    });

    it('serves no copy toward a leaf the origin froze into the next sequence but not the missing one (D530)', async () => {
        const gap = await createGapChain({ ack: 'receiver', grantsBySeq: SEQ_2_WITHOUT_LEAF });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1, 3]);
        const sentBefore = gap.chain.origin.channels.r!.sent.length;

        // Seq 3 names the leaf's prior as 1, so the leaf sees no gap; a stale gap NACK still asks for seq 2.
        await gap.relay.receive(await toGapNack(gap, { fromPeerId: 'c', logicalRecipientPeerId: 'c', revealing: gap.frames[2]! }), 'c');
        const admissions = await acceptAtOrigin(gap, await readRelayUpwardControls(gap));

        expect(gap.frames.map((frame) => frame.targets)).toMatchObject([
            { recipientPeerIds: ['c'] },
            { recipientPeerIds: ['r'] },
            { recipientPeerIds: ['c'] }
        ]);
        expect(readRelayedNacks(await gap.relay.readSentControls('a'))).toContainEqual(
            expect.objectContaining({ control: ['nack', 'c', 'gap'], missingRanges: '2-2' })
        );
        // The NACK names seq 3, which the leaf is owed, so it commits; the repair of seq 2 then admits no copy for it.
        expect(admissions.get('gap')).toBe('committed');
        expect(gap.chain.origin.channels.r!.sent.slice(sentBefore)).toEqual([]);
    });

    it('serves nothing for the relay\'s gap NACK once the origin\'s publish is revoked (D519)', async () => {
        const gap = await createGapChain({ ack: 'receiver' });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1, 3]);
        await deliverEach(await readLeafControls(gap), gap.relay, 'c');
        const upward = await readRelayUpwardControls(gap);
        const sentBefore = gap.chain.origin.channels.r!.sent.length;

        gap.chain.origin.groups.accept('room', toGrantsSnapshot(gap.chain.snapshot, 4, { a: SUBSCRIBE_ONLY }));
        const admissions = await acceptAtOrigin(gap, upward);

        expect(admissions.get('gap')).toBe('not-handled');
        expect(gap.chain.origin.channels.r!.sent.slice(sentBefore)).toEqual([]);
    });

    it('refuses at the relay a gap NACK from a neighbour its row does not wait on, and relays the waited leaf\'s', async () => {
        // `d` is a neighbour of the relay outside the room, so the relay forwards it nothing and its row waits on `c` alone.
        const gap = await createGapChain({ ack: 'receiver', relayChildPeerIds: ['c', 'd'] });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1]);
        const revealing = gap.frames[2]!;

        await gap.relay.receive(await toGapNack(gap, { fromPeerId: 'd', logicalRecipientPeerId: 'c', revealing }), 'd');
        const relayedFromStranger = readRelayedNacks(await gap.relay.readSentControls('a'));
        await gap.relay.receive(await toGapNack(gap, { fromPeerId: 'c', logicalRecipientPeerId: 'c', revealing }), 'c');
        await readRelayUpwardControls(gap);

        expect(readRelayRow(gap, revealing.id.msgId)).toMatchObject({ value: { kind: 'pending', value: { expectedFromPeerIds: ['c'] } } });
        expect(readAdmissionOutcomes(gap.relay, 'leaf-gap-d')).toEqual([['not-handled', 'control']]);
        expect(relayedFromStranger).toEqual([]);
        expect(readRelayedNacks(await gap.relay.readSentControls('a')).map(({ control }) => control)).toEqual([
            ['nack', 'c', 'gap']
        ]);
    });

    it('renews the gap across the relay while the leaf holds the revealing message buffered, and confirms it once on the release', async () => {
        const gap = await createGapChain({ ack: 'receiver' });
        const revealing = gap.frames[2]!;
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1, 3]);
        await deliverEach(await readLeafControls(gap), gap.relay, 'c');
        const firstRequest = await readRelayUpwardControls(gap);
        const links = await readChainLinks(gap);
        await acceptAtOrigin(gap, firstRequest);

        // The origin's repair copy and its receipt retry of seq 3 cross the relay; every forward of seq 2 to `c` is lost.
        await advanceChainBy(2_000);
        await deliverEach(gap.chain.origin.channels.r!.sent.slice(links.originToRelay), gap.relay, 'a');
        await drainUntil(() => false, 20);
        const forwardedToLeaf = (await gap.relay.readSent('c')).slice(links.relayToLeaf);
        expect(forwardedToLeaf.map((copy) => copy.ordering?.seq)).toEqual(expect.arrayContaining([2, 3]));
        await deliverEach(forwardedToLeaf.filter((copy) => copy.ordering?.seq !== 2), gap.leaf, 'r');
        await advanceChainBy(2_600);
        await deliverEach((await gap.leaf.readSent('r')).slice(links.leafToRelay), gap.relay, 'c');
        await drainUntil(() => false, 20);
        const upward = (await gap.relay.readSent('a')).slice(links.relayToOrigin);
        const renewal = upward.find((control) => readGapRequestNumber(control, 'c') === 3);
        const outcomes = await acceptEachAtOrigin(gap, upward);

        expect(readOwnAcks(await gap.leaf.readSentControls('r'), revealing)).toEqual([]);
        expect(renewal).toBeDefined();
        expect(renewal === undefined ? undefined : outcomes.get(renewal)).toBe('committed');
        expect(gap.leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1]);
        expect(await readOriginUnconfirmed(gap, revealing)).toContain('c');

        // The release delivers the revealing message, and its one `delivered` is the confirmation the origin counts.
        const leafSentBefore = (await gap.leaf.readSent('r')).length;
        const relaySentBefore = (await gap.relay.readSent('a')).length;
        await gap.leaf.receive(forwardedToLeaf.find((copy) => copy.ordering?.seq === 2)!, 'r');
        await drainUntil(() => gap.leaf.delivered.length >= gap.frames.length);
        await drainUntil(async () => readOwnAcks(await gap.leaf.readSentControls('r'), revealing).length > 0);
        await deliverEach((await gap.leaf.readSent('r')).slice(leafSentBefore), gap.relay, 'c');
        await drainUntil(async () => (await gap.relay.readSent('a')).length > relaySentBefore);
        await acceptAtOrigin(gap, (await gap.relay.readSent('a')).slice(relaySentBefore));

        expect(gap.leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 3]);
        expect(readOwnAcks(await gap.leaf.readSentControls('r'), revealing)).toEqual(['delivered']);
        expect(gap.chain.origin.settlements).toContainEqual(
            expect.objectContaining({ kind: 'acknowledgement', msgId: revealing.id.msgId, confirmedRecipientPeerIds: ['c'], complete: true })
        );
    });
});

describe('a gap below a publish-only RTC relay on an unreceipted ordered granted track (6c)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('relays the gap NACK of a track without a receipt and the origin\'s repair reaches the leaf', async () => {
        const gap = await createGapChain({ ack: 'none' });
        await forwardTrack(gap, [1, 3]);
        await receiveAtLeaf(gap, [1, 3]);
        const leafControls = await readLeafControls(gap);
        const nack = readGapNack(leafControls);

        await deliverEach(leafControls, gap.relay, 'c');
        const admissions = await acceptAtOrigin(gap, await readRelayUpwardControls(gap));
        await repairThroughRelay(gap);

        expect(readAdmissionOutcomes(gap.relay, readGapNackMessage(leafControls).id.msgId)).toEqual([['committed', 'control']]);
        expect(readRelayedNacks(await gap.relay.readSentControls('a'))).toEqual([
            { control: ['nack', 'c', 'gap'], orderingKey: nack.payload.orderingKey, missingRanges: '2-2' }
        ]);
        expect(readRelayRow(gap, nack.payload.msgId)).toBeUndefined();
        expect(admissions.get('gap')).toBe('committed');
        expect(gap.leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 3]);
    });

    it('repairs a sequence the relay forwarded and its child lost: the relay passes the parent\'s repair copy down again', async () => {
        const gap = await createGapChain({ ack: 'none' });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1, 3]);
        await deliverEach(await readLeafControls(gap), gap.relay, 'c');
        const admissions = await acceptAtOrigin(gap, await readRelayUpwardControls(gap));

        await repairThroughRelay(gap);

        expect(admissions.get('gap')).toBe('committed');
        expect(readAdmissionOutcomes(gap.relay, gap.frames[1]!.id.msgId)).toEqual([
            ['committed', 'admitted'],
            ['not-handled', 'duplicate']
        ]);
        expect(gap.chain.origin.channels.r!.sent.slice(gap.frames.length).map((copy) => copy.ordering?.seq)).toEqual([2]);
        expect(gap.leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 3]);
    });

    it('a child that already holds the message reads the copy the relay passes down a duplicate and answers nothing', async () => {
        const gap = await createGapChain({ ack: 'none' });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1, 2, 3]);
        const links = await readChainLinks(gap);

        await gap.relay.receive(gap.frames[1]!, 'a');
        await drainUntil(async () => (await gap.relay.readSent('c')).length > links.relayToLeaf);
        const passedDown = (await gap.relay.readSent('c')).slice(links.relayToLeaf);
        await deliverEach(passedDown, gap.leaf, 'r');
        await drainUntil(() => false, 20);

        expect(passedDown.map((copy) => copy.ordering?.seq)).toEqual([2]);
        expect(readAdmissionOutcomes(gap.leaf, gap.frames[1]!.id.msgId)).toEqual([
            ['committed', 'admitted'],
            ['not-handled', 'duplicate']
        ]);
        expect((await gap.leaf.readSent('r')).slice(links.leafToRelay)).toEqual([]);
        expect(gap.leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1, 2, 3]);
    });

    it('forwards each admission of one numbered request; the origin admits it once and reads the repeat `duplicate`, repairing once', async () => {
        const gap = await createGapChain({ ack: 'none' });
        await forwardTrack(gap, [1, 3]);
        await receiveAtLeaf(gap, [1, 3]);
        const revealing = gap.frames[2]!;

        await gap.relay.receive(await toGapNack(gap, { fromPeerId: 'c', logicalRecipientPeerId: 'c', revealing, controlMsgId: 'leaf-gap-1' }), 'c');
        await gap.relay.receive(await toGapNack(gap, { fromPeerId: 'c', logicalRecipientPeerId: 'c', revealing, controlMsgId: 'leaf-gap-1-again' }), 'c');
        await drainUntil(async () => readRelayedNacks(await gap.relay.readSentControls('a')).length >= 2);
        const outcomes = await acceptEachAtOrigin(gap, await gap.relay.readSent('a'));
        await drainUntil(() => false, 20);

        expect([...outcomes.values()]).toEqual(['committed', 'duplicate']);
        expect(gap.chain.origin.channels.r!.sent.slice(gap.frames.length).map((copy) => copy.ordering?.seq)).toEqual([2]);
    });

    it('refuses at the relay a gap NACK from a child outside the frozen audience, or naming a recipient outside it', async () => {
        const gap = await createGapChain({ ack: 'none', relayChildPeerIds: ['c', 'd'] });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1]);
        const revealing = gap.frames[2]!;

        await gap.relay.receive(await toGapNack(gap, { fromPeerId: 'd', logicalRecipientPeerId: 'd', revealing }), 'd');
        await gap.relay.receive(
            await toGapNack(gap, { fromPeerId: 'c', logicalRecipientPeerId: 'd', revealing, controlMsgId: 'leaf-gap-c-for-d' }),
            'c'
        );
        await drainUntil(() => false, 20);

        expect(readAdmissionOutcomes(gap.relay, 'leaf-gap-d')).toEqual([['not-handled', 'control']]);
        expect(readAdmissionOutcomes(gap.relay, 'leaf-gap-c-for-d')).toEqual([['not-handled', 'control']]);
        expect(await gap.relay.readSentControls('a')).toEqual([]);
    });

    it('admits a ready room neighbour\'s gap NACK for a room send that froze no audience, and leaves a peer that is no ready neighbour\'s unhandled', async () => {
        const { origin } = await createOriginRelayChain(GRANTS);
        const sentBefore = origin.channels.r!.sent.length;
        const message = newALBroadcastMessage({
            scope: 'room',
            createdAtEpochMs: Date.now(),
            senderId: 'a',
            route: { topicId: 'room.chat', resourceId: 'unfrozen-3', contextId: ORIGIN_ROOM.groupId },
            typeId: 'room.chat.v1',
            resource: { text: 'unfrozen' },
            options: {
                groupRef: ORIGIN_ROOM,
                ack: 'none',
                reliability: 'at-least-once',
                ttlMs: 30_000,
                ordering: { orderingKey: 'chat', epoch: 1, seq: 3 }
            }
        });
        expect((await origin.manager.enqueueLegIfAbsent(message, 'hold')).verdict.kind).toBe('admitted');
        await drainUntil(() => origin.channels.r!.sent.length > sentBefore);
        const toUnfrozenGapNack = (fromPeerId: string): ALMessage =>
            newALNackControlMessage(
                { v: 4, msgId: `unfrozen-gap-${fromPeerId}`, ts: Date.now(), senderId: fromPeerId, traceId: message.id.traceId },
                toTestALNackPayload({
                    msgId: message.id.msgId,
                    fromPeerId,
                    toPeerId: 'a',
                    originPeerId: 'a',
                    logicalRecipientPeerId: fromPeerId,
                    reason: 'gap',
                    orderingKey: toALOrderingTrackKey(message),
                    expectedSeq: 2,
                    missingRanges: [{ from: 2, to: 2 }],
                    observedAtEpochMs: Date.now()
                })
            );

        const fromNoNeighbour = await origin.manager.acceptControlMessage(toUnfrozenGapNack('c'));
        const fromNeighbour = await origin.manager.acceptControlMessage(toUnfrozenGapNack('r'));

        expect(origin.channels.r!.sent[sentBefore]?.targets).toMatchObject({ mode: 'broadcast', scope: 'room' });
        expect([fromNoNeighbour.kind, fromNeighbour.kind]).toEqual(['not-handled', 'committed']);
        expect(origin.channels.c!.sent).toEqual([]);
    });

    it('refuses at the relay a gap NACK from the neighbour the message arrived from', async () => {
        const gap = await createGapChain({ ack: 'none' });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1]);
        const revealing = gap.frames[2]!;

        await gap.relay.receive(await toGapNack(gap, { fromPeerId: 'a', logicalRecipientPeerId: 'c', revealing }), 'a');
        await drainUntil(() => false, 20);

        expect(readAdmissionOutcomes(gap.relay, 'leaf-gap-a')).toEqual([['not-handled', 'control']]);
        expect(await gap.relay.readSentControls('a')).toEqual([]);
    });
});

async function createGapChain(input: GapChainInput): Promise<GapChain> {
    const chain = await createOriginRelayChain(GRANTS);
    const pair = createObservedVolatileInboundPair(RELAY_NAMESPACE);
    const relay = createChainHop(chain, {
        selfPeerId: 'r',
        neighbourPeerIds: ['a', ...(input.relayChildPeerIds ?? ['c'])],
        inboundVolatileStores: pair.stores
    });
    const leaf = createChainHop(chain, {
        selfPeerId: 'c',
        neighbourPeerIds: ['r'],
        topicSubscriptions: createRtcTopicSubscriptionsFixture([PUBLICATION_TOPIC_ID])
    });
    const frames: ALMessage[] = [];
    let snapshot = chain.snapshot;
    for (const seq of [1, 2, 3]) {
        const grants = input.grantsBySeq?.[seq];
        if (grants !== undefined) {
            snapshot = toGrantsSnapshot(chain.snapshot, chain.snapshot.group.snapshotVersion + seq, grants);
            chain.origin.groups.accept('room', snapshot);
        }
        frames.push(await publishOrderedFromOrigin({ origin: chain.origin, seq, ack: input.ack, reliability: 'at-least-once' }));
    }
    // The relay and the leaf hold the room the origin froze its last sequence in.
    relay.acceptSnapshot(snapshot);
    leaf.acceptSnapshot(snapshot);
    return { chain, relay, leaf, relayRows: pair.state, frames };
}

/** The relay receives the origin's copies of `seqs`; any other is lost on `a→r`. */
async function forwardTrack(gap: GapChain, seqs: readonly number[]): Promise<void> {
    for (const seq of seqs) {
        await gap.relay.receive(gap.frames[seq - 1]!, 'a');
    }
    const owedToLeaf = seqs.filter((seq) => isFrozenFor(gap.frames[seq - 1]!, 'c'));
    await drainUntil(async () => {
        const forwardedSeqs = (await gap.relay.readSent('c')).map((copy) => copy.ordering?.seq);
        return owedToLeaf.every((seq) => forwardedSeqs.includes(seq));
    });
}

function isFrozenFor(frame: ALMessage, peerId: string): boolean {
    return frame.targets?.mode === 'multicast' && frame.targets.recipientPeerIds?.includes(peerId) === true;
}

/** The leaf receives the relay's forwards of `seqs`; any other is lost on `r→c`. */
async function receiveAtLeaf(gap: GapChain, seqs: readonly number[]): Promise<void> {
    for (const copy of await gap.relay.readSent('c')) {
        if (seqs.includes(copy.ordering?.seq ?? 0)) {
            await gap.leaf.receive(copy, 'r');
        }
    }
}

/** The origin's repair copies reach the relay, and the relay's forwards since then reach the leaf. */
async function repairThroughRelay(gap: GapChain): Promise<void> {
    const toRelay = gap.chain.origin.channels.r!.sent;
    await drainUntil(() => toRelay.length > gap.frames.length);
    const forwardedBefore = (await gap.relay.readSent('c')).length;
    await deliverEach(toRelay.slice(gap.frames.length), gap.relay, 'a');
    await drainUntil(async () => (await gap.relay.readSent('c')).length > forwardedBefore);
    await deliverEach((await gap.relay.readSent('c')).slice(forwardedBefore), gap.leaf, 'r');
    await drainUntil(() => gap.leaf.delivered.length >= gap.frames.length);
}

/** The leaf's controls to the relay, once its gap NACK is among them. */
async function readLeafControls(gap: GapChain): Promise<readonly ALMessage[]> {
    await drainUntil(async () => findGapNack(await gap.leaf.readSent('r')) !== undefined);
    return await gap.leaf.readSent('r');
}

/** The relay's controls to the origin, once a gap NACK it forwarded is among them. */
async function readRelayUpwardControls(gap: GapChain): Promise<readonly ALMessage[]> {
    await drainUntil(async () => findGapNack(await gap.relay.readSent('a')) !== undefined);
    return await gap.relay.readSent('a');
}

/** Feeds the relay's controls to the origin; each NACK's admission outcome, keyed by its reason. */
async function acceptAtOrigin(
    gap: GapChain,
    controls: readonly ALMessage[]
): Promise<ReadonlyMap<string, ALOutboundControlAdmissionResult['kind']>> {
    const outcomes = new Map<string, ALOutboundControlAdmissionResult['kind']>();
    for (const control of controls) {
        const result = await gap.chain.origin.manager.acceptControlMessage(control);
        const parsed = decodeALControlMessage(control).right;
        if (parsed?.type === 'nack') {
            outcomes.set(parsed.payload.reason, result.kind);
        }
    }
    await vi.advanceTimersByTimeAsync(0);
    return outcomes;
}

/** How many frames each link of the chain had carried, so a later step reads only what crossed it since. */
async function readChainLinks(gap: GapChain): Promise<ChainLinks> {
    return {
        originToRelay: gap.chain.origin.channels.r!.sent.length,
        relayToLeaf: (await gap.relay.readSent('c')).length,
        leafToRelay: (await gap.leaf.readSent('r')).length,
        relayToOrigin: (await gap.relay.readSent('a')).length
    };
}

/** Moves the clock `ms` forward in 250 ms steps, running each session's due work at every step. */
async function advanceChainBy(ms: number): Promise<void> {
    for (let advanced = 0; advanced < ms; advanced += CHAIN_STEP_MS) {
        await vi.advanceTimersByTimeAsync(Math.min(CHAIN_STEP_MS, ms - advanced));
        await drainUntil(() => false, 20);
    }
}

/** The number of the gap request `control` makes for `recipientPeerId`; undefined for any other control. */
function readGapRequestNumber(control: ALMessage, recipientPeerId: string): number | undefined {
    const parsed = decodeALControlMessage(control).right;
    return parsed?.type === 'nack' && parsed.payload.reason === 'gap' && parsed.payload.logicalRecipientPeerId === recipientPeerId
        ? parsed.payload.gapRequestNumber
        : undefined;
}

/** The status of each ACK the leaf sent for `message` in its own name. */
function readOwnAcks(controls: readonly ALPeerControlMessage[], message: ALMessage): readonly string[] {
    return controls.flatMap((control) =>
        control.type === 'ack' && control.payload.ackedMsgId === message.id.msgId && control.payload.logicalRecipientPeerId === 'c'
            ? [control.payload.status]
            : []
    );
}

/** The recipients the origin's receipt row for `message` still owes; undefined when it holds no row. */
async function readOriginUnconfirmed(gap: GapChain, message: ALMessage): Promise<readonly string[] | undefined> {
    const receipt = await gap.chain.origin.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId });
    return receipt === undefined ? undefined : toALOutboundReceiptClasses(receipt).unconfirmedPeerIds;
}

/** Feeds each of `controls` to the origin in order, running the work each one queued; each one's admission outcome. */
async function acceptEachAtOrigin(
    gap: GapChain,
    controls: readonly ALMessage[]
): Promise<ReadonlyMap<ALMessage, ALOutboundControlAdmissionResult['kind']>> {
    const outcomes = new Map<ALMessage, ALOutboundControlAdmissionResult['kind']>();
    for (const control of controls) {
        outcomes.set(control, (await gap.chain.origin.manager.acceptControlMessage(control)).kind);
        await drainUntil(() => false, 20);
    }
    return outcomes;
}

function readGapNack(controls: readonly ALMessage[]): GapNackControl {
    const nack = findGapNack(controls);
    if (nack === undefined) {
        throw new Error('The leaf sent no gap NACK');
    }
    return nack;
}

/** The leaf's gap NACK as the message it sent. */
function readGapNackMessage(controls: readonly ALMessage[]): ALMessage {
    const message = controls.find((control) => findGapNack([control]) !== undefined);
    if (message === undefined) {
        throw new Error('The leaf sent no gap NACK');
    }
    return message;
}

function findGapNack(controls: readonly ALMessage[]): GapNackControl | undefined {
    for (const control of controls) {
        const parsed = decodeALControlMessage(control).right;
        if (parsed?.type === 'nack' && parsed.payload.reason === 'gap') {
            return parsed;
        }
    }
    return undefined;
}

/** Each NACK the relay sent, as its control tuple, the track it asks about, and its missing ranges. */
function readRelayedNacks(controls: readonly ALPeerControlMessage[]) {
    return controls.flatMap((control) =>
        control.type === 'nack'
            ? [{
                control: toControlTuples([control])[0],
                orderingKey: control.payload.orderingKey,
                missingRanges: toALSeqRangesText(control.payload.missingRanges ?? [])
            }]
            : []
    );
}

/** The relay's pending row for the message `msgId`, with its expiry, as its store holds it. */
function readRelayRow(gap: GapChain, msgId: string): ALAdmissionStoredValue | undefined {
    return gap.relayRows.data.get(toALInboundControlPendingKey(RELAY_NAMESPACE, msgId, 'a'));
}

function readControlAdmissions(gap: GapChain) {
    return gap.chain.origin.diagnostics.filter((event) => event.kind === 'control-admission');
}

/** Each inbound admission of `msgId` at the session, as its outcome and reason. */
function readAdmissionOutcomes(fixture: RtcRelayOverlayFixture, msgId: string): readonly (readonly [string, string])[] {
    return fixture.diagnostics.flatMap((event) => event.kind === 'admission-outcome' && event.msgId === msgId ? [[event.outcome, event.reason] as const] : []);
}

/** A gap NACK `fromPeerId` sends the relay, asking for seq 2 on the track the leaf entered. */
/** Signed by its sender's own key when the chain keys it; a stranger to the room sends it unsigned. */
async function toGapNack(gap: GapChain, input: GapNackInput): Promise<ALMessage> {
    const { fromPeerId, revealing } = input;
    const nack = { type: 'nack', payload: toGapNackPayload(gap, input) } as const;
    const key = gap.chain.keys[fromPeerId];
    return newALNackControlMessage(
        { v: 4, msgId: input.controlMsgId ?? `leaf-gap-${fromPeerId}`, ts: Date.now(), senderId: fromPeerId, traceId: revealing.id.traceId },
        key === undefined ? nack.payload : (await signTestALReceiptControl(key, nack)).payload
    );
}

function toGapNackPayload(gap: GapChain, input: GapNackInput): ALNackPayload {
    const { fromPeerId, revealing } = input;
    return toTestALNackPayload({
        msgId: revealing.id.msgId,
        fromPeerId,
        toPeerId: 'r',
        originPeerId: revealing.id.senderId,
        logicalRecipientPeerId: input.logicalRecipientPeerId,
        reason: 'gap',
        orderingKey: readLeafTrackKey(gap),
        expectedSeq: 2,
        missingRanges: [{ from: 2, to: 2 }],
        observedAtEpochMs: Date.now()
    });
}

/** The key of the track the leaf entered, as its receive pipeline stated it. */
function readLeafTrackKey(gap: GapChain): string {
    const entered = gap.leaf.diagnostics.find((event) => event.kind === 'ordering-position');
    if (entered?.kind !== 'ordering-position') {
        throw new Error('The leaf entered no track');
    }
    return entered.trackKey;
}
