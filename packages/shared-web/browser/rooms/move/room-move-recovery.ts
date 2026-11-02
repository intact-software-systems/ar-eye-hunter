import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeGroupMove } from '@shared/api/mutation/decode-group-move.ts';
import type { GroupMove, GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import type { StateScope } from '@shared/api/state-types.ts';

/** Recovery can observe historical rooms, but only this account's scoped decisions. */
export function assertRoomMoveAccount(move: GroupMove, scope: StateScope, session: AuthSession): void {
    decodeGroupMove(move);
    if (
        move.source.applicationId !== scope.applicationId || move.source.workspaceId !== scope.workspaceId ||
        !move.participants.some((participant) => participant.principalId === session.clientId)
    ) {
        throw new TypeError('Room move does not belong to this scope and account');
    }
}

/** One automatic entry per observed move; game eligibility still runs immediately before activation. */
export interface SelectRoomMoveEntryInput {
    readonly moves: readonly GroupMove[];
    readonly currentRoom: GroupRef | undefined;
    readonly session: AuthSession | undefined;
    readonly attemptedEntries: ReadonlySet<string>;
}

export function selectRoomMoveEntry(
    { moves, currentRoom, session, attemptedEntries }: SelectRoomMoveEntryInput
): GroupMove | undefined {
    return moves.find((move) =>
        move.status === 'committed' && currentRoom &&
        isSameGroupRef(currentRoom, move.source) && !attemptedEntries.has(groupMoveKey(move)) &&
        move.participants.some((participant) =>
            participant.sessionId === session?.sessionId && participant.arrivedAtEpochMs === null
        )
    );
}

/** Arrival updates refresh both room observations without making room readability an admission condition. */
export function changedRoomMoveArrivals(
    moves: readonly GroupMove[],
    previousMoves: readonly GroupMove[],
    currentRoom: GroupRef | undefined
): readonly GroupMove[] {
    if (currentRoom === undefined) {
        return [];
    }
    return moves.filter((move) => {
        const previous = previousMoves.find((candidate) =>
            candidate.moveId === move.moveId && isSameGroupRef(candidate.source, move.source)
        );
        return (isSameGroupRef(currentRoom, move.source) || isSameGroupRef(currentRoom, move.destination)) &&
            move.status === 'committed' && move.participants.some((participant) =>
                participant.arrivedAtEpochMs !== null
            ) &&
            JSON.stringify(move) !== JSON.stringify(previous);
    });
}

export function groupMoveKey(move: GroupMove): string {
    return JSON.stringify([move.source.applicationId, move.source.workspaceId, move.source.groupId, move.moveId]);
}

export function assertRoomMoveResponse(result: GroupMove, request: GroupMoveRequest): void {
    if (
        result.moveId !== request.moveId || !isSameGroupRef(result.source, request.source) ||
        !isSameGroupRef(result.destination, request.destination) ||
        result.party?.partyId !== request.party?.partyId ||
        result.party?.rosterRevision !== request.party?.rosterRevision
    ) {
        throw new TypeError('Room move response identity differs');
    }
}
