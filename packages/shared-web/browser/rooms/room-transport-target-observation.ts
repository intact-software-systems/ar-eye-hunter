import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
    isSameGroupRef,
    toScopedOverlayId
} from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { OverlayRepositoryChange } from '@shared/repository/overlays-repository.ts';

import type { RallarRoomLayoutSlotsPort } from './formation/room-layout-slots.ts';
import type { RallarRoomStateStorePort } from './room-state-store.ts';

export interface SubscribeRoomTransportTargetInput {
    readonly room: string | GroupRef;
    readonly stateStore: Pick<RallarRoomStateStorePort, 'onCacheChange' | 'resolveRoomRef'>;
    readonly slots: Pick<RallarRoomLayoutSlotsPort, 'onAcceptedChange'>;
}

interface RoomTransportStateChange {
    readonly groups: readonly Readonly<{ group: GroupRef; }>[];
}

/** Wakes when authoritative membership or the accepted layout changes for one room. */
export function subscribeRoomTransportTarget(
    input: SubscribeRoomTransportTargetInput,
    listener: () => void | Promise<void>
): RallarUnsubscribe {
    const unsubscribeState = input.stateStore.onCacheChange((change) => {
        if (doesStateChangeAffectRoom(input, change)) {
            return listener();
        }
    });
    const unsubscribeAccepted = input.slots.onAcceptedChange((change) => {
        if (doesAcceptedChangeAffectRoom(input, change)) {
            return listener();
        }
    });
    return () => {
        unsubscribeAccepted();
        unsubscribeState();
    };
}

function doesStateChangeAffectRoom(
    input: SubscribeRoomTransportTargetInput,
    change: RoomTransportStateChange
): boolean {
    return change.groups.some((snapshot) => isTargetRoom(input, snapshot.group));
}

function doesAcceptedChangeAffectRoom(
    input: SubscribeRoomTransportTargetInput,
    change: OverlayRepositoryChange
): boolean {
    const roomRef = resolveTargetRoomRef(input);
    if (roomRef) {
        return change.overlayId === toScopedOverlayId(roomRef);
    }
    const changedRoomRef = change.overlay?.groupRef ?? change.previous?.groupRef;
    return (
        typeof input.room === 'string' && changedRoomRef?.groupId === input.room
    );
}

function isTargetRoom(
    input: SubscribeRoomTransportTargetInput,
    candidate: GroupRef
): boolean {
    const roomRef = resolveTargetRoomRef(input);
    return roomRef
        ? isSameGroupRef(roomRef, candidate)
        : typeof input.room === 'string' && candidate.groupId === input.room;
}

function resolveTargetRoomRef(
    input: SubscribeRoomTransportTargetInput
): GroupRef | undefined {
    return typeof input.room === 'string'
        ? input.stateStore.resolveRoomRef(input.room)
        : input.room;
}
