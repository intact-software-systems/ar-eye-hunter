import type { GroupRef } from '@shared/api/group-types.ts';
import type { GroupPresenceSummaryStoredRead } from '../group-state/persistence/group-state-repository-reads.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import { lastGroupPresenceEnd } from '../group-state/retention/compute-empty-group-lifetime.ts';

interface RoomEventLifetime {
    readonly dueAt: number;
    readonly rooms: readonly { readonly ref: GroupRef; readonly authority: GroupPresenceSummaryStoredRead }[];
}

/** Every occupied court holds the same event open. The fixed close bounds even a continually renewed session. */
export async function readRoomEventLifetime(groups: GroupStateRepository, event: RoomEvent): Promise<RoomEventLifetime> {
    const refs = [event.lobby, ...event.courts.map(court => ({ ...event.lobby, groupId: court.groupId }))];
    const rooms = await Promise.all(refs.map(async ref => ({ ref, authority: await groups.readPresenceSummaryEntries(ref) })));
    const lastPresenceEnd = rooms.reduce((latest, room) => lastGroupPresenceEnd(room.authority, latest, event.closesAt), event.createdAt);
    return { dueAt: Math.min(event.closesAt, lastPresenceEnd + event.emptyReturnWindowMs), rooms };
}
