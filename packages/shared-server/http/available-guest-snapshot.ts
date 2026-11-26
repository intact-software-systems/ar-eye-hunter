import type { Group, GroupSnapshot } from '@shared/api/group-types.ts';

/** A delayed retirement worker cannot extend a temporary room’s access. */
export async function availableGuestSnapshot(
    snapshot: GroupSnapshot | undefined, now: number, isTemporaryRoomAvailable: (group: Group, now: number) => Promise<boolean>
): Promise<GroupSnapshot | undefined> {
    if (snapshot && (snapshot.group.eventRoom || snapshot.group.temporaryPlayerRoom) && !await isTemporaryRoomAvailable(snapshot.group, now)) return undefined;
    return snapshot;
}
