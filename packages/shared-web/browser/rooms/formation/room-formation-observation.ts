import { toRallarRoomFormationStatus, type GroupRef } from '../room-group-state-translation.ts';
import type { RallarRoomStateStorePort } from '../room-state-store.ts';
import type { RallarRoomFormationStatus } from './rallar-room-formation-contracts.ts';
import type { RallarRoomLayoutSlotsPort } from './room-layout-slots.ts';

export interface ReadRoomFormationStatusInput {
    readonly roomRef: GroupRef;
    readonly stateStore: RallarRoomStateStorePort;
    readonly slots: RallarRoomLayoutSlotsPort;
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
