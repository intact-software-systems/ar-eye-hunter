import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';

export interface FormationSnapshotFixtureInput {
    readonly stage: GroupLifecycleState;
    readonly formationEpoch: number;
    readonly causalRevision: GroupStateCausalRevision;
    readonly sessionIds?: readonly string[];
}

export function createFormationSnapshot(input: FormationSnapshotFixtureInput): GroupSnapshot {
    const base = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        sessionIds: input.sessionIds ?? ['session-1']
    });
    return {
        ...base,
        causalRevision: input.causalRevision,
        group: {
            ...base.group,
            snapshotVersion: input.causalRevision.groupRevision,
            presenceVersion: input.causalRevision.presenceRevision,
            lifecycleState: input.stage,
            formationEpoch: input.formationEpoch
        }
    };
}

export interface LayoutOverlayFixtureInput {
    readonly roomRef: GroupRef;
    readonly causalRevision: GroupStateCausalRevision;
    readonly version: number;
    readonly state?: OverlayInfo['state'];
    readonly provenance?: OverlayInfo['provenance'];
    readonly peerIds?: readonly string[];
}

export function createLayoutOverlay(input: LayoutOverlayFixtureInput): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: input.causalRevision,
        provenance: input.provenance ?? 'server',
        state: input.state ?? 'active',
        overlayId: toScopedOverlayId(input.roomRef),
        groupRef: input.roomRef,
        topology: 'tree',
        name: input.roomRef.groupId,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: input.peerIds ?? ['peer-a'],
        degreeLimit: 2,
        overlayVersion: input.version,
        updatedAtEpochMs: 1
    };
}
