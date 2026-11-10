import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALControlMessage,
    newALNackControlMessage,
    type ALNackPayload,
    type ALPeerControlMessage
} from '@shared/al-contracts/al-control.ts';
import { toALSeqRangesText } from '@shared/al-contracts/al-seq-range.ts';
import type { ALAdmissionMemoryState, ALAdmissionStoredValue } from '@shared/alm/al-admission-backend.ts';
import { toALInboundControlPendingKey } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';

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

import { signTestALReceiptControl, toTestALNackPayload } from '../../al-control-test-payloads.ts';

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

interface GapChainInput {
    readonly ack: 'none' | 'receiver';
    /** The relay's children; absent, the leaf alone. */
    readonly relayChildPeerIds?: readonly string[];
    /** The grants the origin's room holds as it freezes a sequence; absent, the chain's own for every sequence. */
    readonly grantsBySeq?: Readonly<Record<number, ChainGrants>>;
}

interface GapNackInput {
    readonly fromPeerId: string;
    readonly logicalRecipientPeerId: string;
    /** The copy whose arrival revealed the gap: the NACK names it. */
    readonly revealing: ALMessage;
}

/** The publish-only relay `r` is frozen into nothing: only the leaf `c` subscribes. */
const GRANTS: ChainGrants = { a: PUBLISH_AND_SUBSCRIBE, r: PUBLISH_ONLY, c: SUBSCRIBE_ONLY };

/** Seq 2 is frozen while the relay holds subscribe and the leaf does not; seq 3 under the chain's own grants again. */
const SEQ_2_WITHOUT_LEAF: Readonly<Record<number, ChainGrants>> = {
    2: { a: PUBLISH_AND_SUBSCRIBE, r: PUBLISH_AND_SUBSCRIBE, c: PUBLISH_ONLY },
    3: GRANTS
};

const RELAY_NAMESPACE = 'relay-gap-repair';

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

    it('leaves the gap NACK of a track without a receipt unhandled at the relay, which keeps no row for it (the limit)', async () => {
        const gap = await createGapChain({ ack: 'none' });
        await forwardTrack(gap, [1, 2, 3]);
        await receiveAtLeaf(gap, [1, 3]);
        const revealing = gap.frames[2]!;

        await gap.relay.receive(await toGapNack(gap, { fromPeerId: 'c', logicalRecipientPeerId: 'c', revealing }), 'c');

        expect(readRelayRow(gap, revealing.id.msgId)).toBeUndefined();
        expect(readAdmissionOutcomes(gap.relay, 'leaf-gap-c')).toEqual([['not-handled', 'control']]);
        expect(await gap.relay.readSentControls('a')).toEqual([]);
        expect(gap.leaf.delivered.map((message) => message.ordering?.seq)).toEqual([1]);
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
        frames.push(await publishOrderedFromOrigin({ origin: chain.origin, seq, ack: input.ack }));
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

function readGapNack(controls: readonly ALMessage[]): GapNackControl {
    const nack = findGapNack(controls);
    if (nack === undefined) {
        throw new Error('The leaf sent no gap NACK');
    }
    return nack;
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
        { v: 4, msgId: `leaf-gap-${fromPeerId}`, ts: Date.now(), senderId: fromPeerId, traceId: revealing.id.traceId },
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
