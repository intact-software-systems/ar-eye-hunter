import { describe, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { isRtcRoomSnapshotRefreshReason } from '@shared/multicast/room-authority/is-rtc-room-snapshot-refresh-reason.ts';
import { RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON } from '@shared/multicast/room-authority/resolve-rtc-room-edge-denial.ts';

import {
    acceptMeshLayout,
    createLayoutMesh,
    exchangeOver,
    exchangeUntilQuiet,
    readAdmissionReasons,
    toAcceptedLayout,
    toOpenEdgePeerIds,
    type LayoutMesh,
    type RoomLayout,
    type TransportCopy
} from './rtc-layout-mesh-fixture.ts';
import {
    createOriginFrame,
    createOriginSnapshot,
    enqueueAndDrain,
    readCopies,
    useFakeClock,
    type FrameReliability
} from './rtc-origin-overlay-fixture.ts';

/**
 * A room's layout promoted twice or more inside one overlap, L1 then L2 then L3. A sender still forwarding over an L1
 * edge reaches a receiver that has replaced L1 and then L2; the receiver admits every replaced layout whose own window
 * is still open. These tests pin what happens to the message: delivered once, and by which path.
 */

/** A layout a session accepts, `atMs` after the room's first promotion. */
interface TimedPromotion {
    readonly layout: RoomLayout;
    readonly atMs: number;
}

/** What one session applies after L1: the layouts it accepts, when, and the layout it holds planned. */
interface SessionLayouts {
    readonly promotions: readonly TimedPromotion[];
    /** Absent, no planned layout is held. */
    readonly planned?: RoomLayout;
}

interface PromotionMeshInput {
    /** The origin `a` and every relay session. */
    readonly sessions: Readonly<Record<string, SessionLayouts>>;
    /** Edges, as `x>y`, whose channel is not open yet at either end. */
    readonly closedEdges: readonly string[];
    /** When the origin sends, after the room's first promotion. */
    readonly sendAtMs: number;
    /** Relay sessions that take each promotion from a group snapshot naming the layout accepted, as the browser does. */
    readonly viaGroupSnapshot?: readonly string[];
    /** How far the one clock is stepped back after the promotions, before the origin sends. */
    readonly clockStepBackMs?: number;
}

interface PromotionMesh extends LayoutMesh {
    readonly viaGroupSnapshot: readonly string[];
}

/** What happened to one frame at the receiver `d`, at its sender `b`, and at the origin. */
interface ReceiverObservation {
    /** The edges the frame's copies crossed into `d` on their first carriage, in carrying order. */
    readonly copiesIntoReceiver: readonly string[];
    /** `d`'s room verdict on each first copy, as `peer kind cause`, judged after the first exchange, before time moves. */
    readonly verdicts: readonly string[];
    /** Every copy of the frame carried into `d`, as `edge@ms` from the send, retries and repairs included. */
    readonly copiesIntoReceiverOverTime: readonly string[];
    readonly admissionReasons: readonly string[];
    readonly deliveredCopies: number;
    /** Every ACK and NACK `d` sent back, as `peer type`. */
    readonly receiverAnswers: readonly string[];
    readonly roomRefreshReasons: readonly string[];
    /** The origin's last settlement that is not an attempt; for a frame with no receipt, none. */
    readonly originOutcome: ALDeliverySettlement | undefined;
}

const SESSION_IDS = ['a', 'b', 'c', 'd', 'g'];

/**
 * The origin `a` parents `b`, `c` and `g` in L1, L2 and L3, so its own fanout does not change, but the subtree that
 * holds the receiver `d` does: `d`'s parent is `b` in L1, `c` in L2, `g` in L3. `b`'s copy to `d` is a relay's copy
 * (its sender is the origin), so `d` judges the edge it crossed; an origin's own copy is never edge-checked.
 */
const L1: RoomLayout = { version: 1, tree: { a: ['b', 'c', 'g'], b: ['a', 'd'], c: ['a'], g: ['a'], d: ['b'] } };
const L2: RoomLayout = { version: 2, tree: { a: ['b', 'c', 'g'], b: ['a'], c: ['a', 'd'], g: ['a'], d: ['c'] } };
const L3: RoomLayout = { version: 3, tree: { a: ['b', 'c', 'g'], b: ['a'], c: ['a'], g: ['a', 'd'], d: ['g'] } };
/** A second promotion back to L1's edges, under a new version. */
const L1_AGAIN: RoomLayout = { version: 3, tree: L1.tree };
/** A third promotion that hangs `d` below `c` again and moves `g` below `b`. */
const L4: RoomLayout = { version: 4, tree: { a: ['b', 'c'], b: ['a', 'g'], c: ['a', 'd'], g: ['b'], d: ['c'] } };
/** A second promotion that leaves `d` below `c` and moves `g` below `b`. */
const L3_KEEPS_D: RoomLayout = { version: 3, tree: { a: ['b', 'c'], b: ['a', 'g'], c: ['a', 'd'], g: ['b'], d: ['c'] } };

/** When the second promotion lands, and the origin sends: one second after the first promotion. */
const SEND_AT_MS = 1_000;

/** When the L3 parent `g` applies L3 in the cases where it lags `d`: two seconds after `d` did. */
const LATE_L3_PARENT_AT_MS = 3_000;

/** Long enough for every receipt timeout, repair and the frame's 30 s lifetime to run out. */
const SETTLE_MS = 45_000;

const EXCHANGE_COPY_BUDGET = 120;

const AWAITED = `not-yet-in-sync: ${RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON}`;

/** The origin's receipt completes with every recipient and every hop confirmed. */
const COMPLETE_AND_CONFIRMED = {
    kind: 'acknowledgement',
    complete: true,
    unconfirmedRecipientPeerIds: [],
    unconfirmedHopPeerIds: []
};

/** Each layout one second after the previous, from the room's first promotion. */
function toSteppedPromotions(...layouts: readonly RoomLayout[]): readonly TimedPromotion[] {
    return layouts.map((layout, index) => ({ layout, atMs: index * SEND_AT_MS }));
}

/** Every edge of every layout the session knows is open (early dial), unless the case closes it. */
function toKnownOpenEdgePeerIds(sessionId: string, layouts: SessionLayouts, closedEdges: readonly string[]): readonly string[] {
    const known = [L1, ...layouts.promotions.map((promotion) => promotion.layout), ...(layouts.planned === undefined ? [] : [layouts.planned])];
    return toOpenEdgePeerIds(sessionId, known.map((layout) => layout.tree))
        .filter((peerId) => !closedEdges.includes(`${sessionId}>${peerId}`) && !closedEdges.includes(`${peerId}>${sessionId}`));
}

interface SenderBehindCase {
    /** What the origin `a` applies; it promotes with the room unless a case says it lags. */
    readonly origin: readonly TimedPromotion[];
    /** What the sender `b` applies: L2 now, inside the first half of its overlap, or nothing (still on L1). */
    readonly sender: readonly TimedPromotion[];
    /** What the L3 parent `g` applies. */
    readonly l3Parent: readonly TimedPromotion[];
    readonly receiver: readonly TimedPromotion[];
    /** Whether `d`'s L2 parent `c` has its edge to `d` open. */
    readonly openL2Edge: boolean;
}

function toSenderBehindCase(input: SenderBehindCase): PromotionMeshInput {
    return {
        sessions: {
            a: { promotions: input.origin },
            b: { promotions: input.sender },
            c: { promotions: toSteppedPromotions(L2) },
            g: { promotions: input.l3Parent },
            d: { promotions: input.receiver }
        },
        closedEdges: input.openL2Edge ? [] : ['c>d'],
        sendAtMs: SEND_AT_MS
    };
}

function applyPromotion(mesh: PromotionMesh, sessionId: string, layout: RoomLayout): void {
    if (!mesh.viaGroupSnapshot.includes(sessionId)) {
        acceptMeshLayout(mesh, sessionId, layout);
        return;
    }
    const accepted = toAcceptedLayout(mesh.snapshot, layout, sessionId);
    mesh.peers.get(sessionId)!.acceptSnapshotPromotion(accepted.snapshot, accepted.overlay);
}

/**
 * Every session starts on L1 with no layout replaced. Each promotion is applied on the one clock the repository stamps
 * transitions with, `atMs` after the room's first promotion; the mesh is returned at `sendAtMs`, and a promotion
 * due later is applied when its time comes.
 */
async function createPromotionMesh(input: PromotionMeshInput): Promise<PromotionMesh> {
    const layoutMesh = createLayoutMesh({
        snapshot: createOriginSnapshot(SESSION_IDS, 4),
        initialTree: L1.tree,
        sessionIds: Object.keys(input.sessions),
        openEdgePeerIds: (sessionId) => toKnownOpenEdgePeerIds(sessionId, input.sessions[sessionId]!, input.closedEdges),
        copyBudget: EXCHANGE_COPY_BUDGET
    });
    for (const [sessionId, peer] of layoutMesh.peers) {
        const planned = input.sessions[sessionId]!.planned;
        if (planned !== undefined) {
            peer.acceptPlannedOverlay(toAcceptedLayout(layoutMesh.snapshot, planned, sessionId).overlay);
        }
    }
    const mesh = { ...layoutMesh, viaGroupSnapshot: input.viaGroupSnapshot ?? [] };
    for (const [sessionId, layouts] of Object.entries(input.sessions)) {
        for (const { layout, atMs } of layouts.promotions) {
            setTimeout(() => applyPromotion(mesh, sessionId, layout), atMs);
        }
    }
    await vi.advanceTimersByTimeAsync(input.sendAtMs);
    if (input.clockStepBackMs !== undefined) {
        vi.setSystemTime(Date.now() - input.clockStepBackMs);
    }
    return mesh;
}

function isFrameCopyInto(copy: TransportCopy, frame: ALMessage, toPeerId: string): boolean {
    return copy.toPeerId === toPeerId && copy.message.id.msgId === frame.id.msgId;
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
async function observeFrame(input: PromotionMeshInput, reliability: FrameReliability): Promise<ReceiverObservation> {
    const mesh = await createPromotionMesh(input);
    const receiver = mesh.peers.get('d')!;
    const frame = createOriginFrame(reliability, 'second-promotion');
    const sentAtMs = Date.now();
    await enqueueAndDrain(mesh.origin.manager, frame);
    const first = await exchangeUntilQuiet(mesh);
    const firstIntoReceiver = first.filter((copy) => isFrameCopyInto(copy, frame, 'd'));
    const verdicts = firstIntoReceiver.map((copy) => {
        const verdict = receiver.readRoomAdmission(copy.message, copy.fromPeerId);
        return `${copy.fromPeerId} ${verdict.kind} ${verdict.kind === 'pending' ? verdict.reason : 'cause' in verdict ? verdict.cause : '-'}`;
    });
    const later = await exchangeOver(mesh, SETTLE_MS);
    const admissionReasons = readAdmissionReasons(receiver, frame);
    return {
        copiesIntoReceiver: firstIntoReceiver.map((copy) => `${copy.fromPeerId}>d`),
        verdicts,
        copiesIntoReceiverOverTime: [...first, ...later]
            .filter((copy) => isFrameCopyInto(copy, frame, 'd'))
            .map((copy) => `${copy.fromPeerId}>d@${copy.carriedAtMs - sentAtMs}`),
        admissionReasons,
        deliveredCopies: readCopies(receiver.delivered, frame),
        receiverAnswers: await readReceiverAnswers(mesh),
        roomRefreshReasons: admissionReasons.filter(isRtcRoomSnapshotRefreshReason),
        originOutcome: mesh.origin.settlements.filter((settlement) => !settlement.kind.startsWith('attempt')).at(-1)
    };
}

function toEdges(copiesOverTime: readonly string[]): readonly string[] {
    return copiesOverTime.map((copy) => copy.split('@')[0]!);
}

/** An at-least-once frame's receipt completes with nothing unconfirmed; a best-effort frame keeps no receipt. */
function expectDeliveredOutcome(observed: ReceiverObservation, reliability: FrameReliability): void {
    if (reliability === 'at-least-once') {
        expect(observed.originOutcome).toMatchObject(COMPLETE_AND_CONFIRMED);
    }
    else {
        expect(observed.originOutcome).toBeUndefined();
    }
}

describe.each([
    { sender: 'inside the first half of its overlap for the first promotion', senderPromotions: toSteppedPromotions(L2) },
    { sender: 'two promotions behind', senderPromotions: [] }
])('a sender $sender, and a receiver that applied both promotions', ({ senderPromotions }) => {
    useFakeClock();

    const ROOM_ON_L3 = toSteppedPromotions(L2, L3);

    it.each(['at-least-once', 'best-effort'] as const)(
        'admits the %s copy over the edge two layouts old, and the message arrives once; the copy over the replaced layout\'s path is a duplicate',
        async (reliability) => {
            const observed = await observeFrame(
                toSenderBehindCase({
                    origin: ROOM_ON_L3,
                    sender: senderPromotions,
                    l3Parent: toSteppedPromotions(L2),
                    receiver: ROOM_ON_L3,
                    openL2Edge: true
                }),
                reliability
            );

            expect(observed.copiesIntoReceiver).toEqual(['b>d', 'c>d']);
            expect(observed.verdicts).toEqual(['b authorized -', 'c authorized -']);
            expect(observed.admissionReasons).toEqual(['admitted', 'duplicate']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['b ack', 'c ack'] : []);
            expect(observed.roomRefreshReasons).toEqual([]);
            expectDeliveredOutcome(observed, reliability);
        }
    );

    // The L2 parent's edge to the receiver is not open yet and the L3 parent applies L3 two seconds after the receiver:
    // the copy over the L1 edge is the only one that reaches it.
    it.each(['at-least-once', 'best-effort'] as const)(
        'admits the %s copy over the edge two layouts old, and with the replaced layout\'s edge not open the message arrives once over it',
        async (reliability) => {
            const observed = await observeFrame(
                toSenderBehindCase({
                    origin: ROOM_ON_L3,
                    sender: senderPromotions,
                    l3Parent: [{ layout: L2, atMs: 0 }, { layout: L3, atMs: LATE_L3_PARENT_AT_MS }],
                    receiver: ROOM_ON_L3,
                    openL2Edge: false
                }),
                reliability
            );

            expect(observed.copiesIntoReceiver).toEqual(['b>d']);
            expect(observed.verdicts).toEqual(['b authorized -']);
            expect(toEdges(observed.copiesIntoReceiverOverTime)).toEqual(['b>d']);
            expect(observed.admissionReasons).toEqual(['admitted']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['b ack'] : []);
            expect(observed.roomRefreshReasons).toEqual([]);
            expectDeliveredOutcome(observed, reliability);
        }
    );

    it.each(['at-least-once', 'best-effort'] as const)(
        'admits the %s copy over the edge two layouts old with the origin still on L1, and the message arrives once with no repair',
        async (reliability) => {
            const observed = await observeFrame(
                toSenderBehindCase({
                    origin: [],
                    sender: senderPromotions,
                    l3Parent: toSteppedPromotions(L2),
                    receiver: ROOM_ON_L3,
                    openL2Edge: false
                }),
                reliability
            );

            expect(toEdges(observed.copiesIntoReceiverOverTime)).toEqual(['b>d']);
            expect(observed.admissionReasons).toEqual(['admitted']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['b ack'] : []);
            expectDeliveredOutcome(observed, reliability);
        }
    );
});

describe('promotions that arrive as group snapshots naming the new accepted layout', () => {
    useFakeClock();

    // The ordinary browser path: each snapshot removes the mismatched accepted layout, then promotes the planned one.
    it.each(['at-least-once', 'best-effort'] as const)(
        'admits the %s copy over the edge two layouts old from a sender two promotions behind, and the message arrives once',
        async (reliability) => {
            const roomOnL3 = toSteppedPromotions(L2, L3);
            const observed = await observeFrame({
                sessions: {
                    a: { promotions: roomOnL3 },
                    b: { promotions: [] },
                    c: { promotions: toSteppedPromotions(L2) },
                    g: { promotions: toSteppedPromotions(L2) },
                    d: { promotions: roomOnL3 }
                },
                closedEdges: ['c>d', 'g>d'],
                sendAtMs: SEND_AT_MS,
                viaGroupSnapshot: ['d']
            }, reliability);

            expect(observed.copiesIntoReceiver).toEqual(['b>d']);
            expect(observed.verdicts).toEqual(['b authorized -']);
            expect(observed.admissionReasons).toEqual(['admitted']);
            expect(observed.deliveredCopies).toBe(1);
            expectDeliveredOutcome(observed, reliability);
        }
    );
});

describe('a receiver whose clock reads before the instant its layout was replaced', () => {
    useFakeClock();

    // A replacement stamped after now is not a replacement in force: only the accepted layout's edges are admitted.
    it.each(['at-least-once', 'best-effort'] as const)(
        'admits the %s copy over the accepted layout\'s edge alone, and refuses the copy over the replaced layout\'s edge',
        async (reliability) => {
            const observed = await observeFrame({
                sessions: {
                    a: { promotions: toSteppedPromotions(L2) },
                    b: { promotions: [] },
                    c: { promotions: toSteppedPromotions(L2) },
                    g: { promotions: toSteppedPromotions(L2) },
                    d: { promotions: toSteppedPromotions(L2) }
                },
                closedEdges: [],
                sendAtMs: SEND_AT_MS,
                clockStepBackMs: 5_000
            }, reliability);

            expect(observed.verdicts).toEqual(['b unauthorized edge-unavailable', 'c authorized -']);
            expect(observed.admissionReasons).toEqual(['unauthorized', 'admitted']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['c ack'] : []);
            expect(observed.roomRefreshReasons).toEqual([]);
        }
    );
});

describe('a second promotion that leaves the receiver\'s parent unchanged', () => {
    useFakeClock();

    // L3_KEEPS_D moves `g`, not `d`, and still replaces `d`'s accepted layout: L1 stays in force beside L2.
    it.each(['at-least-once', 'best-effort'] as const)(
        'admits the %s copy over the edge two layouts old, and with the replaced layout\'s edge not open the message arrives once over it',
        async (reliability) => {
            const keepsD = toSteppedPromotions(L2, L3_KEEPS_D);
            const observed = await observeFrame(
                toSenderBehindCase({
                    origin: keepsD,
                    sender: toSteppedPromotions(L2),
                    l3Parent: toSteppedPromotions(L2),
                    receiver: keepsD,
                    openL2Edge: false
                }),
                reliability
            );

            expect(observed.copiesIntoReceiver).toEqual(['b>d']);
            expect(observed.verdicts).toEqual(['b authorized -']);
            expect(observed.admissionReasons).toEqual(['admitted']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['b ack'] : []);
            expectDeliveredOutcome(observed, reliability);
        }
    );
});

describe('three promotions one second apart, and a relay three promotions behind', () => {
    useFakeClock();

    // The receiver applied L2, L3 and L4; the sender `b` is still on L1, inside L1's own window at the receiver.
    it.each(['at-least-once', 'best-effort'] as const)(
        'admits the %s copy over the edge three layouts old, and the message arrives once over it',
        async (reliability) => {
            const roomOnL4 = toSteppedPromotions(L2, L3, L4);
            const observed = await observeFrame({
                sessions: {
                    a: { promotions: roomOnL4 },
                    b: { promotions: [] },
                    c: { promotions: toSteppedPromotions(L2) },
                    g: { promotions: toSteppedPromotions(L2) },
                    d: { promotions: roomOnL4 }
                },
                closedEdges: ['c>d', 'g>d'],
                sendAtMs: 2 * SEND_AT_MS
            }, reliability);

            expect(observed.copiesIntoReceiver).toEqual(['b>d']);
            expect(observed.verdicts).toEqual(['b authorized -']);
            expect(observed.admissionReasons).toEqual(['admitted']);
            expect(observed.deliveredCopies).toBe(1);
            expectDeliveredOutcome(observed, reliability);
        }
    );
});

describe('the same copy one promotion apart (the control)', () => {
    useFakeClock();

    it.each(
        [
            { reliability: 'at-least-once', sender: 'inside its first half', senderPromotions: toSteppedPromotions(L2) },
            { reliability: 'at-least-once', sender: 'one promotion behind', senderPromotions: [] },
            { reliability: 'best-effort', sender: 'inside its first half', senderPromotions: toSteppedPromotions(L2) },
            { reliability: 'best-effort', sender: 'one promotion behind', senderPromotions: [] }
        ] as const
    )(
        'a receiver that applied one promotion admits the $reliability copy over its replaced layout\'s edge from a sender $sender, and the message arrives once over it',
        async ({ reliability, senderPromotions }) => {
            const observed = await observeFrame(
                toSenderBehindCase({
                    origin: toSteppedPromotions(L2),
                    sender: senderPromotions,
                    l3Parent: toSteppedPromotions(L2),
                    receiver: toSteppedPromotions(L2),
                    openL2Edge: false
                }),
                reliability
            );

            expect(observed.copiesIntoReceiver).toEqual(['b>d']);
            expect(observed.verdicts).toEqual(['b authorized -']);
            expect(observed.admissionReasons).toEqual(['admitted']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['b ack'] : []);
        }
    );
});

describe('a sender that applied both promotions, and a receiver that applied only the first', () => {
    useFakeClock();

    it.each(['at-least-once', 'best-effort'] as const)(
        'answers the %s copy over the edge one layout ahead as not yet in sync, and the message arrives once over the accepted layout\'s edge',
        async (reliability) => {
            const roomOnL3 = toSteppedPromotions(L2, L3);
            const observed = await observeFrame({
                sessions: {
                    a: { promotions: roomOnL3 },
                    b: { promotions: roomOnL3 },
                    c: { promotions: roomOnL3 },
                    g: { promotions: roomOnL3 },
                    d: { promotions: toSteppedPromotions(L2), planned: L3 }
                },
                closedEdges: [],
                sendAtMs: SEND_AT_MS
            }, reliability);

            expect(observed.copiesIntoReceiver).toEqual(['c>d', 'g>d']);
            expect(observed.verdicts).toEqual(['c authorized -', `g pending ${RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON}`]);
            expect(observed.admissionReasons).toEqual(['admitted', AWAITED]);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['c ack', 'g nack'] : ['g nack']);
            expect(observed.roomRefreshReasons).toEqual([]);
        }
    );
});

describe('a second promotion that returns to the first layout\'s edges', () => {
    useFakeClock();

    it.each(['at-least-once', 'best-effort'] as const)(
        'admits the %s copy over the edge the accepted layout names again, and the message arrives once with nothing refused',
        async (reliability) => {
            const backToL1 = toSteppedPromotions(L2, L1_AGAIN);
            const observed = await observeFrame(
                toSenderBehindCase({
                    origin: backToL1,
                    sender: toSteppedPromotions(L2),
                    l3Parent: toSteppedPromotions(L2),
                    receiver: backToL1,
                    openL2Edge: true
                }),
                reliability
            );

            expect(observed.copiesIntoReceiver).toEqual(['b>d', 'c>d']);
            expect(observed.verdicts).toEqual(['b authorized -', 'c authorized -']);
            expect(observed.admissionReasons).toEqual(['admitted', 'duplicate']);
            expect(observed.deliveredCopies).toBe(1);
            expect(observed.receiverAnswers).toEqual(reliability === 'at-least-once' ? ['b ack', 'c ack'] : []);
        }
    );
});
