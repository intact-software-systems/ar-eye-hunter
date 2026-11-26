import type { Group, GroupSnapshot } from '@shared/api/group-types.ts';

/** An unprocessed expiry wake cannot extend an event's room grants. */
export async function availableGuestSnapshot(
    snapshot: GroupSnapshot | undefined, now: number, isEventRoomAvailable: (group: Group, now: number) => Promise<boolean>
): Promise<GroupSnapshot | undefined> {
    if (snapshot?.group.eventRoom && !await isEventRoomAvailable(snapshot.group, now)) return undefined;
    return snapshot;
}
