import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { isRtcRoomSnapshotRefreshReason } from '@shared/multicast/room-authority/is-rtc-room-snapshot-refresh-reason.ts';
import { RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON } from '@shared/multicast/room-authority/resolve-rtc-room-edge-denial.ts';

import {
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    SERVED_REPLACED_LAYOUT_OVERLAP_MS,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

/**
 * A room's layout promoted twice inside one overlap, L1 then L2 then L3. A receiver keeps only the most recent
 * replaced layout, so a sender still forwarding over an L1 edge reaches a receiver that no longer knows it. These
 * tests pin what that costs the message today (Task 9d): delivered once, by which path, or lost.
 */

type Reliability = 'at-least-once' | 'best-effort';
type SessionNextHops = Readonly<Record<string, readonly string[]>>;

interface RoomLayout {
    readonly tree: SessionNextHops;
    readonly version: number;
}

/** What one relay session applied after L1: the layouts it accepted, in order, and the layout it holds planned. */
interface SessionLayouts {
    readonly promotions: readonly RoomLayout[];
    /** Absent, no planned layout is held. */
    readonly planned?: RoomLayout;
}

interface PromotionMeshInput {
    readonly sessions: Readonly<Record<string, SessionLayouts>>;
    /** Edges, as `x>y`, whose channel is not open yet at either end. */
    readonly closedEdges: readonly string[];
}

interface PromotionMesh {
    readonly origin: RtcOriginOverlayFixture;
    readonly peers: ReadonlyMap<string, RtcRelayOverlayFixture>;
    readonly edges: ReadonlyMap<string, readonly string[]>;
    readonly carriedCounts: Map<string, number>;
}

interface TransportCopy {
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly message: ALMessage;
}

/** What happened to one frame at the receiver `d`, at its sender `b`, and at the origin. */
interface ReceiverObservation {
    /** The edges the frame's copies crossed into `d` on their first carriage, in carrying order. */
    readonly copiesIntoReceiver: readonly string[];
    /** `d`'s room verdict on each first copy, as `peer kind cause`, judged when it arrived. */
    readonly verdicts: readonly string[];
    readonly admissionReasons: readonly string[];
    readonly deliveredCopies: number;
    /** Every copy of the frame `b` put on its edge to `d`, repairs included. */
    readonly copiesFromSenderB: number;
    /** Every ACK and NACK `d` sent back, as `peer type`. */
    readonly receiverAnswers: readonly string[];
    readonly roomRefreshReasons: readonly string[];
    /** The origin's last settlement that is not an attempt; for a frame with no receipt, none. */
    readonly originOutcome: ALDeliverySettlement | undefined;
}

const SESSION_IDS = ['a', 'b', 'c', 'd', 'g'];

/**
 * The origin `a` parents `b`, `c` and `g` in every layout, so its own fanout never changes. The receiver `d` changes
 * parent at each promotion: `b` in L1, `c` in L2, `g` in L3. `b`'s copy to `d` is a relay's copy (its sender is the
 * origin), so `d` judges the edge it crossed; an origin's own copy is never edge-checked. Versions start above the
 * fixture's bootstrap overlay, whose identity is version 1, so accepting L1 is a real promotion.
 */
const L1: RoomLayout = { version: 2, tree: { a: ['b', 'c', 'g'], b: ['a', 'd'], c: ['a'], g: ['a'], d: ['b'] } };
const L2: RoomLayout = { version: 3, tree: { a: ['b', 'c', 'g'], b: ['a'], c: ['a', 'd'], g: ['a'], d: ['c'] } };
const L3: RoomLayout = { version: 4, tree: { a: ['b', 'c', 'g'], b: ['a'], c: ['a'], g: ['a', 'd'], d: ['g'] } };
/** A second promotion back to L1's edges, under a new version. */
const L1_AGAIN: RoomLayout = { version: 4, tree: L1.tree };

/** How long after the room's first promotion a session applies its second: inside every window. */
const SECOND_PROMOTION_AFTER_MS = 1_000;

/** Long enough for every receipt timeout, repair and the frame's 30 s lifetime to run out. */
const SETTLE_MS = 45_000;

const EXCHANGE_COPY_BUDGET = 120;

const AWAITED = `not-yet-in-sync: ${RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON}`;

/** The origin's receipt completes, every recipient confirmed; `b`, whose copy `d` refused, stays an unconfirmed hop. */
const COMPLETE_WITH_B_UNCONFIRMED = {
    kind: 'acknowledgement',
    complete: true,
    unconfirmedRecipientPeerIds: [],
    unconfirmedHopPeerIds: ['b']
};

/** The origin's receipt runs out of retries with `d` unconfirmed: what the origin reports upward for a lost frame. */
const EXHAUSTED_WITH_D_UNCONFIRMED = { kind: 'receipt-exhausted', cause: 'budget', unconfirmedPeerIds: ['d'] };

function toLayoutSnapshot(snapshot: GroupSnapshot, layout: RoomLayout): GroupSnapshot {
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 1, version: layout.version, state: 'active' }
        }
    };
}

function toLayoutOverlay(layout: RoomLayout, sessionId: string): OverlayInfo {
    return { ...createOriginOverlay(layout.tree[sessionId] ?? [], layout.tree), overlayVersion: layout.version };
}

function toOpenEdgePeerIds(sessionId: string, layouts: SessionLayouts, closedEdges: readonly string[]): readonly string[] {
    const known = [L1, ...layouts.promotions, ...(layouts.planned === undefined ? [] : [layouts.planned])];
    return [...new Set(known.flatMap((layout) => layout.tree[sessionId] ?? []))]
        .filter((peerId) => !closedEdges.includes(`${sessionId}>${peerId}`) && !closedEdges.includes(`${peerId}>${sessionId}`));
}

/** `b` is the sender: on L2 inside the first half of its overlap (`[L2]`), or still on L1 (`[]`). */
function toSenderBehindCase(
    senderPromotions: readonly RoomLayout[],
    receiverPromotions: readonly RoomLayout[],
    openL2Edge: boolean
): PromotionMeshInput {
    return {
        sessions: {
            b: { promotions: senderPromotions },
            c: { promotions: [L2] },
            g: { promotions: [L2] },
            d: { promotions: receiverPromotions }
        },
        closedEdges: openL2Edge ? [] : ['c>d']
    };
}

/**
 * Every relay session holds L1 for a whole overlap, then applies its first promotion now and its second
 * `SECOND_PROMOTION_AFTER_MS` later, on the one clock the repository stamps transitions with. The origin `a` stays
 * on L1: its edges are the same in every layout.
 */
async function createPromotionMesh(input: PromotionMeshInput): Promise<PromotionMesh> {
    const snapshot = createOriginSnapshot(SESSION_IDS, 4);
    const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: L1.tree.a!, nextHopsBySessionId: L1.tree });
    const edges = new Map<string, readonly string[]>([['a', L1.tree.a!]]);
    const peers = new Map<string, RtcRelayOverlayFixture>();
    for (const [sessionId, layouts] of Object.entries(input.sessions)) {
        const neighbourPeerIds = toOpenEdgePeerIds(sessionId, layouts, input.closedEdges);
        const peer = createRtcRelayOverlayFixture({ selfPeerId: sessionId, snapshot, neighbourPeerIds });
        peer.acceptSnapshot(toLayoutSnapshot(snapshot, L1));
        peer.acceptOverlay(toLayoutOverlay(L1, sessionId));
        peers.set(sessionId, peer);
        edges.set(sessionId, neighbourPeerIds);
    }
    await vi.advanceTimersByTimeAsync(SERVED_REPLACED_LAYOUT_OVERLAP_MS);
    for (const step of [0, 1]) {
        await vi.advanceTimersByTimeAsync(step * SECOND_PROMOTION_AFTER_MS);
        for (const [sessionId, layouts] of Object.entries(input.sessions)) {
            const layout = layouts.promotions[step];
            if (layout !== undefined) {
                peers.get(sessionId)!.acceptSnapshot(toLayoutSnapshot(snapshot, layout));
                peers.get(sessionId)!.acceptOverlay(toLayoutOverlay(layout, sessionId));
            }
        }
    }
    for (const [sessionId, layouts] of Object.entries(input.sessions)) {
        if (layouts.planned !== undefined) {
            peers.get(sessionId)!.acceptPlannedOverlay(toLayoutOverlay(layouts.planned, sessionId));
        }
    }
    return { origin, peers, edges, carriedCounts: new Map() };
}

async function exchangeUntilQuiet(mesh: PromotionMesh): Promise<readonly TransportCopy[]> {
    const carried: TransportCopy[] = [];
    for (let moved = true; moved;) {
        moved = false;
        for (const [fromPeerId, toPeerIds] of mesh.edges) {
            for (const toPeerId of toPeerIds) {
                const key = `${fromPeerId}>${toPeerId}`;
                const sent = fromPeerId === 'a'
                    ? mesh.origin.channels[toPeerId]?.sent ?? []
                    : await mesh.peers.get(fromPeerId)!.readSent(toPeerId);
                const fresh = sent.slice(mesh.carriedCounts.get(key) ?? 0);
                mesh.carriedCounts.set(key, sent.length);
                for (const message of fresh) {
                    carried.push({ fromPeerId, toPeerId, message });
                    expect(carried.length, 'the exchange stops within its copy budget').toBeLessThanOrEqual(EXCHANGE_COPY_BUDGET);
                    await carry(mesh, { fromPeerId, toPeerId, message });
                    moved = true;
                }
            }
        }
    }
    return carried;
}

async function carry(mesh: PromotionMesh, copy: TransportCopy): Promise<void> {
    if (copy.toPeerId !== 'a') {
        await mesh.peers.get(copy.toPeerId)!.receive(copy.message, copy.fromPeerId);
        return;
    }
    if (parseALControlMessage(copy.message) !== undefined) {
        await mesh.origin.manager.acceptControlMessage(copy.message);
    }
}

async function exchangeOver(mesh: PromotionMesh, totalMs: number): Promise<readonly TransportCopy[]> {
    const carried = [...await exchangeUntilQuiet(mesh)];
    for (let elapsedMs = 0; elapsedMs < totalMs; elapsedMs += 500) {
        await vi.advanceTimersByTimeAsync(500);
        carried.push(...await exchangeUntilQuiet(mesh));
    }
    return carried;
}

function isFrameCopyInto(copy: TransportCopy, frame: ALMessage, toPeerId: string): boolean {
    return copy.toPeerId === toPeerId && copy.message.id.msgId === frame.id.msgId;
}

function readAdmissionReasons(peer: RtcRelayOverlayFixture, message: ALMessage): readonly string[] {
    return peer.diagnostics.flatMap((event) => event.kind === 'admission-outcome' && event.msgId === message.id.msgId ? [event.reason] : []);
}

async function readReceiverAnswers(mesh: PromotionMesh): Promise<readonly string[]> {
    const answers: string[] = [];
    const receiver = mesh.peers.get('d')!;
    for (const peerId of mesh.edges.get('d')!) {
        answers.push(...(await receiver.readSentControls(peerId)).map((control) => `${peerId} ${control.type}`));
    }
    return answers;
}

/** Sends one frame from the origin, carries every copy until quiet, then lets every receipt and the frame run out. */
async function observeFrame(input: PromotionMeshInput, reliability: Reliability): Promise<ReceiverObservation> {
    const mesh = await createPromotionMesh(input);
    const receiver = mesh.peers.get('d')!;
    const frame = createFrame(reliability, 'second-promotion');
    await enqueueAndDrain(mesh.origin.manager, frame);
    const first = (await exchangeUntilQuiet(mesh)).filter((copy) => isFrameCopyInto(copy, frame, 'd'));
    const verdicts = first.map((copy) => {
        const verdict = receiver.readRoomAdmission(copy.message, copy.fromPeerId);
        return `${copy.fromPeerId} ${verdict.kind} ${'cause' in verdict ? verdict.cause : '-'}`;
    });
    const later = await exchangeOver(mesh, SETTLE_MS);
    const admissionReasons = readAdmissionReasons(receiver, frame);
    return {
        copiesIntoReceiver: first.map((copy) => `${copy.fromPeerId}>d`),
        verdicts,
        admissionReasons,
        deliveredCopies: receiver.delivered.filter((message) => message.id.msgId === frame.id.msgId).length,
        copiesFromSenderB: [...first, ...later].filter((copy) => copy.fromPeerId === 'b' && isFrameCopyInto(copy, frame, 'd')).length,
        receiverAnswers: await readReceiverAnswers(mesh),
        roomRefreshReasons: admissionReasons.filter(isRtcRoomSnapshotRefreshReason),
        originOutcome: mesh.origin.settlements.filter((settlement) => !settlement.kind.startsWith('attempt')).at(-1)
    };
}

function createFrame(reliability: Reliability, resourceId: string): ALMessage {
    return reliability === 'at-least-once'
        ? createOriginReceiverMulticast(resourceId)
        : newALMulticastMessage(
            'a',
            { topicId: 'position', resourceId, contextId: 'room' },
            ORIGIN_ROOM,
            'position.frame.v1',
            { resourceId },
            { reliability: 'best-effort', ack: 'none', ttlMs: 30_000 }
        );
}

function useFakeClock(): void {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
}

describe.each([
    { sender: 'inside the first half of its overlap for the first promotion (case A)', senderPromotions: [L2] },
    { sender: 'two promotions behind (case B)', senderPromotions: [] }
])('a sender $sender, and a receiver that applied both promotions', ({ senderPromotions }) => {
    useFakeClock();

    it.each(['at-least-once', 'best-effort'] as const)(
        'refuses the %s copy over the edge two layouts old as unauthorized, and the message arrives once over the replaced layout\'s path',
        async (reliability) => {
            const observed = await observeFrame(toSenderBehindCase(senderPromotions, [L2, L3], true), reliability);

            expect(observed.copiesIntoReceiver).toEqual(['b>d', 'c>d']);
            expect(observed.verdicts).toEqual(['b unauthorized edge-unavailable', 'c authorized -']);
            expect(observed.admissionReasons).toEqual(['unauthorized', 'admitted']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.copiesFromSenderB).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['c ack'] : []);
            expect(observed.roomRefreshReasons).toEqual([]);
            expect(observed.originOutcome).toMatchObject(reliability === 'at-least-once' ? COMPLETE_WITH_B_UNCONFIRMED : {});
        }
    );

    // Documents a known gap (Task 9d): the receiver's one replaced-layout slot holds L2 only, so the copy over the L1
    // edge is refused, with no NACK and no room refresh. With the L2 parent's edge to the receiver not open yet and
    // the L3 parent not yet promoted, no other copy reaches it. An at-least-once frame's repairs go out through `b`
    // again inside its first half, and each is refused the same way until the origin's receipt runs out.
    it.each(
        [
            { reliability: 'at-least-once', copiesFromSenderB: 4 },
            { reliability: 'best-effort', copiesFromSenderB: 1 }
        ] as const
    )(
        'refuses every $reliability copy over the edge two layouts old as unauthorized, and with the replaced layout\'s edge not open the message is lost',
        async ({ reliability, copiesFromSenderB }) => {
            const observed = await observeFrame(toSenderBehindCase(senderPromotions, [L2, L3], false), reliability);

            expect(observed.copiesIntoReceiver).toEqual(['b>d']);
            expect(observed.verdicts).toEqual(['b unauthorized edge-unavailable']);
            expect(observed.admissionReasons).toEqual(Array.from({ length: copiesFromSenderB }, () => 'unauthorized'));
            expect(observed.deliveredCopies).toBe(0);
            expect(observed.copiesFromSenderB).toBe(copiesFromSenderB);
            expect(observed.receiverAnswers).toEqual([]);
            expect(observed.roomRefreshReasons).toEqual([]);
            expect(observed.originOutcome).toMatchObject(reliability === 'at-least-once' ? EXHAUSTED_WITH_D_UNCONFIRMED : {});
        }
    );
});

describe('the same copy one promotion apart (the control)', () => {
    useFakeClock();

    it.each(
        [
            { reliability: 'at-least-once', sender: 'inside its first half', senderPromotions: [L2] },
            { reliability: 'at-least-once', sender: 'one promotion behind', senderPromotions: [] },
            { reliability: 'best-effort', sender: 'inside its first half', senderPromotions: [L2] },
            { reliability: 'best-effort', sender: 'one promotion behind', senderPromotions: [] }
        ] as const
    )(
        'a receiver that applied one promotion admits the $reliability copy over its replaced layout\'s edge from a sender $sender, and the message arrives once over it',
        async ({ reliability, senderPromotions }) => {
            const observed = await observeFrame(toSenderBehindCase(senderPromotions, [L2], false), reliability);

            expect(observed.copiesIntoReceiver).toEqual(['b>d']);
            expect(observed.verdicts).toEqual(['b authorized -']);
            expect(observed.admissionReasons).toEqual(['admitted']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['b ack'] : []);
        }
    );
});

describe('a sender that applied both promotions, and a receiver that applied only the first (case C)', () => {
    useFakeClock();

    it.each(['at-least-once', 'best-effort'] as const)(
        'answers the %s copy over the edge one layout ahead as not yet in sync, and the message arrives once over the accepted layout\'s edge',
        async (reliability) => {
            const observed = await observeFrame({
                sessions: {
                    b: { promotions: [L2, L3] },
                    c: { promotions: [L2, L3] },
                    g: { promotions: [L2, L3] },
                    d: { promotions: [L2], planned: L3 }
                },
                closedEdges: []
            }, reliability);

            expect(observed.copiesIntoReceiver).toEqual(['c>d', 'g>d']);
            expect(observed.verdicts).toEqual(['c authorized -', 'g pending layout-promotion-awaited']);
            expect(observed.admissionReasons).toEqual(['admitted', AWAITED]);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['c ack', 'g nack'] : ['g nack']);
            expect(observed.roomRefreshReasons).toEqual([]);
        }
    );
});

describe('a second promotion that returns to the first layout\'s edges (case D)', () => {
    useFakeClock();

    it.each(['at-least-once', 'best-effort'] as const)(
        'admits the %s copy over the edge the accepted layout names again, and the message arrives once with nothing refused',
        async (reliability) => {
            const observed = await observeFrame(toSenderBehindCase([L2], [L2, L1_AGAIN], true), reliability);

            expect(observed.copiesIntoReceiver).toEqual(['b>d', 'c>d']);
            expect(observed.verdicts).toEqual(['b authorized -', 'c authorized -']);
            expect(observed.admissionReasons).toEqual(['admitted', 'duplicate']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['b ack', 'c ack'] : []);
        }
    );
});
