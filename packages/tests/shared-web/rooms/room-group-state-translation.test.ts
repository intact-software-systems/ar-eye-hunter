import { describe, expect, expectTypeOf, it } from 'vitest';

import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import {
    resolveBrowserRoomTransportTarget,
    toRallarRoomFormationStatus,
    toRallarRoomState,
    toRallarRoomSummary
} from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import {
    createActiveGroupMemberFixture,
    createActiveGroupPresenceSessionFixture,
    createClientSnapshotFixture,
    createGroupSnapshotFixture
} from '../authoritative-group-fixtures.ts';
import { createFormationSnapshot, createLayoutOverlay } from './formation/room-formation-test-fixtures.ts';

describe('room state projection translation', () => {
    it('projects active summaries, current selection, ordered members, and snapshot identity', () => {
        const alpha = createRoomSnapshot('alpha', 'Alpha Room', []);
        const selected = createSelectedRoomSnapshot();
        const archivedBase = createRoomSnapshot('archived', 'Archived Room', []);
        const archived: GroupSnapshot = {
            ...archivedBase,
            group: {
                ...archivedBase.group,
                status: 'archived',
                archived: archivedBase.group.updated,
                deleted: null
            }
        };
        const alice = createClient('alice', 'Zulu Display', 'alice');
        const bob = createClient('bob', null, 'Alpha Username');

        const summary = toRallarRoomSummary({
            snapshot: selected,
            sessionId: 'session-1',
            currentRoomRef: selected.group
        });
        const selectedSummary = {
            roomId: 'selected',
            roomRef: selected.group,
            name: 'Beta Room',
            status: 'active',
            kind: 'room',
            joinMode: 'open',
            memberCount: 2,
            onlineMemberCount: 1,
            isJoined: true,
            isCurrent: true,
            snapshot: selected
        } as const;
        expect(summary).toEqual(selectedSummary);
        expect(summary.snapshot).toBe(selected);

        const state = toRallarRoomState({
            groupSnapshots: [selected, archived, alpha],
            clientSnapshots: [bob, alice],
            sessionId: 'session-1',
            currentRoomRef: selected.group,
            currentRoom: selected
        });
        expect(state.rooms).toEqual([
            {
                roomId: 'alpha',
                roomRef: alpha.group,
                name: 'Alpha Room',
                status: 'active',
                kind: 'room',
                joinMode: 'open',
                memberCount: 1,
                onlineMemberCount: 0,
                isJoined: false,
                isCurrent: false,
                snapshot: alpha
            },
            selectedSummary
        ]);
        expect(state.rooms[0]?.snapshot).toBe(alpha);
        expect(state.rooms[1]?.snapshot).toBe(selected);
        expect(state.currentRoomId).toBe('selected');
        expect(state.currentRoomRef).toBe(selected.group);
        expect(state.currentRoom).toBe(selected);
        expect(state.members).toEqual([
            {
                principalId: 'bob',
                username: 'Alpha Username',
                displayName: undefined,
                role: 'member',
                status: 'active',
                isOwner: false,
                isOnline: false,
                sessionIds: [],
                client: bob
            },
            {
                principalId: 'alice',
                username: 'alice',
                displayName: 'Zulu Display',
                role: 'owner',
                status: 'active',
                isOwner: true,
                isOnline: true,
                sessionIds: ['session-1', 'session-2'],
                client: alice
            }
        ]);
        const crossScope = toRallarRoomState({
            groupSnapshots: [alpha],
            clientSnapshots: [bob, alice],
            currentRoomRef: selected.group,
            currentRoom: selected
        });
        expect([crossScope.currentRoom, crossScope.members]).toEqual([selected, state.members]);
        expectTypeOf(toRallarRoomState).returns.toEqualTypeOf<RallarRoomState>();
    });

    it('resolves transport peers and identity only from the accepted server layout', () => {
        const base = createRoomSnapshot(
            'room-1',
            'Room 1',
            ['session-1', 'accepted-peer', 'active-session-not-in-layout']
        );
        const accepted = acceptedOverlay(base, ['session-1', 'accepted-peer']);
        const snapshot: GroupSnapshot = {
            ...base,
            group: {
                ...base.group,
                acceptedLayoutIdentity: {
                    ...accepted.sourceGroupStateCausalRevision,
                    version: accepted.overlayVersion,
                    state: accepted.state
                },
                transportState: 'halted'
            }
        };

        expect(resolveBrowserRoomTransportTarget({
            sessionId: 'session-1',
            snapshot,
            acceptedOverlay: accepted
        })).toEqual({
            transportState: 'halted',
            acceptedLayoutIdentity: snapshot.group.acceptedLayoutIdentity,
            peerIds: ['accepted-peer']
        });
    });

    it('reports no layout identity or peers when the accepted overlay is absent', () => {
        const snapshot = createRoomSnapshot(
            'room-1',
            'Room 1',
            ['session-1', 'active-session-not-in-layout']
        );

        expect(resolveBrowserRoomTransportTarget({
            sessionId: 'session-1',
            snapshot,
            acceptedOverlay: undefined
        })).toEqual({
            transportState: 'flowing',
            peerIds: []
        });
    });

    it('excludes a departed session while its accepted layout is still retained', () => {
        const base = createRoomSnapshot('room-1', 'Room 1', ['session-1', 'remaining-peer']);
        const accepted = acceptedOverlay(base, ['departed-peer', 'remaining-peer']);
        const snapshot: GroupSnapshot = {
            ...base,
            group: {
                ...base.group,
                acceptedLayoutIdentity: {
                    ...accepted.sourceGroupStateCausalRevision,
                    version: accepted.overlayVersion,
                    state: accepted.state
                }
            }
        };

        expect(resolveBrowserRoomTransportTarget({
            sessionId: 'session-1',
            snapshot,
            acceptedOverlay: accepted
        })).toEqual({
            transportState: 'flowing',
            acceptedLayoutIdentity: snapshot.group.acceptedLayoutIdentity,
            peerIds: ['remaining-peer']
        });
    });

    it('projects a formation status from the snapshot and the two layout slots', () => {
        const snapshot = createFormationSnapshot({
            stage: 'reconnecting',
            formationEpoch: 4,
            causalRevision: { groupRevision: 6, presenceRevision: 2 }
        });
        const accepted = createLayoutOverlay({
            roomRef: snapshot.group,
            causalRevision: { groupRevision: 3, presenceRevision: 2 },
            version: 2
        });
        const planned = createLayoutOverlay({
            roomRef: snapshot.group,
            causalRevision: { groupRevision: 6, presenceRevision: 2 },
            version: 5
        });
        const withAcceptedIdentity = {
            ...snapshot,
            group: {
                ...snapshot.group,
                acceptedLayoutIdentity: { groupRevision: 3, presenceRevision: 2, version: 2, state: 'active' as const }
            }
        };

        const status = toRallarRoomFormationStatus({ snapshot: withAcceptedIdentity, planned, accepted });

        expect(status.stage).toBe('reconnecting');
        expect(status.dialing).toBe('accepted-and-planned');
        expect(status.accepted?.identity).toEqual({ groupRevision: 3, presenceRevision: 2, version: 2, state: 'active' });
        expect(status.planned?.identity).toEqual({ groupRevision: 6, presenceRevision: 2, version: 5, state: 'active' });
        expect(status.condition).toBeUndefined();
    });

    it('reports no accepted layout when the slot does not match the snapshot identity, and no planned layout for a tombstone', () => {
        const snapshot = createFormationSnapshot({
            stage: 'active',
            formationEpoch: 2,
            causalRevision: { groupRevision: 3, presenceRevision: 1 }
        });
        const stale = createLayoutOverlay({
            roomRef: snapshot.group,
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
            version: 1
        });
        const tombstone = createLayoutOverlay({
            roomRef: snapshot.group,
            causalRevision: { groupRevision: 3, presenceRevision: 1 },
            version: 4,
            state: 'removed'
        });

        const status = toRallarRoomFormationStatus({ snapshot, planned: tombstone, accepted: stale });

        expect(status.accepted).toBeUndefined();
        expect(status.planned).toBeUndefined();
    });
});

function createRoomSnapshot(
    groupId: string,
    displayName: string,
    sessionIds: readonly string[]
): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        sessionIds
    });
    return { ...snapshot, group: { ...snapshot.group, displayName } };
}

function createSelectedRoomSnapshot(): GroupSnapshot {
    const snapshot = createRoomSnapshot('selected', 'Beta Room', []);
    const scope = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'selected' };
    const member = (principalId: string, role: 'owner' | 'member') =>
        createActiveGroupMemberFixture({ ...scope, principalId, role, actorPrincipalId: 'alice' });
    const presence = (sessionId: string) => createActiveGroupPresenceSessionFixture({ ...scope, principalId: 'alice', sessionId });
    return {
        ...snapshot,
        group: { ...snapshot.group, ownerPrincipalId: 'alice', activeMemberCount: 2 },
        members: [member('alice', 'owner'), member('bob', 'member')],
        activeSessions: [presence('session-1'), presence('session-2')],
        memberCount: 2,
        onlineMemberCount: 1
    };
}

function createClient(
    principalId: string,
    displayName: string | null,
    username: string
): ClientSnapshot {
    const snapshot = createClientSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId
    });
    return {
        ...snapshot,
        principal: { ...snapshot.principal, username, displayName }
    };
}

function acceptedOverlay(
    snapshot: GroupSnapshot,
    nextHopSessionIds: readonly string[]
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: snapshot.causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(snapshot.group),
        groupRef: snapshot.group,
        topology: 'tree',
        name: snapshot.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: [...nextHopSessionIds],
        degreeLimit: 2,
        overlayVersion: 3,
        updatedAtEpochMs: 2
    };
}
