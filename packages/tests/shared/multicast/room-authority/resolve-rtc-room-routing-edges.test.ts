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
const authorizedPeerIds = ['self', 'new-parent', 'old-parent', 'both', 'bystander'];

function transition(overrides: Partial<OverlayLayoutTransition> = {}): OverlayLayoutTransition {
    return { replaced, replacedBy: toOverlayLayoutIdentity(accepted), replacedAtEpochMs, ...overrides };
}

function history(overrides: Partial<RtcRoomLayoutHistory> = {}): RtcRoomLayoutHistory {
    return { transition: transition(), replacedLayoutOverlapMs: overlapMs, ...overrides };
}

function input(overrides: Partial<ResolveRtcRoomRoutingEdgesInput> = {}): ResolveRtcRoomRoutingEdgesInput {
    return { roomRef, accepted, history: history(), authorizedPeerIds, nowMs: replacedAtEpochMs + 1, ...overrides };
}

const acceptedAlone = {
    accepted: { neighbourPeerIds: ['new-parent', 'both'], nextHopsBySessionId: accepted.nextHopsBySessionId },
    previous: null,
    admittedEdgePeerIds: ['new-parent', 'stranger', 'both']
};

describe('resolveRtcRoomRoutingEdges', () => {
    it('uses the accepted layout alone when no layout was replaced', () => {
        expect(resolveRtcRoomRoutingEdges(input({ history: history({ transition: null }) }))).toEqual(acceptedAlone);
    });

    it('adds the replaced layout\'s authorized neighbours until the session\'s overlap after the replacement ends', () => {
        for (const nowMs of [replacedAtEpochMs, replacedAtEpochMs + overlapMs - 1]) {
            const edges = resolveRtcRoomRoutingEdges(input({ nowMs }));
            expect(edges.accepted).toEqual(acceptedAlone.accepted);
            expect(edges.previous).toEqual({ neighbourPeerIds: ['old-parent', 'both'], nextHopsBySessionId: replaced.nextHopsBySessionId });
            // A neighbour of both layouts is admitted once; a peer of neither layout is never admitted.
            expect(edges.admittedEdgePeerIds).toEqual(['new-parent', 'stranger', 'both', 'old-parent']);
            expect(edges.admittedEdgePeerIds).not.toContain('bystander');
        }
    });

    it('ends the overlap at its instant, not one millisecond later', () => {
        for (const nowMs of [replacedAtEpochMs + overlapMs, replacedAtEpochMs + overlapMs + 1]) {
            expect(resolveRtcRoomRoutingEdges(input({ nowMs }))).toEqual(acceptedAlone);
        }
    });

    it('with an overlap of zero, routes, relays and admits exactly as over the accepted layout alone', () => {
        const noOverlap = history({ replacedLayoutOverlapMs: 0 });
        for (const nowMs of [replacedAtEpochMs, replacedAtEpochMs + 1]) {
            expect(resolveRtcRoomRoutingEdges(input({ history: noOverlap, nowMs }))).toEqual(
                resolveRtcRoomRoutingEdges(input({ history: history({ transition: null }), nowMs }))
            );
        }
    });

    it('drops the replaced layout once a newer layout is accepted', () => {
        const supersededBy = { ...toOverlayLayoutIdentity(accepted), version: accepted.overlayVersion - 1 };
        expect(resolveRtcRoomRoutingEdges(input({ history: history({ transition: transition({ replacedBy: supersededBy }) }) }))).toEqual(
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
            const edges = resolveRtcRoomRoutingEdges(input({ history: history({ transition: transition({ replaced: replacedLayout }) }) }));
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
                input({ accepted: acceptedLayout, history: history({ transition: transition({ replacedBy }) }) })
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
        for (const layoutHistory of [history(), history({ transition: null })]) {
            const edges = resolveRtcRoomRoutingEdges(input({ history: layoutHistory }));
            expect(edges.admittedEdgePeerIds.slice(0, accepted.nextHopSessionIds.length)).toEqual(accepted.nextHopSessionIds);
            expect(edges.accepted.neighbourPeerIds).not.toContain('stranger');
        }
    });

    it('widens nothing when the replaced layout carries the accepted layout\'s own identity', () => {
        const edges = resolveRtcRoomRoutingEdges(input({ history: history({ transition: transition({ replaced: accepted }) }) }));
        expect(edges).toEqual({ ...acceptedAlone, previous: acceptedAlone.accepted });
    });
});
