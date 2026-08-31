import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

export interface RoomTransportFixtureInput {
    readonly roomRef: GroupRef;
    readonly sessionIds: readonly string[];
    readonly acceptedPeerIds: readonly string[];
    readonly version: number;
}

export interface RoomTransportFixture {
    readonly snapshot: GroupSnapshot;
    readonly acceptedOverlay: OverlayInfo;
}

export function createRoomTransportFixture(input: RoomTransportFixtureInput): RoomTransportFixture {
    const base = createGroupSnapshotFixture({
        ...input.roomRef,
        workspaceId: input.roomRef.workspaceId ?? '',
        sessionIds: input.sessionIds
    });
    const causalRevision = { ...base.causalRevision, groupRevision: input.version };
    const snapshot: GroupSnapshot = {
        ...base,
        causalRevision,
        group: {
            ...base.group,
            snapshotVersion: input.version,
            acceptedLayoutIdentity: { ...causalRevision, version: input.version, state: 'active' }
        }
    };
    const acceptedOverlay: OverlayInfo = {
        sourceGroupStateCausalRevision: causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(input.roomRef),
        groupRef: input.roomRef,
        topology: 'tree',
        name: base.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: input.acceptedPeerIds,
        degreeLimit: 2,
        overlayVersion: input.version,
        updatedAtEpochMs: 1
    };
    return { snapshot, acceptedOverlay };
}
