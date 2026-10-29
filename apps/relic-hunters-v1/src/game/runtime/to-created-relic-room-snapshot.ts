import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

export function toCreatedRelicRoomSnapshot(error: Error): GroupSnapshot | undefined {
    if (
        error.name !== 'RallarRoomSwitchPartialFailureError' ||
        !('operation' in error) || error.operation !== 'create-and-switch' || !('joinedRoom' in error)
    ) {
        return undefined;
    }
    try {
        // The committed result identifies this creation even while its cached room is absent or replaced.
        validateAuthoritativeGroupSnapshot(error.joinedRoom);
        return error.joinedRoom;
    }
    catch {
        return undefined;
    }
}
