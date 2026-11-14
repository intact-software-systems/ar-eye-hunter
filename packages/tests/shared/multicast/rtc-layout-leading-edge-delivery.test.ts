import { describe, expect, it } from 'vitest';

import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON } from '@shared/multicast/room-authority/resolve-rtc-room-edge-denial.ts';

import {
    acceptMeshLayout,
    createLayoutMesh,
    createOriginFrame,
    DIAMOND_PREVIOUS,
    DIAMOND_PROMOTED,
    DIAMOND_SESSION_IDS,
    exchangeOver,
    exchangeUntilQuiet,
    readAdmissionReasons,
    readCopies,
    toAcceptedLayout,
    toOpenEdgePeerIds,
    toPromotedLayout,
    useFakeClock,
    type LayoutMesh,
    type TransportCopy
} from './rtc-layout-mesh-fixture.ts';
import { createOriginSnapshot, enqueueAndDrain } from './rtc-origin-overlay-fixture.ts';

/**
 * At the leading edge of a promotion a sender that promoted first may send over a new edge that is already open
 * (early dial) to a receiver that has not promoted yet. These tests pin what that receiver answers and what the
 * sender, the relays above it and the origin do with the answer.
 */

interface LeadingEdgeMesh extends LayoutMesh {
    /** Promotes the lagging receiver `d`: its accepted layout becomes the promoted one. */
    promoteReceiver(): void;
}

/** Every copy one exchange may carry before the test fails: a loop that does not stop exceeds it. */
const EXCHANGE_COPY_BUDGET = 120;

const PROMOTED = toPromotedLayout(DIAMOND_PROMOTED);

/**
 * Every session but `d` promoted now; `d` still holds the previous layout accepted and, when `plannedHeld`, the
 * promoted layout planned. Every edge of both layouts is open, as early dial leaves them. The exchange carries the
 * relays' frames in `relayOrder`.
 */
function createLeadingEdgeMesh(plannedHeld: boolean, relayOrder: readonly string[] = ['b', 'c', 'd', 'e']): LeadingEdgeMesh {
    const sessionIds = ['a', ...relayOrder];
    const mesh = createLayoutMesh({
        snapshot: createOriginSnapshot(DIAMOND_SESSION_IDS, 4),
        initialTree: DIAMOND_PREVIOUS,
        sessionIds,
        openEdgePeerIds: (sessionId) => toOpenEdgePeerIds(sessionId, [DIAMOND_PREVIOUS, DIAMOND_PROMOTED]),
        copyBudget: EXCHANGE_COPY_BUDGET
    });
    for (const sessionId of sessionIds.filter((peerId) => peerId !== 'd')) {
        acceptMeshLayout(mesh, sessionId, PROMOTED);
    }
    const receiver = mesh.peers.get('d')!;
    const plannedOverlay = toAcceptedLayout(mesh.snapshot, PROMOTED, 'd').overlay;
    if (plannedHeld) {
        receiver.acceptPlannedOverlay(plannedOverlay);
    }
    return {
        ...mesh,
        promoteReceiver: () => {
            acceptMeshLayout(mesh, 'd', PROMOTED);
            receiver.acceptPlannedOverlay(plannedOverlay);
        }
    };
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

const AWAITED = `not-yet-in-sync: ${RTC_ROOM_LAYOUT_PROMOTION_AWAITED_REASON}`;

describe('a sender that promoted before its receiver, over an edge early dial opened', () => {
    useFakeClock();

    it.each(['at-least-once', 'best-effort'] as const)(
        'delivers every %s frame once and the receiver records no unauthorized refusal',
        async (reliability) => {
            const mesh = createLeadingEdgeMesh(true);
            const frame = createOriginFrame(reliability, 'leading-edge');
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

    // A known gap: the relay's outbound runtime refuses the child's NACK as addressed to another owner (the row's owner
    // is the origin), and its receipt's ack-timeout re-plans find no route, so nothing is re-sent. A relay-side re-send
    // would turn this red.
    it('a relay re-sends nothing on its receiver\'s not-yet-in-sync NACK, and the origin reports that hop unconfirmed', async () => {
        const mesh = createLeadingEdgeMesh(true);
        const frame = createOriginFrame('at-least-once', 'leading-edge-row');
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

    it('a receiver whose planned layout is replaced before promotion refuses the former planned neighbour\'s copy as unauthorized', async () => {
        const mesh = createLeadingEdgeMesh(true);
        const d = mesh.peers.get('d')!;
        d.acceptPlannedOverlay({ ...toAcceptedLayout(mesh.snapshot, PROMOTED, 'd').overlay, overlayVersion: 3, nextHopSessionIds: ['b', 'e'] });
        const frame = createOriginFrame('at-least-once', 'replanned');
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
            const frame = createOriginFrame(reliability, 'new-edge-first');
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

    it('with no planned layout held the receiver refuses the new edge\'s copy as unauthorized and answers it with nothing', async () => {
        const mesh = createLeadingEdgeMesh(false);
        const d = mesh.peers.get('d')!;
        const frame = createOriginFrame('at-least-once', 'unplanned');
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
        const frame = createOriginFrame('at-least-once', 'promoted');
        await enqueueAndDrain(mesh.origin.manager, frame);

        const carried = await exchangeUntilQuiet(mesh);

        const copy = carried.find((sent) => sent.fromPeerId === 'c' && sent.toPeerId === 'd')!.message;
        expect(d.readRoomAdmission(copy, 'c')).toMatchObject({ kind: 'authorized' });
        expect(readAdmissionReasons(d, frame)).not.toContain(AWAITED);
        expect(readCopies(d.delivered, frame)).toBe(1);
    });
});
