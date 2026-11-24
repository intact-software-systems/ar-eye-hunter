import { readRoomTimeRecords, type RoomClockMutation } from '@shared/api/group-deadlines/room-clock.ts';
import { GUEST_PLAY_TIMELINE } from '@shared/api/room-guest-access.ts';
import type { Group, GroupMember } from '@shared/api/group-types.ts';
import { computeGroupClockChange, withGroupTimeRecord, type ClockRefusal } from './compute-group-clock-change.ts';

interface GroupClockUpdate {
    readonly group: Group;
    readonly command: RoomClockMutation;
    readonly now: number;
    readonly members?: readonly GroupMember[];
}

/** Publish phase identity and time together in the one authoritative group write. */
export function computeGroupClockUpdate({ group, command, now, members = [] }: GroupClockUpdate): Group | ClockRefusal {
    if (group.kind !== 'room' || group.status !== 'active') {
        return { rejectionCode: 'group-mutation-rejected', message: 'Clocks require an active room.' };
    }
    const clocks = readRoomTimeRecords(group.metadata);
    const clock = computeGroupClockChange(clocks, command, now);
    if (!('status' in clock)) {
        return clock;
    }
    if (command.name !== GUEST_PLAY_TIMELINE || !('phase' in clock)) {
        return withGroupTimeRecord(group, clock, clocks);
    }
    if (command.operation === 'advance-phase') {
        const selected = new Set(command.participantPrincipalIds ?? []);
        const participants = members.filter(member => selected.has(member.principalId) && member.status === 'active' && member.role !== 'spectator');
        if (participants.length !== selected.size || participants.some(member => member.guestLease && member.guestLease.expiresAtEpochMs <= now)) {
            return { rejectionCode: 'group-mutation-rejected', message: 'Round requires currently admitted players.' };
        }
        if (clock.status !== 'running') throw new Error('A newly started phase must be running.');
        const guestParticipants = participants.flatMap(member => member.guestLease ? [{
            principalId: member.principalId, leaseExpiresAtEpochMs: member.guestLease.expiresAtEpochMs, endsAtEpochMs: clock.endsAtEpochMs
        }] : []);
        return withGroupTimeRecord(group, { ...clock, guestParticipants }, clocks);
    }
    const previous = clocks.find(record => record.name === command.name);
    if (previous && 'phase' in previous && previous.guestParticipants) {
        const guestParticipants = previous.guestParticipants.map(entry => {
            // Edits before expiry can revise the schedule. A pause retains the last scheduled boundary.
            if (now >= entry.leaseExpiresAtEpochMs || clock.status === 'paused') return entry;
            return { ...entry, endsAtEpochMs: clock.endsAtEpochMs };
        });
        return withGroupTimeRecord(group, { ...clock, guestParticipants }, clocks);
    }
    return withGroupTimeRecord(group, clock, clocks);
}
