import {
    describe,
    expect,
    it
} from 'vitest';

import type { OverlayInfo } from '@shared/api/api-config.ts';
import {
    resolveRtcRoomRoutingEdges,
    type ResolveRtcRoomRoutingEdgesInput,
    type RtcRoomLayoutHistory
} from '@shared/multicast/room-authority/resolve-rtc-room-routing-edges.ts';
import type { OverlayLayoutTransition } from '@shared/repository/overlay-layout-transition.ts';
import { toOverlayLayoutIdentity } from '@shared/repository/to-overlay-layout-identity.ts';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const replacedAtEpochMs = 10_000;
const overlapMs = 15_000;
const forwardingHalfMs = 7_500;

function layout(overrides: Partial<OverlayInfo>): OverlayInfo {
    return {
        overlayId: 'room',
        groupRef: roomRef,
        provenance: 'server',
        state: 'active',
        topology: 'tree',
        name: 'Room',
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
        nextHopSessionIds: [],
        nextHopsBySessionId: undefined,
        degreeLimit: 2,
        overlayVersion: 1,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        ...overrides
    };
}

// 'stranger' is a neighbour in the accepted layout but no longer authorized; 'expelled' is the same in the replaced one.
const accepted = layout({
    overlayVersion: 2,
    sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 2 },
    nextHopSessionIds: ['new-parent', 'stranger', 'both'],
    nextHopsBySessionId: { self: ['new-parent', 'stranger', 'both'], 'new-parent': ['self'] }
});
const replaced = layout({
    nextHopSessionIds: ['old-parent', 'both', 'expelled'],
    nextHopsBySessionId: { self: ['old-parent', 'both', 'expelled'], 'old-parent': ['self'] }
});
const authorizedPeerIds = ['self', 'new-parent', 'old-parent', 'both', 'bystander', 'planned-parent', 'oldest-parent'];

function transition(overrides: Partial<OverlayLayoutTransition> = {}): OverlayLayoutTransition {
    return { replaced, replacedBy: toOverlayLayoutIdentity(accepted), replacedAtEpochMs, ...overrides };
}

function history(overrides: Partial<RtcRoomLayoutHistory> = {}): RtcRoomLayoutHistory {
    return { transitions: [transition()], replacedLayoutOverlapMs: overlapMs, planned: null, ...overrides };
}

function input(overrides: Partial<ResolveRtcRoomRoutingEdgesInput> = {}): ResolveRtcRoomRoutingEdgesInput {
    return { roomRef, accepted, history: history(), authorizedPeerIds, nowMs: replacedAtEpochMs + 1, ...overrides };
}

const acceptedAlone = {
    accepted: { neighbourPeerIds: ['new-parent', 'both'], nextHopsBySessionId: accepted.nextHopsBySessionId },
    previous: null,
    admittedEdgePeerIds: ['new-parent', 'stranger', 'both'],
    awaitedEdgePeerIds: []
};

describe('resolveRtcRoomRoutingEdges', () => {
    it('uses the accepted layout alone when no layout was replaced', () => {
        expect(resolveRtcRoomRoutingEdges(input({ history: history({ transitions: [] }) }))).toEqual(acceptedAlone);
    });

    it('adds the replaced layout\'s authorized neighbours from the replacement instant', () => {
        for (const nowMs of [replacedAtEpochMs, replacedAtEpochMs + forwardingHalfMs - 1]) {
            const edges = resolveRtcRoomRoutingEdges(input({ nowMs }));
            expect(edges.accepted).toEqual(acceptedAlone.accepted);
            expect(edges.previous).toEqual({ neighbourPeerIds: ['old-parent', 'both'], nextHopsBySessionId: replaced.nextHopsBySessionId });
            // A neighbour of both layouts is admitted once; a peer of neither layout is never admitted.
            expect(edges.admittedEdgePeerIds).toEqual(['new-parent', 'stranger', 'both', 'old-parent']);
            expect(edges.admittedEdgePeerIds).not.toContain('bystander');
        }
    });

    it('a peer forwards over the replaced layout only for the first half of the overlap', () => {
        expect(resolveRtcRoomRoutingEdges(input({ nowMs: replacedAtEpochMs + forwardingHalfMs - 1 })).previous).toEqual({
            neighbourPeerIds: ['old-parent', 'both'],
            nextHopsBySessionId: replaced.nextHopsBySessionId
        });
        expect(resolveRtcRoomRoutingEdges(input({ nowMs: replacedAtEpochMs + forwardingHalfMs })).previous).toBeNull();
    });

    it('a receiver admits the replaced layout\'s neighbours for the whole overlap', () => {
        for (const nowMs of [replacedAtEpochMs + forwardingHalfMs, replacedAtEpochMs + overlapMs - 1]) {
            expect(resolveRtcRoomRoutingEdges(input({ nowMs })).admittedEdgePeerIds).toEqual(['new-parent', 'stranger', 'both', 'old-parent']);
        }
        expect(resolveRtcRoomRoutingEdges(input({ nowMs: replacedAtEpochMs + overlapMs })).admittedEdgePeerIds).toEqual(
            acceptedAlone.admittedEdgePeerIds
        );
    });

    it('an odd overlap rounds the forwarding half down', () => {
        const oddOverlap = history({ replacedLayoutOverlapMs: 15_001 });
        expect(resolveRtcRoomRoutingEdges(input({ history: oddOverlap, nowMs: replacedAtEpochMs + 7_499 })).previous).not.toBeNull();
        const atHalf = resolveRtcRoomRoutingEdges(input({ history: oddOverlap, nowMs: replacedAtEpochMs + 7_500 }));
        expect(atHalf.previous).toBeNull();
        expect(atHalf.admittedEdgePeerIds).toContain('old-parent');
        expect(resolveRtcRoomRoutingEdges(input({ history: oddOverlap, nowMs: replacedAtEpochMs + 15_000 })).admittedEdgePeerIds).toContain(
            'old-parent'
        );
    });

    it('with an overlap of one millisecond, forwards over the replaced layout never and admits it for that millisecond', () => {
        const oneMillisecond = history({ replacedLayoutOverlapMs: 1 });
        const atReplacement = resolveRtcRoomRoutingEdges(input({ history: oneMillisecond, nowMs: replacedAtEpochMs }));
        expect(atReplacement.previous).toBeNull();
        expect(atReplacement.admittedEdgePeerIds).toEqual(['new-parent', 'stranger', 'both', 'old-parent']);
        expect(resolveRtcRoomRoutingEdges(input({ history: oneMillisecond, nowMs: replacedAtEpochMs + 1 }))).toEqual(acceptedAlone);
    });

    it('ends the overlap at its instant, not one millisecond later', () => {
        for (const nowMs of [replacedAtEpochMs + overlapMs, replacedAtEpochMs + overlapMs + 1]) {
            expect(resolveRtcRoomRoutingEdges(input({ nowMs }))).toEqual(acceptedAlone);
        }
    });

    it('puts no replaced layout in force when now is before the replacement instant', () => {
        for (const nowMs of [replacedAtEpochMs - 1, replacedAtEpochMs - 10 * overlapMs]) {
            expect(resolveRtcRoomRoutingEdges(input({ nowMs }))).toEqual(acceptedAlone);
        }
    });

    it('with an overlap of zero, routes, relays and admits exactly as over the accepted layout alone', () => {
        const noOverlap = history({ replacedLayoutOverlapMs: 0 });
        for (const nowMs of [replacedAtEpochMs - 10 * overlapMs, replacedAtEpochMs - 1, replacedAtEpochMs, replacedAtEpochMs + 1]) {
            expect(resolveRtcRoomRoutingEdges(input({ history: noOverlap, nowMs })).admittedEdgePeerIds).not.toContain('old-parent');
            expect(resolveRtcRoomRoutingEdges(input({ history: noOverlap, nowMs }))).toEqual(
                resolveRtcRoomRoutingEdges(input({ history: history({ transitions: [] }), nowMs }))
            );
        }
    });

    it('drops the replaced layout once a newer layout is accepted', () => {
        const supersededBy = { ...toOverlayLayoutIdentity(accepted), version: accepted.overlayVersion - 1 };
        expect(resolveRtcRoomRoutingEdges(input({ history: history({ transitions: [transition({ replacedBy: supersededBy })] }) }))).toEqual(
            acceptedAlone
        );
    });

    it('never trusts a replaced layout of another room, a removed one, or a bootstrap one', () => {
        const untrusted: readonly OverlayInfo[] = [
            { ...replaced, groupRef: { ...roomRef, workspaceId: 'other' } },
            { ...replaced, state: 'removed' },
            { ...replaced, provenance: 'bootstrap', nextHopsBySessionId: undefined }
        ];
        for (const replacedLayout of untrusted) {
            const edges = resolveRtcRoomRoutingEdges(input({ history: history({ transitions: [transition({ replaced: replacedLayout })] }) }));
            expect(edges.previous).toBeNull();
            expect(edges.admittedEdgePeerIds).not.toContain('old-parent');
        }
    });

    it('forwards over no accepted edge when the accepted layout is not a live server layout of this room', () => {
        const notLive: readonly OverlayInfo[] = [
            { ...accepted, groupRef: { ...roomRef, groupId: 'other' } },
            { ...accepted, state: 'removed' },
            { ...accepted, provenance: 'bootstrap', nextHopsBySessionId: undefined }
        ];
        for (const acceptedLayout of notLive) {
            const replacedBy = toOverlayLayoutIdentity(acceptedLayout);
            const edges = resolveRtcRoomRoutingEdges(
                input({ accepted: acceptedLayout, history: history({ transitions: [transition({ replacedBy })] }) })
            );
            expect(edges.accepted.neighbourPeerIds).toEqual([]);
            expect(edges.previous).toBeNull();
            expect(edges.admittedEdgePeerIds).toEqual(acceptedLayout.nextHopSessionIds);
        }
    });

    it('never admits a replaced neighbour that is not authorized now', () => {
        const edges = resolveRtcRoomRoutingEdges(input());
        expect(edges.previous?.neighbourPeerIds).not.toContain('expelled');
        expect(edges.admittedEdgePeerIds).not.toContain('expelled');
        const removedFromRoom = resolveRtcRoomRoutingEdges(input({ authorizedPeerIds: authorizedPeerIds.filter((peerId) => peerId !== 'old-parent') }));
        expect(removedFromRoom.previous?.neighbourPeerIds).toEqual(['both']);
        expect(removedFromRoom.admittedEdgePeerIds).not.toContain('old-parent');
    });

    it('keeps the accepted edges admission reads today, authorized or not', () => {
        for (const layoutHistory of [history(), history({ transitions: [] })]) {
            const edges = resolveRtcRoomRoutingEdges(input({ history: layoutHistory }));
            expect(edges.admittedEdgePeerIds.slice(0, accepted.nextHopSessionIds.length)).toEqual(accepted.nextHopSessionIds);
            expect(edges.accepted.neighbourPeerIds).not.toContain('stranger');
        }
    });

    it('widens nothing when the replaced layout carries the accepted layout\'s own identity', () => {
        const edges = resolveRtcRoomRoutingEdges(input({ history: history({ transitions: [transition({ replaced: accepted })] }) }));
        expect(edges).toEqual({ ...acceptedAlone, previous: acceptedAlone.accepted });
    });
});

// The layout `replaced` replaced one second before `accepted` replaced it: two promotions old at the second one.
const oldest = layout({
    overlayVersion: 0,
    nextHopSessionIds: ['oldest-parent', 'both'],
    nextHopsBySessionId: { self: ['oldest-parent', 'both'], 'oldest-parent': ['self'] }
});
const oldestReplacedAtEpochMs = replacedAtEpochMs - 1_000;

function oldestTransition(overrides: Partial<OverlayLayoutTransition> = {}): OverlayLayoutTransition {
    return { replaced: oldest, replacedBy: toOverlayLayoutIdentity(replaced), replacedAtEpochMs: oldestReplacedAtEpochMs, ...overrides };
}

/** The history of two promotions one second apart, newest first. */
const twoPromotions = history({ transitions: [transition(), oldestTransition()] });

describe('resolveRtcRoomRoutingEdges over a history of several replaced layouts', () => {
    it('admits the authorized neighbours of every replaced layout whose own window is open', () => {
        for (const nowMs of [replacedAtEpochMs, oldestReplacedAtEpochMs + overlapMs - 1]) {
            expect(resolveRtcRoomRoutingEdges(input({ history: twoPromotions, nowMs })).admittedEdgePeerIds).toEqual([
                'new-parent',
                'stranger',
                'both',
                'old-parent',
                'oldest-parent'
            ]);
        }
    });

    it('stops admitting an older layout at its own bound while a newer one is still admitted', () => {
        const atOldestBound = resolveRtcRoomRoutingEdges(input({ history: twoPromotions, nowMs: oldestReplacedAtEpochMs + overlapMs }));
        expect(atOldestBound.admittedEdgePeerIds).toEqual(['new-parent', 'stranger', 'both', 'old-parent']);
        expect(resolveRtcRoomRoutingEdges(input({ history: twoPromotions, nowMs: replacedAtEpochMs + overlapMs }))).toEqual(
            acceptedAlone
        );
    });

    it('forwards over the most recent replaced layout only', () => {
        for (const nowMs of [replacedAtEpochMs, replacedAtEpochMs + forwardingHalfMs - 1]) {
            expect(resolveRtcRoomRoutingEdges(input({ history: twoPromotions, nowMs })).previous).toEqual({
                neighbourPeerIds: ['old-parent', 'both'],
                nextHopsBySessionId: replaced.nextHopsBySessionId
            });
        }
        expect(resolveRtcRoomRoutingEdges(input({ history: twoPromotions, nowMs: replacedAtEpochMs + forwardingHalfMs })).previous).toBeNull();
    });

    it('an entry outside the chain that ends at the accepted layout, and every entry older than it, is not in force', () => {
        const elsewhere = { ...toOverlayLayoutIdentity(replaced), version: replaced.overlayVersion + 7 };
        const broken = history({ transitions: [transition(), oldestTransition({ replacedBy: elsewhere }), oldestTransition()] });
        expect(resolveRtcRoomRoutingEdges(input({ history: broken })).admittedEdgePeerIds).toEqual([
            'new-parent',
            'stranger',
            'both',
            'old-parent'
        ]);
        const newestOutside = history({ transitions: [transition({ replacedBy: elsewhere }), oldestTransition()] });
        expect(resolveRtcRoomRoutingEdges(input({ history: newestOutside }))).toEqual(acceptedAlone);
    });

    it('a peer no longer authorized is admitted by no layout', () => {
        const withoutOldestParent = authorizedPeerIds.filter((peerId) => peerId !== 'oldest-parent');
        const edges = resolveRtcRoomRoutingEdges(input({ history: twoPromotions, authorizedPeerIds: withoutOldestParent }));
        expect(edges.admittedEdgePeerIds).not.toContain('oldest-parent');
        expect(edges.admittedEdgePeerIds).toContain('old-parent');
    });

    it('a bound of 0 admits the accepted layout alone for any history', () => {
        const noOverlap = history({ transitions: twoPromotions.transitions, replacedLayoutOverlapMs: 0 });
        for (const nowMs of [oldestReplacedAtEpochMs, replacedAtEpochMs, replacedAtEpochMs + 1]) {
            expect(resolveRtcRoomRoutingEdges(input({ history: noOverlap, nowMs }))).toEqual(acceptedAlone);
        }
    });
});

// 'planned-parent' is authorized now and a neighbour only in the receiver's planned layout.
const planned = layout({
    overlayVersion: 3,
    sourceGroupStateCausalRevision: { groupRevision: 3, presenceRevision: 3 },
    nextHopSessionIds: ['planned-parent', 'both'],
    nextHopsBySessionId: { self: ['planned-parent', 'both'], 'planned-parent': ['self'] }
});

describe('resolveRtcRoomRoutingEdges with a planned layout held', () => {
    it('names a planned layout\'s authorized neighbours as awaited, never as admitted', () => {
        const edges = resolveRtcRoomRoutingEdges(input({ history: history({ planned }) }));
        expect(edges.awaitedEdgePeerIds).toEqual(['planned-parent']);
        expect(edges.admittedEdgePeerIds).not.toContain('planned-parent');
        expect(edges.accepted.neighbourPeerIds).not.toContain('planned-parent');
        expect(edges.previous?.neighbourPeerIds).not.toContain('planned-parent');
    });

    it('awaits nobody when no planned layout is held, when it is not a live server layout of this room, or when the peer is not authorized now', () => {
        const notLive: readonly OverlayInfo[] = [
            { ...planned, groupRef: { ...roomRef, groupId: 'other' } },
            { ...planned, state: 'removed' },
            { ...planned, provenance: 'bootstrap', nextHopsBySessionId: undefined }
        ];
        expect(resolveRtcRoomRoutingEdges(input()).awaitedEdgePeerIds).toEqual([]);
        for (const plannedLayout of notLive) {
            expect(resolveRtcRoomRoutingEdges(input({ history: history({ planned: plannedLayout }) })).awaitedEdgePeerIds).toEqual([]);
        }
        const removedFromRoom = authorizedPeerIds.filter((peerId) => peerId !== 'planned-parent');
        expect(resolveRtcRoomRoutingEdges(input({ history: history({ planned }), authorizedPeerIds: removedFromRoom })).awaitedEdgePeerIds)
            .toEqual([]);
    });

    it('a peer that is already admitted is not also awaited', () => {
        const namesAdmitted = layout({ ...planned, nextHopSessionIds: ['new-parent', 'old-parent', 'both'] });
        const edges = resolveRtcRoomRoutingEdges(input({ history: history({ planned: namesAdmitted }) }));
        expect(edges.admittedEdgePeerIds).toEqual(['new-parent', 'stranger', 'both', 'old-parent']);
        expect(edges.awaitedEdgePeerIds).toEqual([]);
    });

    it('right after a promotion the planned slot equals the accepted layout, so nobody is awaited', () => {
        for (const layoutHistory of [history({ planned: accepted }), history({ planned: accepted, transitions: [] })]) {
            expect(resolveRtcRoomRoutingEdges(input({ history: layoutHistory })).awaitedEdgePeerIds).toEqual([]);
        }
    });
});
