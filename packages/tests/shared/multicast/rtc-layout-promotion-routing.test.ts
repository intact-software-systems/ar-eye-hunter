import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import {
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

/**
 * The server promotes a re-planned layout while a stream runs, with presence unchanged. Each browser switches its
 * routing to the promoted layout at once, while the edges the new layout adds are still being dialled and the edges
 * it drops are still open. These tests state what a viewer of the stream wants across that switch; today they fail.
 */

type PositionFrameReliability = 'at-least-once' | 'best-effort';

interface PromotedLayout {
    readonly snapshot: GroupSnapshot;
    readonly overlay: OverlayInfo;
}

type SessionNextHops = Readonly<Record<string, readonly string[]>>;

const STREAM_SESSION_IDS = ['a', 'b', 'c', 'd'];

/** The chain `a`, `b`, `c`, `d` before the re-plan: the origin `a` reaches `c` only through `b`. */
const PREVIOUS_TREE: SessionNextHops = { a: ['b'], b: ['a', 'c'], c: ['b', 'd'], d: ['c'] };

/** The re-planned chain `a`, `c`, `d`, `b`: every edge but `c`-`d` is new, and `a`-`b`, `b`-`c` are dropped. */
const PROMOTED_TREE: SessionNextHops = { a: ['c'], b: ['d'], c: ['a', 'd'], d: ['b', 'c'] };

/** The re-plan keeps the causal revision the fixture's layout was planned from: only the layout version moves. */
const PROMOTED_LAYOUT_IDENTITY = { groupRevision: 1, presenceRevision: 1, version: 2, state: 'active' } as const;

/** The snapshot naming the re-planned layout accepted, and that layout as `selfPeerId` holds it. */
function toPromotedLayout(snapshot: GroupSnapshot, selfPeerId: string): PromotedLayout {
    return {
        snapshot: { ...snapshot, group: { ...snapshot.group, acceptedLayoutIdentity: PROMOTED_LAYOUT_IDENTITY } },
        overlay: {
            ...createOriginOverlay(readNextHops(PROMOTED_TREE, selfPeerId), PROMOTED_TREE),
            overlayVersion: PROMOTED_LAYOUT_IDENTITY.version
        }
    };
}

function readNextHops(tree: SessionNextHops, sessionId: string): readonly string[] {
    return tree[sessionId] ?? [];
}

/**
 * One frame of a position stream, sent many times a second with no receipt. An `at-least-once` frame is the one whose
 * failed send states the hosted runs' `planner-drop`; a `best-effort` one fails the same way as `no-route`.
 */
function createPositionFrame(seq: number, reliability: PositionFrameReliability): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'position', resourceId: `frame-${seq}`, contextId: 'room' },
        ORIGIN_ROOM,
        'position.frame.v1',
        { seq },
        { reliability, ack: 'none', ttlMs: 30_000 }
    );
}

function readCopies(sent: readonly ALMessage[], message: ALMessage): number {
    return sent.filter((copy) => copy.id.msgId === message.id.msgId).length;
}

// The sender and relay cases are pinned as expected failures: Task 7 of the make-before-break slice makes them pass, and it.fails then turns red so the flip is visible.
describe.each(['at-least-once', 'best-effort'] as const)(
    'routing a %s frame across a layout promotion while the promoted layout\'s new edges are still opening',
    (reliability) => {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        });

        afterEach(() => {
            vi.restoreAllMocks();
            vi.useRealTimers();
        });

        it.fails('a sender keeps delivering over its previous downstream edge until the new layout\'s edge is open', async () => {
            const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
            const origin = createRtcOriginOverlayFixture({
                snapshot,
                nextHopPeerIds: readNextHops(PREVIOUS_TREE, 'a'),
                nextHopsBySessionId: PREVIOUS_TREE
            });
            const promoted = toPromotedLayout(snapshot, 'a');
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
                nextHopPeerIds: readNextHops(PREVIOUS_TREE, 'a'),
                nextHopsBySessionId: PREVIOUS_TREE
            });
            const previousParent = createRtcRelayOverlayFixture({
                selfPeerId: 'b',
                snapshot,
                neighbourPeerIds: readNextHops(PREVIOUS_TREE, 'b')
            });
            // `c` still holds its edge to its previous parent `b` open, and has promoted the layout that parents it on `a`.
            const receiver = createRtcRelayOverlayFixture({ selfPeerId: 'c', snapshot, neighbourPeerIds: ['b', 'd'] });
            const promoted = toPromotedLayout(snapshot, 'c');
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

        it.fails('a relay keeps forwarding to a previous child over the still-open edge until that child\'s new parent edge is open', async () => {
            const snapshot = createOriginSnapshot(STREAM_SESSION_IDS, 4);
            const origin = createRtcOriginOverlayFixture({
                snapshot,
                nextHopPeerIds: readNextHops(PREVIOUS_TREE, 'a'),
                nextHopsBySessionId: PREVIOUS_TREE
            });
            // `b` still holds its edges to its previous parent `a` and child `c` open, and has promoted the layout that
            // makes it a leaf below `d`; `c`'s new parent edge to `a` is not open yet, so `c` still waits on `b`.
            const relay = createRtcRelayOverlayFixture({ selfPeerId: 'b', snapshot, neighbourPeerIds: readNextHops(PREVIOUS_TREE, 'b') });
            const promoted = toPromotedLayout(snapshot, 'b');
            relay.acceptSnapshot(promoted.snapshot);
            relay.acceptOverlay(promoted.overlay);
            const frame = createPositionFrame(95, reliability);
            await enqueueAndDrain(origin.manager, frame);

            await relay.receive(origin.channels.b!.sent[0]!, 'a');

            expect(readCopies(await relay.readSent('c'), frame), JSON.stringify(relay.diagnostics.at(-1))).toBe(1);
        });
    }
);
