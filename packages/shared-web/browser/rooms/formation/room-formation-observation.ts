import { notifyListener } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type {
    RallarOnChangeOptions,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { isSameGroupRef, toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { resolveCoverageBasisLayoutIdentity } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupActivationStatus } from '@shared/api/group-lifecycle/activation-status/group-activation-status.ts';
import { isSameGroupActivationSeries } from '@shared/api/group-lifecycle/activation-status/is-same-group-activation-series.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';
import { resolveDialLayoutRoles } from '@shared/api/group-lifecycle/resolve-dial-layout-roles.ts';
import { toOverlayLayoutIdentity, type OverlayRepositoryChange } from '@shared/repository/overlays-repository.ts';

import { isAcceptedRoomLayoutOverlay, isRoomLayoutOverlay } from '../is-room-layout-overlay.ts';
import type { GroupRef, GroupSnapshot } from '../room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from '../room-state-store.ts';
import type {
    RallarRoomFormationStatus,
    RallarRoomLayout,
    RallarRoomLayoutEvent,
    RallarRoomLayoutListener,
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

/** The three cache reads a status is projected from; the caches replace objects on every change. */
interface RoomFormationObservation {
    readonly snapshot: GroupSnapshot | undefined;
    readonly planned: OverlayInfo | undefined;
    readonly accepted: OverlayInfo | undefined;
}

export function readRoomFormationStatus(
    input: ReadRoomFormationStatusInput
): RallarRoomFormationStatus | undefined {
    return toRoomFormationStatusFromObservation(readRoomFormationObservation(input));
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

/** Wakes on a cache change naming the bound room; the snapshot alone decides stage and condition. */
export function subscribeRoomSnapshot(
    input: ReadRoomFormationStatusInput,
    listener: () => void | Promise<void>
): RallarUnsubscribe {
    return input.stateStore.onCacheChange((change) => {
        if (change.groups.some((snapshot) => isSameGroupRef(snapshot.group, input.roomRef))) {
            return listener();
        }
    });
}

/** Wakes on the bound room's snapshot or on either of its layout slots. */
export function subscribeRoomFormation(
    input: ReadRoomFormationStatusInput,
    listener: () => void | Promise<void>
): RallarUnsubscribe {
    const overlayId = toScopedOverlayId(input.roomRef);
    const onSlotChange = (change: OverlayRepositoryChange) => change.overlayId === overlayId ? listener() : undefined;
    return subscribeAll([
        () => input.slots.onPlannedChange(onSlotChange),
        () => input.slots.onAcceptedChange(onSlotChange),
        () => subscribeRoomSnapshot(input, listener)
    ]);
}

/**
 * Emits the status on every observable change of the snapshot or either
 * layout slot. A room leaving the cache emits nothing here; `rooms.onChange`
 * reports that, since a status cannot represent absence.
 */
export function subscribeRoomFormationChanges(
    input: ReadRoomFormationStatusInput,
    listener: RallarStateListener<RallarRoomFormationStatus>,
    options: RallarOnChangeOptions
): RallarUnsubscribe {
    let lastObservation = readRoomFormationObservation(input);
    let last = toRoomFormationStatusFromObservation(lastObservation);
    if ((options.emitCurrent ?? true) && last !== undefined) {
        notifyListener(listener, last);
    }
    return subscribeRoomFormation(input, () => {
        const observation = readRoomFormationObservation(input);
        if (isSameRoomFormationObservation(lastObservation, observation)) {
            return;
        }
        lastObservation = observation;
        const next = toRoomFormationStatusFromObservation(observation);
        if (next === undefined || (last !== undefined && isSameRoomFormationLayouts(last, next))) {
            return;
        }
        last = next;
        notifyListener(listener, next);
    });
}

/**
 * Layout events are the differences between consecutive status projections,
 * so they share one predicate with `status()` and the layout wait: a bootstrap
 * or tombstoned slot is no layout, and an accepted slot counts only once the
 * snapshot names it.
 */
export function subscribeRoomLayoutEvents(
    input: ReadRoomFormationStatusInput,
    listener: RallarRoomLayoutListener
): RallarUnsubscribe {
    let last = readRoomFormationStatus(input);
    return subscribeRoomFormation(input, () => {
        const next = readRoomFormationStatus(input);
        if (next === undefined) {
            return;
        }
        for (const event of toRoomLayoutEvents(input.roomRef, last, next)) {
            notifyListener(listener, event);
        }
        last = next;
    });
}

function readRoomFormationObservation(input: ReadRoomFormationStatusInput): RoomFormationObservation {
    return {
        snapshot: input.stateStore.findGroupSnapshot(input.roomRef),
        planned: input.slots.readPlanned(input.roomRef),
        accepted: input.slots.readAccepted(input.roomRef)
    };
}

function toRoomFormationStatusFromObservation(
    observation: RoomFormationObservation
): RallarRoomFormationStatus | undefined {
    if (!observation.snapshot) {
        return undefined;
    }
    return toRallarRoomFormationStatus({
        snapshot: observation.snapshot,
        planned: observation.planned,
        accepted: observation.accepted
    });
}

function isSameRoomFormationObservation(left: RoomFormationObservation, right: RoomFormationObservation): boolean {
    return left.snapshot === right.snapshot && left.planned === right.planned && left.accepted === right.accepted;
}

function isSameRoomFormationLayouts(left: RallarRoomFormationStatus, right: RallarRoomFormationStatus): boolean {
    return left.snapshot === right.snapshot &&
        left.planned?.overlay === right.planned?.overlay &&
        left.accepted?.overlay === right.accepted?.overlay;
}

function toRoomLayoutEvents(
    roomRef: GroupRef,
    previous: RallarRoomFormationStatus | undefined,
    next: RallarRoomFormationStatus
): readonly RallarRoomLayoutEvent[] {
    return [
        ...toRoomLayoutRoleEvents({ roomRef, role: 'planned', before: previous?.planned, after: next.planned }),
        ...toRoomLayoutRoleEvents({ roomRef, role: 'accepted', before: previous?.accepted, after: next.accepted })
    ];
}

interface ToRoomLayoutRoleEventsInput {
    readonly roomRef: GroupRef;
    readonly role: RallarRoomLayoutRole;
    readonly before: RallarRoomLayout | undefined;
    readonly after: RallarRoomLayout | undefined;
}

function toRoomLayoutRoleEvents(input: ToRoomLayoutRoleEventsInput): readonly RallarRoomLayoutEvent[] {
    const { roomRef, role, before, after } = input;
    if (after === undefined) {
        return before === undefined ? [] : [{ kind: 'layoutRemoved', roomRef, role, previous: before }];
    }
    if (before !== undefined && isSameGroupLayoutIdentity(before.identity, after.identity)) {
        return [];
    }
    return [
        role === 'planned'
            ? { kind: 'layoutPlanned', roomRef, layout: after }
            : { kind: 'layoutAccepted', roomRef, layout: after }
    ];
}

/** Subscribes in order and takes nothing when a later subscription refuses. */
function subscribeAll(subscribes: readonly (() => RallarUnsubscribe)[]): RallarUnsubscribe {
    const unsubscribes: RallarUnsubscribe[] = [];
    try {
        for (const subscribe of subscribes) {
            unsubscribes.push(subscribe());
        }
    }
    catch (error) {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
        throw error;
    }
    return () => {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
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
