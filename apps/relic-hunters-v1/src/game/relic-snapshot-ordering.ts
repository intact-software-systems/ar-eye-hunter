import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';

export type RelicSnapshotSource =
    | 'bootstrap'
    | 'room-hydration'
    | 'rest-command'
    | 'rest-reset'
    | 'rallar-ws';

export type RelicSnapshotAcceptance = Readonly<{
    current?: RelicPublicSnapshot;
    candidate: RelicPublicSnapshot;
    expectedRoomId?: string;
}>;

export function shouldAcceptRelicSnapshot({
    current,
    candidate,
    expectedRoomId,
}: RelicSnapshotAcceptance): boolean {
    if (expectedRoomId && candidate.roomId !== expectedRoomId) {
        return false;
    }

    if (!current) {
        return true;
    }

    if (candidate.gameId !== current.gameId || candidate.roomId !== current.roomId) {
        return true;
    }

    if (candidate.updatedAtEpochMs < current.updatedAtEpochMs) {
        return false;
    }

    if (candidate.updatedAtEpochMs === current.updatedAtEpochMs &&
        candidate.round < current.round) {
        return false;
    }

    return true;
}
