import {
    MAX_ROOM_DEADLINES,
    readRoomDeadlines,
    ROOM_DEADLINES_METADATA_KEY,
    type RoomDeadlineChange
} from '@shared/api/group-deadlines/room-deadline.ts';
import { isRallarGroupDirectorSessionActive, readRallarGroupDirectorFromSnapshot } from '@shared/api/group-director.ts';
import type { Group, GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupMutationCommand } from '../group-mutation-contracts.ts';

interface ComputeGroupDeadlineChangeInput {
    readonly current: Group;
    readonly next: Group;
    readonly change: RoomDeadlineChange;
    readonly nowEpochMs: number;
}

interface DeadlineRefusal {
    readonly rejectionCode: 'group-mutation-rejected' | 'room-deadline-revision-conflict' | 'room-director-changed';
    readonly message: string;
}

/** The enclosing group CAS fences this decision against concurrent room and membership changes. */
export function computeGroupDeadlineChange(
    { current, next, change, nowEpochMs }: ComputeGroupDeadlineChangeInput
): DeadlineRefusal | Group {
    if (current.kind !== 'room' || next.kind !== 'room' || current.status !== 'active' || next.status !== 'active') {
        return { rejectionCode: 'group-mutation-rejected', message: 'Deadlines require an active room.' };
    }
    const deadlines = readRoomDeadlines(current.metadata);
    const index = deadlines.findIndex((deadline) => deadline.name === change.name);
    const previous = deadlines[index];
    if ((previous?.revision ?? 0) !== change.expectedRevision) {
        return { rejectionCode: 'room-deadline-revision-conflict', message: 'Room deadline revision has changed.' };
    }
    if (previous === undefined && deadlines.length >= MAX_ROOM_DEADLINES) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Room deadline capacity reached.' };
    }
    if (change.atEpochMs <= nowEpochMs) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Room deadline must be in the future.' };
    }
    if (previous && (previous.atEpochMs <= nowEpochMs || change.atEpochMs <= previous.atEpochMs)) {
        return { rejectionCode: 'group-mutation-rejected', message: 'A live room deadline can only be extended.' };
    }
    if (change.expectedRevision === Number.MAX_SAFE_INTEGER) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Room deadline revision exhausted.' };
    }
    const revised = deadlines.map((deadline) => ({ ...deadline }));
    revised[index < 0 ? revised.length : index] = {
        name: change.name,
        atEpochMs: change.atEpochMs,
        revision: change.expectedRevision + 1
    };
    return { ...next, metadata: { ...next.metadata, [ROOM_DEADLINES_METADATA_KEY]: revised } };
}

interface DirectorDeadlineExtensionInput {
    readonly update: Extract<GroupMutationCommand, { operation: 'updateGroup'; }>['input'];
    readonly snapshot: GroupSnapshot;
    readonly expectedEpoch: number;
    readonly nowEpochMs: number;
}

/** A director intent never inherits the session's other room privileges. */
export function refuseDirectorDeadlineExtension({
    update,
    snapshot,
    expectedEpoch,
    nowEpochMs
}: DirectorDeadlineExtensionInput): DeadlineRefusal | null {
    const appointment = readRallarGroupDirectorFromSnapshot(snapshot);
    if (
        appointment?.epoch !== expectedEpoch || appointment.sessionId !== update.actorSessionId ||
        appointment.principalId !== update.actorPrincipalId ||
        !isRallarGroupDirectorSessionActive(snapshot, appointment, nowEpochMs)
    ) {
        return {
            rejectionCode: 'room-director-changed',
            message: 'The requesting session no longer holds this room director appointment.'
        };
    }
    const allowed = ['actorPrincipalId', 'actorSessionId', 'reason', 'roomDeadline'];
    if (Object.entries(update).some(([key, value]) => value != null && !allowed.includes(key))) {
        return {
            rejectionCode: 'group-mutation-rejected',
            message: 'Director deadline extensions cannot change other room settings.'
        };
    }
    return null;
}
