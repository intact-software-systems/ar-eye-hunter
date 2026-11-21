import { MAX_ROOM_CLOCKS, type RoomClock, type RoomClockCommand } from '@shared/api/group-deadlines/room-clock.ts';

interface ClockRefusal {
    readonly rejectionCode: 'room-clock-revision-conflict' | 'group-mutation-rejected';
    readonly message: string;
}

/** Evaluated against the same group revision and server time as director authorization. */
export function computeRoomClock(
    clocks: readonly RoomClock[],
    command: RoomClockCommand,
    now: number
): RoomClock | ClockRefusal {
    const previous = clocks.find((clock) => clock.name === command.name);
    if ((previous?.revision ?? 0) !== command.expectedRevision) {
        return { rejectionCode: 'room-clock-revision-conflict', message: 'Clock revision has changed.' };
    }
    const identity = { name: command.name, revision: command.expectedRevision + 1 };
    if (!Number.isSafeInteger(identity.revision) || (!previous && clocks.length >= MAX_ROOM_CLOCKS)) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Clock capacity exhausted.' };
    }
    let durationMs: number;
    switch (command.operation) {
        case 'start':
            if (previous && (previous.status === 'paused' || previous.endsAtEpochMs > now)) {
                return { rejectionCode: 'group-mutation-rejected', message: 'This clock is already in use.' };
            }
            durationMs = command.durationMs;
            break;
        case 'pause':
            if (previous?.status !== 'running' || previous.endsAtEpochMs <= now) {
                return { rejectionCode: 'group-mutation-rejected', message: 'Only a live clock can pause.' };
            }
            return { ...identity, status: 'paused', remainingMs: previous.endsAtEpochMs - now };
        case 'resume':
            if (previous?.status !== 'paused') {
                return { rejectionCode: 'group-mutation-rejected', message: 'Only a paused clock can resume.' };
            }
            durationMs = previous.remainingMs;
            break;
    }
    const endsAtEpochMs = now + durationMs;
    if (endsAtEpochMs > 8_640_000_000_000_000) {
        return { rejectionCode: 'group-mutation-rejected', message: 'Clock end exceeds the supported UTC range.' };
    }
    return { ...identity, status: 'running', endsAtEpochMs };
}
