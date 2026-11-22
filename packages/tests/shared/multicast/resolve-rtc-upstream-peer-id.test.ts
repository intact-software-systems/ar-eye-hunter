import { describe, expect, it, onTestFinished } from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOverlayAdjacency } from '@shared/al-contracts/resolve-al-owned-child-peer-ids.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { RtcOutboundObservation } from '@shared/multicast/read-rtc-outbound-observation.ts';
import {
    createRtcInboundRoutes,
    isRtcLayoutChildPeer,
    isRtcRoutedPeerReady,
    resolveRtcRelayParentPeerId
} from '@shared/multicast/resolve-rtc-upstream-peer-id.ts';

import { toAcceptedLayout, type SessionNextHops } from './rtc-layout-mesh-fixture.ts';
import { createOriginOverlay, createOriginSnapshot, ORIGIN_ROOM } from './rtc-origin-overlay-fixture.ts';

const SESSION_IDS = ['a', 'r', 'b', 'c', 'd', 'x'];

/** The layout a reshape replaced: the leaf `c` below the relay `r`. */
const BELOW_R: SessionNextHops = { a: ['r', 'b'], r: ['a', 'c'], b: ['a'], c: ['r'] };

/** The accepted layout: `c` below `b`, with a child `d` of its own. */
const BELOW_B: SessionNextHops = { a: ['r', 'b'], r: ['a'], b: ['a', 'c'], c: ['b', 'd'], d: ['c'] };

/** Another room's accepted layout, in which `b` hangs below `x`. */
const BELOW_X: SessionNextHops = { a: ['x'], x: ['a', 'b'], b: ['x', 'c'], c: ['b'] };

const REPLACED_AT_MS = 1_000_000;
/** The leaf forwards over its replaced layout for the first half: 2 s. */
const OVERLAP_MS = 4_000;

describe('whether the peer a gap was first reported to is still routed over', () => {
    it.each([
        { name: 'the replaced layout\'s neighbour inside the forwarding half', peerId: 'r', connected: ['r', 'b'], elapsedMs: 1_999, routed: true },
        { name: 'the replaced layout\'s neighbour once the forwarding half has ended', peerId: 'r', connected: ['r', 'b'], elapsedMs: 2_000, routed: false },
        { name: 'the replaced layout\'s neighbour that is no longer connected', peerId: 'r', connected: ['b'], elapsedMs: 1_000, routed: false },
        { name: 'an accepted neighbour that is not upstream', peerId: 'd', connected: ['b', 'd'], elapsedMs: 1_000, routed: false }
    ])('$name: $routed', ({ peerId, connected, elapsedMs, routed }) => {
        expect(isRtcRoutedPeerReady(toLeafObservation(connected, elapsedMs), peerId)).toBe(routed);
    });

    it('no peer, without an accepted layout', () => {
        expect(isRtcRoutedPeerReady({ ...toLeafObservation(['r'], 1_000), overlay: undefined }, 'r')).toBe(false);
    });
});

describe('the parent a relay forwards a child\'s gap NACK to when it holds nothing of the message', () => {
    it.each([
        { name: 'the upstream peer toward the origin, for its child', origin: 'a', child: 'c', parent: 'a' },
        { name: 'none for a peer that is not its neighbour', origin: 'a', child: 'r', parent: undefined },
        { name: 'none for its own parent', origin: 'a', child: 'a', parent: undefined },
        { name: 'none for an origin the layout does not place', origin: 'g', child: 'c', parent: undefined }
    ])('$name', ({ origin, child, parent }) => {
        expect(resolveRtcRelayParentPeerId(toRelayRoutes([['room', BELOW_B]], ['a', 'c']), origin, child)).toBe(parent);
    });

    it('one parent for one layout held under two keys', () => {
        expect(resolveRtcRelayParentPeerId(toRelayRoutes([['room', BELOW_B], ['scoped-room', BELOW_B]], ['a', 'c']), 'a', 'c'))
            .toBe('a');
    });

    it('none when two rooms\' layouts name different parents', () => {
        expect(resolveRtcRelayParentPeerId(toRelayRoutes([['room-2', BELOW_X]], ['a', 'c', 'x']), 'a', 'c')).toBe('x');
        expect(resolveRtcRelayParentPeerId(toRelayRoutes([['room', BELOW_B], ['room-2', BELOW_X]], ['a', 'c', 'x']), 'a', 'c'))
            .toBeUndefined();
    });

    it('none when the parent is not connected', () => {
        expect(resolveRtcRelayParentPeerId(toRelayRoutes([['room', BELOW_B]], ['c']), 'a', 'c')).toBeUndefined();
    });
});

describe('whether a peer is this relay\'s child in the accepted layout of the message\'s room', () => {
    it.each([
        { name: 'its neighbour away from the origin', origin: 'a', peerId: 'c', child: true },
        { name: 'not its neighbour toward the origin', origin: 'a', peerId: 'a', child: false },
        { name: 'not a peer that is no neighbour', origin: 'a', peerId: 'r', child: false },
        { name: 'not under an origin the layout does not place', origin: 'g', peerId: 'c', child: false }
    ])('$name', ({ origin, peerId, child }) => {
        expect(isRtcLayoutChildPeer(toALOverlayAdjacency('b', BELOW_B), origin, peerId)).toBe(child);
    });

    it('not without a layout', () => {
        expect(isRtcLayoutChildPeer(undefined, 'a', 'c')).toBe(false);
    });

    it('reads only the message\'s room: a child in another room\'s layout is none here', () => {
        const relayRoutes = toRelayRoutes([['room', BELOW_R], ['room-2', BELOW_X]], ['a', 'c', 'x']);
        const routes = createRtcInboundRoutes(
            {
                groupCache: relayRoutes.rooms,
                overlayCache: relayRoutes.acceptedOverlays,
                connectionService: { input: { sessionId: 'b' }, readyPeerIdsForLane: () => relayRoutes.connectedPeerIds }
            },
            () => toRelayObservation(BELOW_R, relayRoutes.connectedPeerIds)
        );
        const nack = { originPeerId: 'a', fromPeerId: 'c' } as const;

        expect(routes.readGapNackParent?.({ ...toTestNack(), ...nack })).toEqual({ kind: 'rtc-peer', peerId: 'x' });
        expect(routes.isLayoutChildPeer?.(toRoomMessage(), 'c')).toBe(false);
    });
});

/** A message `a` sent in the room `room`. */
function toRoomMessage() {
    return newALMulticastMessage({
        createdAtEpochMs: REPLACED_AT_MS,
        senderId: 'a',
        route: { topicId: 'room.feed', resourceId: 'subject', contextId: ORIGIN_ROOM.groupId },
        groupRef: ORIGIN_ROOM,
        typeId: 'room.feed.v1',
        resource: {},
        options: { ttlMs: 60_000 }
    });
}

function toTestNack() {
    return {
        msgId: 'subject',
        fromPeerId: 'c',
        toPeerId: 'b',
        logicalRecipientPeerId: 'c',
        originPeerId: 'a',
        reason: 'gap',
        observedAtEpochMs: REPLACED_AT_MS,
        proof: null
    } as const;
}

/** The relay `b` holding `tree` accepted in the room `room`. */
function toRelayObservation(tree: SessionNextHops, connectedPeerIds: readonly string[]): RtcOutboundObservation {
    const accepted = toAcceptedLayout(createOriginSnapshot(SESSION_IDS, 3), { tree, version: 2 }, 'b');
    return {
        overlayId: 'room',
        room: accepted.snapshot,
        overlay: accepted.overlay,
        layoutChanges: { transitions: [], replacedLayoutOverlapMs: OVERLAP_MS, planned: null },
        connectedPeerIds,
        nowMs: REPLACED_AT_MS
    };
}

/** The leaf `c`, `elapsedMs` after it promoted `BELOW_B` over `BELOW_R`. */
function toLeafObservation(connectedPeerIds: readonly string[], elapsedMs: number): RtcOutboundObservation {
    const accepted = toAcceptedLayout(createOriginSnapshot(SESSION_IDS, 3), { tree: BELOW_B, version: 2 }, 'c');
    return {
        overlayId: 'room',
        room: accepted.snapshot,
        overlay: accepted.overlay,
        layoutChanges: {
            transitions: [{
                replaced: createOriginOverlay(BELOW_R.c!, BELOW_R),
                replacedBy: accepted.snapshot.group.acceptedLayoutIdentity!,
                replacedAtEpochMs: REPLACED_AT_MS
            }],
            replacedLayoutOverlapMs: OVERLAP_MS,
            planned: null
        },
        connectedPeerIds,
        nowMs: REPLACED_AT_MS + elapsedMs
    };
}

/** The relay `b` holding each `[key, layout]` accepted, each layout in its own room named after its key. */
function toRelayRoutes(layouts: readonly (readonly [string, SessionNextHops])[], connectedPeerIds: readonly string[]) {
    const rooms = new LatestRepository<string, GroupSnapshot>();
    const acceptedOverlays = new LatestRepository<string, OverlayInfo>();
    onTestFinished(() => {
        rooms.dispose();
        acceptedOverlays.dispose();
    });
    for (const [key, tree] of layouts) {
        const groupId = key === 'scoped-room' ? 'room' : key;
        const snapshot = createOriginSnapshot(SESSION_IDS, 3);
        const accepted = toAcceptedLayout(
            { ...snapshot, group: { ...snapshot.group, groupId } },
            { tree, version: 2 },
            'b'
        );
        rooms.accept(groupId, accepted.snapshot);
        acceptedOverlays.accept(key, { ...accepted.overlay, overlayId: groupId, groupRef: { ...ORIGIN_ROOM, groupId } });
    }
    return { rooms, acceptedOverlays, selfPeerId: 'b', connectedPeerIds };
}
