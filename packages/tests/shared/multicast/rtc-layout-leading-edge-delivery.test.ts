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
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON } from '@shared/multicast/room-authority/resolve-rtc-room-edge-denial.ts';

import {
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

/**
 * At the leading edge of a promotion a sender that promoted first may send over a new edge that is already open
 * (early dial) to a receiver that has not promoted yet. These tests pin what that receiver answers and what the
 * sender, the relays above it and the origin do with the answer.
 */

type SessionNextHops = Readonly<Record<string, readonly string[]>>;

interface LeadingEdgeMesh {
    readonly origin: RtcOriginOverlayFixture;
    readonly peers: ReadonlyMap<string, RtcRelayOverlayFixture>;
    readonly edges: ReadonlyMap<string, readonly string[]>;
    readonly carriedCounts: Map<string, number>;
    /** Promotes the lagging receiver `d`: its accepted layout becomes the promoted one. */
    promoteReceiver(): void;
}

interface TransportCopy {
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly message: ALMessage;
}

/** Every copy one exchange may carry before the test fails: a loop that does not stop exceeds it. */
const EXCHANGE_COPY_BUDGET = 120;

const PROMOTED_LAYOUT_IDENTITY = { groupRevision: 1, presenceRevision: 1, version: 2, state: 'active' } as const;

/** `d` has two parents during the overlap: `b` in the replaced layout, `c` in the promoted one; `e` hangs below `d`. */
const DIAMOND_PREVIOUS: SessionNextHops = { a: ['b', 'c'], b: ['a', 'd'], c: ['a'], d: ['b', 'e'], e: ['d'] };
const DIAMOND_PROMOTED: SessionNextHops = { a: ['b', 'c'], b: ['a'], c: ['a', 'd'], d: ['c', 'e'], e: ['d'] };
const SESSION_IDS = ['a', 'b', 'c', 'd', 'e'];

function toPromotedSnapshot(snapshot: GroupSnapshot): GroupSnapshot {
    return { ...snapshot, group: { ...snapshot.group, acceptedLayoutIdentity: PROMOTED_LAYOUT_IDENTITY } };
}

function toPromotedOverlay(sessionId: string): OverlayInfo {
    return { ...createOriginOverlay(DIAMOND_PROMOTED[sessionId] ?? [], DIAMOND_PROMOTED), overlayVersion: PROMOTED_LAYOUT_IDENTITY.version };
}

function toOpenEdgePeerIds(sessionId: string): readonly string[] {
    return [...new Set([...(DIAMOND_PREVIOUS[sessionId] ?? []), ...(DIAMOND_PROMOTED[sessionId] ?? [])])];
}

/**
 * Every session but `d` promoted now; `d` still holds the previous layout accepted and, when `plannedHeld`, the
 * promoted layout planned. Every edge of both layouts is open, as early dial leaves them. The exchange carries the
 * relays' frames in `relayOrder`.
 */
function createLeadingEdgeMesh(plannedHeld: boolean, relayOrder: readonly string[] = ['b', 'c', 'd', 'e']): LeadingEdgeMesh {
    const snapshot = createOriginSnapshot(SESSION_IDS, 4);
    const origin = createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: DIAMOND_PREVIOUS.a ?? [],
        nextHopsBySessionId: DIAMOND_PREVIOUS
    });
    origin.groups.accept('room', toPromotedSnapshot(snapshot));
    origin.acceptOverlay(toPromotedOverlay('a'));
    origin.ready.peerIds = toOpenEdgePeerIds('a');
    const edges = new Map<string, readonly string[]>([['a', toOpenEdgePeerIds('a')]]);
    const peers = new Map<string, RtcRelayOverlayFixture>();
    for (const sessionId of relayOrder) {
        const neighbourPeerIds = toOpenEdgePeerIds(sessionId);
        const initialOverlay = createOriginOverlay(DIAMOND_PREVIOUS[sessionId] ?? [], DIAMOND_PREVIOUS);
        const peer = createRtcRelayOverlayFixture({ selfPeerId: sessionId, snapshot, neighbourPeerIds, initialOverlay });
        if (sessionId !== 'd') {
            peer.acceptSnapshot(toPromotedSnapshot(snapshot));
            peer.acceptOverlay(toPromotedOverlay(sessionId));
        }
        peers.set(sessionId, peer);
        edges.set(sessionId, neighbourPeerIds);
    }
    const receiver = peers.get('d')!;
    if (plannedHeld) {
        receiver.acceptPlannedOverlay(toPromotedOverlay('d'));
    }
    return {
        origin,
        peers,
        edges,
        carriedCounts: new Map(),
        promoteReceiver: () => {
            receiver.acceptSnapshot(toPromotedSnapshot(snapshot));
            receiver.acceptOverlay(toPromotedOverlay('d'));
            receiver.acceptPlannedOverlay(toPromotedOverlay('d'));
        }
    };
}

async function exchangeUntilQuiet(mesh: LeadingEdgeMesh): Promise<readonly TransportCopy[]> {
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
                    const copy = { fromPeerId, toPeerId, message };
                    carried.push(copy);
                    expect(carried.length, 'the exchange stops within its copy budget').toBeLessThanOrEqual(EXCHANGE_COPY_BUDGET);
                    await carry(mesh, copy);
                    moved = true;
                }
            }
        }
    }
    return carried;
}

async function carry(mesh: LeadingEdgeMesh, copy: TransportCopy): Promise<void> {
    if (copy.toPeerId !== 'a') {
        await mesh.peers.get(copy.toPeerId)!.receive(copy.message, copy.fromPeerId);
        return;
    }
    if (parseALControlMessage(copy.message) !== undefined) {
        await mesh.origin.manager.acceptControlMessage(copy.message);
    }
}

/** Exchanges, then lets `totalMs` pass in steps, exchanging after each, and returns everything carried. */
async function exchangeOver(mesh: LeadingEdgeMesh, totalMs: number): Promise<readonly TransportCopy[]> {
    const carried = [...await exchangeUntilQuiet(mesh)];
    for (let elapsedMs = 0; elapsedMs < totalMs; elapsedMs += 500) {
        await vi.advanceTimersByTimeAsync(500);
        carried.push(...await exchangeUntilQuiet(mesh));
    }
    return carried;
}

function readEdgeCounts(carried: readonly TransportCopy[]): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const copy of carried) {
        const control = parseALControlMessage(copy.message);
        const label = control === undefined
            ? `${copy.fromPeerId}>${copy.toPeerId} data`
            : control.type === 'ack'
            ? `${copy.fromPeerId}>${copy.toPeerId} ack ${control.payload.logicalRecipientPeerId} ${control.payload.status}`
            : control.type === 'nack'
            ? `${copy.fromPeerId}>${copy.toPeerId} nack ${control.payload.reason}`
            : `${copy.fromPeerId}>${copy.toPeerId} ${control.type}`;
        counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts;
}

function readCopies(messages: readonly ALMessage[], message: ALMessage): number {
    return messages.filter((sent) => sent.id.msgId === message.id.msgId).length;
}

function readAdmissionReasons(peer: RtcRelayOverlayFixture, message: ALMessage): readonly string[] {
    return peer.diagnostics.flatMap((event) => event.kind === 'admission-outcome' && event.msgId === message.id.msgId ? [event.reason] : []);
}

function createPositionFrame(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'position', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'position.frame.v1',
        { resourceId },
        { reliability: 'best-effort', ack: 'none', ttlMs: 30_000 }
    );
}

function createFrame(reliability: 'at-least-once' | 'best-effort', resourceId: string): ALMessage {
    return reliability === 'at-least-once' ? createOriginReceiverMulticast(resourceId) : createPositionFrame(resourceId);
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

const AWAITED = `not-yet-in-sync: ${RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON}`;

describe('a sender that promoted before its receiver, over an edge early dial opened', () => {
    useFakeClock();

    it.each(['at-least-once', 'best-effort'] as const)(
        'delivers every %s frame once and the receiver records no unauthorized refusal',
        async (reliability) => {
            const mesh = createLeadingEdgeMesh(true);
            const frame = createFrame(reliability, 'leading-edge');
            await enqueueAndDrain(mesh.origin.manager, frame);

            const beforePromotion = await exchangeOver(mesh, 2_000);
            mesh.promoteReceiver();
            const afterPromotion = await exchangeOver(mesh, 2_000);

            const d = mesh.peers.get('d')!;
            // The copy over the previous edge is delivered; the copy over the new edge is answered not yet in sync.
            expect(readAdmissionReasons(d, frame)).toEqual(['admitted', AWAITED]);
            expect(readCopies(d.delivered, frame)).toBe(1);
            for (const peer of mesh.peers.values()) {
                expect(readCopies(peer.delivered, frame)).toBe(1);
            }
            expect(readEdgeCounts(beforePromotion)).toMatchObject({ 'c>d data': 1, 'd>c nack not-yet-in-sync': 1 });
            // The relay re-sends nothing: its outbound runtime refuses its child's NACK as addressed to another owner
            // (rtc-relay-child-not-yet-in-sync.test.ts).
            expect(readEdgeCounts(afterPromotion)['c>d data']).toBeUndefined();
        }
    );

    // A known gap, the same as on the task base, where the copy ended unauthorized with no NACK: the relay's outbound
    // runtime refuses the child's NACK as addressed to another owner (the row's owner is the origin), and its receipt's
    // ack-timeout re-plans find no route, so nothing is re-sent. A relay-side re-send would turn this red.
    it('a relay re-sends nothing on its receiver\'s not-yet-in-sync NACK, and the origin reports that hop unconfirmed', async () => {
        const mesh = createLeadingEdgeMesh(true);
        const frame = createFrame('at-least-once', 'leading-edge-row');
        await enqueueAndDrain(mesh.origin.manager, frame);

        const carried = await exchangeOver(mesh, 45_000);

        const counts = readEdgeCounts(carried);
        expect(counts['c>d data']).toBe(1);
        expect(counts['d>c nack not-yet-in-sync']).toBe(1);
        expect(Object.keys(counts).filter((edge) => edge.startsWith('c>a') || edge.startsWith('d>c'))).toEqual([
            'c>a ack c accepted',
            'd>c nack not-yet-in-sync'
        ]);
        expect(mesh.origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1))
            .toMatchObject({ complete: true, unconfirmedRecipientPeerIds: [], unconfirmedHopPeerIds: ['c'] });
    });

    it('a receiver whose planned layout is replaced before promotion refuses the former planned neighbour\'s copy as today', async () => {
        const mesh = createLeadingEdgeMesh(true);
        const d = mesh.peers.get('d')!;
        d.acceptPlannedOverlay({ ...toPromotedOverlay('d'), overlayVersion: 3, nextHopSessionIds: ['b', 'e'] });
        const frame = createFrame('at-least-once', 'replanned');
        await enqueueAndDrain(mesh.origin.manager, frame);

        const carried = await exchangeUntilQuiet(mesh);

        const copy = carried.find((sent) => sent.fromPeerId === 'c' && sent.toPeerId === 'd')!.message;
        expect(d.readRoomAdmission(copy, 'c')).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        expect(readAdmissionReasons(d, frame)).toEqual(['admitted', 'unauthorized']);
        expect(readEdgeCounts(carried)['d>c nack not-yet-in-sync']).toBeUndefined();
    });

    it.each(['at-least-once', 'best-effort'] as const)(
        'a %s copy over the new edge that arrives first is answered not yet in sync, and the previous edge delivers the frame once',
        async (reliability) => {
            const mesh = createLeadingEdgeMesh(true, ['c', 'b', 'd', 'e']);
            const frame = createFrame(reliability, 'new-edge-first');
            await enqueueAndDrain(mesh.origin.manager, frame);

            const carried = await exchangeUntilQuiet(mesh);

            const d = mesh.peers.get('d')!;
            const edgesIntoD = carried
                .filter((copy) => copy.toPeerId === 'd' && copy.message.id.msgId === frame.id.msgId)
                .map((copy) => `${copy.fromPeerId}>d`);
            expect(edgesIntoD).toEqual(['c>d', 'b>d']);
            expect(readAdmissionReasons(d, frame)).toEqual([AWAITED, 'admitted']);
            expect(readCopies(d.delivered, frame)).toBe(1);
            expect(readCopies(mesh.peers.get('e')!.delivered, frame)).toBe(1);
        }
    );

    it('with no planned layout held the receiver behaves exactly as before', async () => {
        const mesh = createLeadingEdgeMesh(false);
        const d = mesh.peers.get('d')!;
        const frame = createFrame('at-least-once', 'unplanned');
        await enqueueAndDrain(mesh.origin.manager, frame);

        const carried = await exchangeUntilQuiet(mesh);

        const copy = carried.find((sent) => sent.fromPeerId === 'c' && sent.toPeerId === 'd')!.message;
        expect(d.readRoomAdmission(copy, 'c')).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        expect(readAdmissionReasons(d, frame)).toEqual(['admitted', 'unauthorized']);
        expect(readCopies(d.delivered, frame)).toBe(1);
        expect(Object.keys(readEdgeCounts(carried)).filter((edge) => edge.startsWith('d>c'))).toEqual([]);
    });

    it('right after its own promotion the receiver admits the new edge, since its planned slot equals its accepted layout', async () => {
        const mesh = createLeadingEdgeMesh(true);
        mesh.promoteReceiver();
        const d = mesh.peers.get('d')!;
        const frame = createFrame('at-least-once', 'promoted');
        await enqueueAndDrain(mesh.origin.manager, frame);

        const carried = await exchangeUntilQuiet(mesh);

        const copy = carried.find((sent) => sent.fromPeerId === 'c' && sent.toPeerId === 'd')!.message;
        expect(d.readRoomAdmission(copy, 'c')).toMatchObject({ kind: 'authorized' });
        expect(readAdmissionReasons(d, frame)).not.toContain(AWAITED);
        expect(readCopies(d.delivered, frame)).toBe(1);
    });
});
