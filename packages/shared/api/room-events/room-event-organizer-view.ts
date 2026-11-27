import { decodeExactGroupRef } from '../../encoding/decode-exact-group-ref.ts';
import { requireEpoch, requireExactKeys, requireString } from '../exact-object-decoding.ts';
import type { GroupMember } from '../group-types.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { decodeEventCourt, decodeEventParty, decodeEventRecord } from './decode-room-event.ts';
import type { RoomEvent } from './room-event.ts';

/** Names belong to this event's lobby. An outstanding allocation retains its player even after lobby departure. */
export function projectRoomEventOrganizerView(event: RoomEvent, members: readonly GroupMember[]): RoomEvent.OrganizerView {
    const names = new Map<string, string>();
    for (const member of members) {
        if (!event.removed.includes(member.principalId)) {
            names.set(member.principalId, member.guestLease?.displayName ?? member.principalId);
        }
    }
    for (const principalId of allocatedPlayers(event)) {
        if (!names.has(principalId)) names.set(principalId, principalId);
    }
    const { lobby, organizerId, revision, closesAt, closed, courts, queue } = event;
    return { lobby, organizerId, revision, closesAt, closed, courts, queue,
        players: Array.from(names, ([principalId, displayName]) => ({ principalId, displayName })) };
}

function allocatedPlayers(event: Pick<RoomEvent, 'courts' | 'queue'>): string[] {
    return [...event.queue.flatMap(party => party.players), ...event.courts.flatMap(court => court.seats.map(seat => seat.principalId))];
}

export function decodeRoomEventOrganizerView(value: unknown): RoomEvent.OrganizerView {
    const row = decodeEventRecord(value, 'Organizer event view');
    requireExactKeys(row, ['lobby', 'organizerId', 'revision', 'closesAt', 'closed', 'courts', 'queue', 'players'], 'Organizer event view');
    const lobby = decodeExactGroupRef(row.lobby, 'Event lobby');
    const organizerId = assertValidRallarRouteId(row.organizerId);
    const { revision, closesAt } = row;
    requireEpoch(revision, 'Event revision');
    requireEpoch(closesAt, 'Closing time');
    if (!revision || !closesAt || typeof row.closed !== 'boolean' ||
        !Array.isArray(row.courts) || !Array.isArray(row.queue) || !Array.isArray(row.players)) {
        throw new TypeError('Invalid organizer event view.');
    }
    const courts = row.courts.map(decodeEventCourt);
    const queue = row.queue.map(decodeEventParty);
    const players = row.players.map(player => {
        const record = decodeEventRecord(player, 'Event player');
        requireExactKeys(record, ['principalId', 'displayName'], 'Event player');
        requireString(record.displayName, 'Event player name');
        return { principalId: assertValidRallarRouteId(record.principalId), displayName: record.displayName };
    });
    const active = new Set<string>(players.map(player => player.principalId));
    const assignments = allocatedPlayers({ courts, queue });
    if (!courts.length || new Set([lobby.groupId, ...courts.map(court => court.groupId)]).size !== courts.length + 1 ||
        new Set(queue.map(party => party.id)).size !== queue.length || active.size !== players.length ||
        new Set(assignments).size !== assignments.length || assignments.some(id => !active.has(id)) ||
        courts.some(court => court.seats.some(seat => seat.offerRevision > revision ||
            (seat.deadline !== null && seat.deadline > closesAt))) ||
        (row.closed && assignments.length)) throw new TypeError('Inconsistent organizer event allocation.');
    return { lobby, organizerId, revision, closesAt, closed: row.closed, courts, queue, players };
}
