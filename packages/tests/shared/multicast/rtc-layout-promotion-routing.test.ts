import { describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import {
    CHAIN_PREVIOUS,
    CHAIN_PROMOTED,
    readCopies,
    toAcceptedLayout,
    toPromotedLayout,
    useFakeClock,
    type AcceptedLayout,
    type FrameReliability,
    type SessionNextHops
} from './rtc-layout-mesh-fixture.ts';
import {
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    SERVED_REPLACED_LAYOUT_OVERLAP_MS
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture, type RtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

/**
 * The server promotes a re-planned layout while a stream runs, with presence unchanged. Each browser switches its
 * routing to the promoted layout at once, while the edges the new layout adds are still being dialled and the edges
 * it drops are still open. These tests state what a viewer of the stream wants across that switch.
 */

const STREAM_SESSION_IDS = ['a', 'b', 'c', 'd'];

const PROMOTED_LAYOUT = toPromotedLayout(CHAIN_PROMOTED);

function readNextHops(tree: SessionNextHops, sessionId: string): readonly string[] {
    return tree[sessionId] ?? [];
}

/**
 * One frame of a position stream, sent many times a second with no receipt. An `at-least-once` frame's failed send is
 * a `planner-drop`; a `best-effort` one fails the same way as `no-route`.
 */
function createPositionFrame(seq: number, reliability: FrameReliability): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'position', resourceId: `frame-${seq}`, contextId: 'room' },
        ORIGIN_ROOM,
        'position.frame.v1',
        { seq },
        { reliability, ack: 'none', ttlMs: 30_000 }
    );
}

describe.each(['at-least-once', 'best-effort'] as const)(
    'routing a %s frame across a layout promotion while the promoted layout\'s new edges are still opening',
    (reliability) => {
        useFakeClock();

        it('a sender keeps delivering over its previous downstream edge until the new layout\'s edge is open', async () => {
            const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
            const origin = createRtcOriginOverlayFixture({
                snapshot,
                nextHopPeerIds: readNextHops(CHAIN_PREVIOUS, 'a'),
                nextHopsBySessionId: CHAIN_PREVIOUS
            });
            const promoted = toAcceptedLayout(snapshot, PROMOTED_LAYOUT, 'a');
            origin.groups.accept('room', promoted.snapshot);
            origin.acceptOverlay(promoted.overlay);
            // The edge to `b` the promoted layout drops is still open; the edge to `c` it adds is not open yet.
            expect(origin.ready.peerIds).toEqual(['b']);

            const frame = createPositionFrame(95, reliability);
            const result = await enqueueAndDrain(origin.manager, frame);

            expect(readCopies(origin.channels.b!.sent, frame), JSON.stringify(result.verdict)).toBe(1);
        });

        it('a receiver accepts a frame from its previous parent until its new parent\'s edge is open', async () => {
            const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
            const origin = createRtcOriginOverlayFixture({
                snapshot,
                nextHopPeerIds: readNextHops(CHAIN_PREVIOUS, 'a'),
                nextHopsBySessionId: CHAIN_PREVIOUS
            });
            const previousParent = createRtcRelayOverlayFixture({
                selfPeerId: 'b',
                snapshot,
                neighbourPeerIds: readNextHops(CHAIN_PREVIOUS, 'b')
            });
            // `c` still holds its edge to its previous parent `b` open, and has promoted the layout that parents it on `a`.
            const receiver = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['b', 'd'] });
            const promoted = toAcceptedLayout(snapshot, PROMOTED_LAYOUT, 'c');
            receiver.acceptSnapshot(promoted.snapshot);
            receiver.acceptOverlay(promoted.overlay);
            const frame = createPositionFrame(95, reliability);
            await enqueueAndDrain(origin.manager, frame);
            await previousParent.receive(origin.channels.b!.sent[0]!, 'a');
            const relayed = (await previousParent.readSent('c')).find((copy) => copy.id.msgId === frame.id.msgId);
            expect(relayed).toBeDefined();

            await receiver.receive(relayed!, 'b');

            expect(readCopies(receiver.delivered, frame), JSON.stringify(receiver.diagnostics.at(-1))).toBe(1);
        });

        it('a relay keeps forwarding to a previous child over the still-open edge until that child\'s new parent edge is open', async () => {
            const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
            const origin = createRtcOriginOverlayFixture({
                snapshot,
                nextHopPeerIds: readNextHops(CHAIN_PREVIOUS, 'a'),
                nextHopsBySessionId: CHAIN_PREVIOUS
            });
            // `b` still holds its edges to its previous parent `a` and child `c` open, and has promoted the layout that
            // makes it a leaf below `d`; `c`'s new parent edge to `a` is not open yet, so `c` still waits on `b`.
            const relay = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: readNextHops(CHAIN_PREVIOUS, 'b') });
            const promoted = toAcceptedLayout(snapshot, PROMOTED_LAYOUT, 'b');
            relay.acceptSnapshot(promoted.snapshot);
            relay.acceptOverlay(promoted.overlay);
            const frame = createPositionFrame(95, reliability);
            await enqueueAndDrain(origin.manager, frame);

            await relay.receive(origin.channels.b!.sent[0]!, 'a');

            expect(readCopies(await relay.readSent('c'), frame), JSON.stringify(relay.diagnostics.at(-1))).toBe(1);
        });
    }
);

/** What the session of `selfPeerId` holds once the snapshot naming the promoted layout reached it before that layout. */
interface SnapshotFirstPromotion {
    readonly session: RtcRelayOverlayFixture;
    readonly promoted: AcceptedLayout;
}

function promoteSnapshotFirst(
    selfPeerId: string,
    snapshot: GroupSnapshot,
    replacedLayoutOverlapMs: number = SERVED_REPLACED_LAYOUT_OVERLAP_MS
): SnapshotFirstPromotion {
    const session = createRtcRelayOverlayFixture({
        selfPeerId,
        snapshot,
        neighbourPeerIds: readNextHops(CHAIN_PREVIOUS, selfPeerId),
        initialOverlay: createOriginOverlay(readNextHops(CHAIN_PREVIOUS, selfPeerId), CHAIN_PREVIOUS),
        replacedLayoutOverlapMs
    });
    const promoted = toAcceptedLayout(snapshot, PROMOTED_LAYOUT, selfPeerId);
    session.acceptSnapshotBeforeLayout(promoted.snapshot);
    return { session, promoted };
}

/** The frame `b` relays to `c` over the previous layout, as `b` forwards the origin's copy. */
async function relayOverPreviousLayout(frame: ALMessage, snapshot: GroupSnapshot): Promise<ALMessage> {
    const origin = createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: readNextHops(CHAIN_PREVIOUS, 'a'),
        nextHopsBySessionId: CHAIN_PREVIOUS
    });
    const previousParent = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: readNextHops(CHAIN_PREVIOUS, 'b') });
    await enqueueAndDrain(origin.manager, frame);
    await previousParent.receive(origin.channels.b!.sent[0]!, 'a');
    const relayed = (await previousParent.readSent('c')).find((copy) => copy.id.msgId === frame.id.msgId);
    expect(relayed).toBeDefined();
    return relayed!;
}

/** The origin's copy of `frame` to `b`, sent over the previous layout. */
async function sendOverPreviousLayout(frame: ALMessage, snapshot: GroupSnapshot): Promise<ALMessage> {
    const origin = createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: readNextHops(CHAIN_PREVIOUS, 'a'),
        nextHopsBySessionId: CHAIN_PREVIOUS
    });
    await enqueueAndDrain(origin.manager, frame);
    return origin.channels.b!.sent[0]!;
}

describe('a promotion a browser learns of snapshot first, before the promoted layout reaches it', () => {
    useFakeClock();

    it('a receiver accepts a frame its previous parent relays once the promoted layout arrives', async () => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const frame = createPositionFrame(96, 'at-least-once');
        const relayed = await relayOverPreviousLayout(frame, snapshot);
        const { session: receiver, promoted } = promoteSnapshotFirst('c', snapshot);
        receiver.acceptOverlay(promoted.overlay);

        await receiver.receive(relayed, 'b');

        expect(readCopies(receiver.delivered, frame), JSON.stringify(receiver.diagnostics.at(-1))).toBe(1);
    });

    it('a relay forwards to its previous child in the first half of the overlap once the promoted layout arrives', async () => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const frame = createPositionFrame(97, 'at-least-once');
        const copy = await sendOverPreviousLayout(frame, snapshot);
        const { session: relay, promoted } = promoteSnapshotFirst('b', snapshot);
        relay.acceptOverlay(promoted.overlay);

        await relay.receive(copy, 'a');

        expect(readCopies(await relay.readSent('c'), frame), JSON.stringify(relay.diagnostics.at(-1))).toBe(1);
    });

    it('counts the overlap from the removal of the replaced layout, not from the promoted layout\'s arrival', async () => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const frame = createPositionFrame(98, 'at-least-once');
        const copy = await sendOverPreviousLayout(frame, snapshot);
        const { session: relay, promoted } = promoteSnapshotFirst('b', snapshot);
        vi.setSystemTime(Date.now() + SERVED_REPLACED_LAYOUT_OVERLAP_MS / 2);
        relay.acceptOverlay(promoted.overlay);

        await relay.receive(copy, 'a');

        expect(readCopies(await relay.readSent('c'), frame)).toBe(0);
    });

    it('while no accepted layout is held, admits and forwards nothing, exactly as for a room with no accepted layout', async () => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const frame = createPositionFrame(99, 'at-least-once');
        const relayed = await relayOverPreviousLayout(frame, snapshot);
        const copy = await sendOverPreviousLayout(frame, snapshot);
        const { session: receiver } = promoteSnapshotFirst('c', snapshot);
        const { session: relay } = promoteSnapshotFirst('b', snapshot);

        expect(receiver.readRoomAdmission(relayed, 'b')).toEqual({
            kind: 'pending',
            reason: 'Awaiting server room relay authority'
        });
        await receiver.receive(relayed, 'b');
        await relay.receive(copy, 'a');

        expect(readCopies(receiver.delivered, frame)).toBe(0);
        expect(readCopies(await relay.readSent('c'), frame)).toBe(0);
    });

    it('while no accepted layout is held, an own send meets the carrier gap, exactly as in a room whose accepted layout is not cached', async () => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const frame = createPositionFrame(105, 'at-least-once');
        const { session: sender, promoted } = promoteSnapshotFirst('a', snapshot);
        const uncached = createRtcRelayOverlayFixture({
            selfPeerId: 'a',
            snapshot,
            neighbourPeerIds: readNextHops(CHAIN_PREVIOUS, 'a'),
            initialOverlay: createOriginOverlay(readNextHops(CHAIN_PREVIOUS, 'a'), CHAIN_PREVIOUS)
        });
        uncached.acceptSnapshot(promoted.snapshot);

        const inGap = await sender.enqueue(frame);
        const withoutLayout = await uncached.enqueue(frame);

        expect(inGap.verdict).toEqual(withoutLayout.verdict);
        expect(inGap.verdict).toMatchObject({
            kind: 'unroutable',
            reason: 'no-route',
            detail: expect.stringContaining('in a carrier gap: RTC room has no cached overlay that is its exact accepted layout')
        });
        expect(readCopies(await sender.readSent('b'), frame)).toBe(0);
    });

    it('a promoted layout that arrives after the overlap has passed leaves nothing in force', async () => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const frame = createPositionFrame(100, 'at-least-once');
        const relayed = await relayOverPreviousLayout(frame, snapshot);
        const { session: receiver, promoted } = promoteSnapshotFirst('c', snapshot);
        vi.setSystemTime(Date.now() + SERVED_REPLACED_LAYOUT_OVERLAP_MS);
        receiver.acceptOverlay(promoted.overlay);

        expect(receiver.readRoomAdmission(relayed, 'b')).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        await receiver.receive(relayed, 'b');

        expect(readCopies(receiver.delivered, frame)).toBe(0);
    });

    it('with an overlap of 0, refuses the previous parent\'s relayed frame as main does', async () => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const frame = createPositionFrame(101, 'at-least-once');
        const relayed = await relayOverPreviousLayout(frame, snapshot);
        const { session: receiver, promoted } = promoteSnapshotFirst('c', snapshot, 0);
        receiver.acceptOverlay(promoted.overlay);

        expect(receiver.readRoomAdmission(relayed, 'b')).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        await receiver.receive(relayed, 'b');

        expect(readCopies(receiver.delivered, frame)).toBe(0);
    });

    it.each([
        {
            change: 'its session leaves the room',
            without: (room: GroupSnapshot): GroupSnapshot => ({
                ...room,
                activeSessions: room.activeSessions.filter((session) => session.sessionId !== 'b')
            })
        },
        {
            change: 'its member is expelled',
            without: (room: GroupSnapshot): GroupSnapshot => ({
                ...room,
                members: room.members.filter((member) => member.principalId !== 'b')
            })
        }
    ])('refuses the previous parent\'s relayed frame when $change between the removal and the arrival', async ({ without }) => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const frame = createPositionFrame(102, 'at-least-once');
        const relayed = await relayOverPreviousLayout(frame, snapshot);
        const { session: receiver, promoted } = promoteSnapshotFirst('c', snapshot);
        receiver.acceptSnapshot(without(promoted.snapshot));
        receiver.acceptOverlay(promoted.overlay);

        expect(receiver.readRoomAdmission(relayed, 'b')).toMatchObject({ kind: 'unauthorized' });
        await receiver.receive(relayed, 'b');

        expect(readCopies(receiver.delivered, frame)).toBe(0);
    });

    it('refuses the previous parent\'s relayed frame when the clock steps back between the removal and the arrival', async () => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const frame = createPositionFrame(103, 'at-least-once');
        const relayed = await relayOverPreviousLayout(frame, snapshot);
        const { session: receiver, promoted } = promoteSnapshotFirst('c', snapshot);
        vi.setSystemTime(Date.now() - 1_000);
        receiver.acceptOverlay(promoted.overlay);

        expect(receiver.readRoomAdmission(relayed, 'b')).toMatchObject({ kind: 'unauthorized', cause: 'edge-unavailable' });
        await receiver.receive(relayed, 'b');

        expect(readCopies(receiver.delivered, frame)).toBe(0);
    });

    it('after the clock steps back by X, the overlap reopens when the reading returns to the removal instant, for the rest of the bound', async () => {
        const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
        const relayed = await relayOverPreviousLayout(createPositionFrame(104, 'at-least-once'), snapshot);
        const removedAtMs = Date.now();
        const { session: receiver, promoted } = promoteSnapshotFirst('c', snapshot);
        receiver.acceptOverlay(promoted.overlay);
        const steppedBackMs = 5_000;

        const admissionAt = (nowMs: number) => {
            vi.setSystemTime(nowMs);
            return receiver.readRoomAdmission(relayed, 'b').kind;
        };

        expect(admissionAt(removedAtMs + 1_000)).toBe('authorized');
        expect(admissionAt(removedAtMs + 1_000 - steppedBackMs)).toBe('unauthorized');
        expect(admissionAt(removedAtMs - 1)).toBe('unauthorized');
        expect(admissionAt(removedAtMs)).toBe('authorized');
        expect(admissionAt(removedAtMs + SERVED_REPLACED_LAYOUT_OVERLAP_MS - 1)).toBe('authorized');
        expect(admissionAt(removedAtMs + SERVED_REPLACED_LAYOUT_OVERLAP_MS)).toBe('unauthorized');
    });
});
