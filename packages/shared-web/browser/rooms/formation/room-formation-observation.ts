import type { OverlayInfo } from '@shared/api/api-config.ts';
import { resolveCoverageBasisLayoutIdentity } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupActivationStatus } from '@shared/api/group-lifecycle/activation-status/group-activation-status.ts';
import { isSameGroupActivationSeries } from '@shared/api/group-lifecycle/activation-status/is-same-group-activation-series.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { resolveDialLayoutRoles } from '@shared/api/group-lifecycle/resolve-dial-layout-roles.ts';
import { toOverlayLayoutIdentity } from '@shared/repository/overlays-repository.ts';

import { isAcceptedRoomLayoutOverlay, isRoomLayoutOverlay } from '../is-room-layout-overlay.ts';
import type { GroupRef, GroupSnapshot } from '../room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from '../room-state-store.ts';
import type {
    RallarRoomFormationStatus,
    RallarRoomLayout,
    RallarRoomLayoutRole
} from './rallar-room-formation-contracts.ts';
import type { RallarRoomLayoutSlotsPort } from './room-layout-slots.ts';

export interface ReadRoomFormationStatusInput {
    readonly roomRef: GroupRef;
    readonly stateStore: RallarRoomStateStorePort;
    readonly slots: RallarRoomLayoutSlotsPort;
}

export interface ToRallarRoomFormationStatusInput {
    readonly snapshot: GroupSnapshot;
    readonly planned: OverlayInfo | undefined;
    readonly accepted: OverlayInfo | undefined;
}

export function readRoomFormationStatus(
    input: ReadRoomFormationStatusInput
): RallarRoomFormationStatus | undefined {
    const snapshot = input.stateStore.findGroupSnapshot(input.roomRef);
    if (!snapshot) {
        return undefined;
    }
    return toRallarRoomFormationStatus({
        snapshot,
        planned: input.slots.readPlanned(input.roomRef),
        accepted: input.slots.readAccepted(input.roomRef)
    });
}

export function toRallarRoomLayout(
    role: RallarRoomLayoutRole,
    overlay: OverlayInfo | undefined,
    roomRef: GroupRef
): RallarRoomLayout | undefined {
    if (!isRoomLayoutOverlay(overlay, roomRef)) {
        return undefined;
    }
    return { role, identity: toOverlayLayoutIdentity(overlay), overlay };
}

export function toRallarRoomFormationStatus(
    input: ToRallarRoomFormationStatusInput
): RallarRoomFormationStatus {
    const { group } = input.snapshot;
    const planned = toRallarRoomLayout('planned', input.planned, group);
    const activation = resolveCurrentActivationStatus(group, planned?.identity);
    return {
        roomRef: group,
        stage: group.lifecycleState,
        formationEpoch: group.formationEpoch,
        formationAttemptCount: group.formationAttemptCount,
        lastFormationOutcome: group.lastFormationOutcome ?? undefined,
        transportState: group.transportState,
        dialing: resolveDialLayoutRoles(group.lifecycleState),
        memberPolicy: group.memberPolicy,
        accepted: isAcceptedRoomLayoutOverlay(input.accepted, group)
            ? toRallarRoomLayout('accepted', input.accepted, group)
            : undefined,
        planned,
        condition: activation?.condition,
        coverageRate: activation?.coverageRate,
        snapshot: input.snapshot
    };
}

/**
 * A stored status describes the series it was measured in (product decision
 * 33); a transition advances the group past it without clearing it, so a
 * spent epoch or a replaced basis says nothing about the live layout.
 */
function resolveCurrentActivationStatus(
    group: GroupSnapshot['group'],
    plannedCandidate: GroupLayoutIdentity | undefined
): GroupActivationStatus | undefined {
    const status = group.activationStatus;
    const basis = resolveCoverageBasisLayoutIdentity({
        lifecycleState: group.lifecycleState,
        accepted: group.acceptedLayoutIdentity ?? undefined,
        plannedCandidate
    });
    if (status === null || basis === undefined) {
        return undefined;
    }
    return isSameGroupActivationSeries(status, {
            formationEpoch: group.formationEpoch,
            coverageBasisLayoutIdentity: basis
        })
        ? status
        : undefined;
}
