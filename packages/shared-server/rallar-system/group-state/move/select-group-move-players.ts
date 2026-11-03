import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { GroupMoveParticipant } from '@shared/api/mutation/group-move.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { GroupMoveComputationInput, GroupMoveRejection } from './compute-group-move.ts';

export function selectGroupMovePlayers(
    input: GroupMoveComputationInput
): Either<GroupMoveRejection, readonly GroupMoveParticipant[]> {
    const present = input.source === null ? [] : presentPlayers(input.source, input.nowEpochMs);
    const selection = input.partySelection;
    if (selection === null) {
        return Either.ofRight(present);
    }
    const party = input.party;
    const organizer = input.proposal === null
        ? input.actor.principalId
        : input.proposal.participants.find((participant) =>
            participant.sessionId === input.proposal!.organizerSessionId
        )?.principalId;
    if (
        party?.status !== 'active' || party.ref.partyId !== selection.partyId ||
        party.ref.applicationId !== input.sourceRef.applicationId ||
        party.ref.workspaceId !== input.sourceRef.workspaceId ||
        party.rosterRevision !== selection.rosterRevision
    ) {
        return Either.ofLeft({
            code: 'group-move-rejected',
            message: 'The party changed. Refresh before proposing another move.'
        });
    }
    if (party.leaderPrincipalId !== organizer) {
        return Either.ofLeft({
            code: 'group-move-rejected',
            message: 'Only the current party leader may propose a party move.'
        });
    }
    const selected: GroupMoveParticipant[] = [];
    for (const member of party.members) {
        const previous = input.proposal?.participants.find((participant) =>
            participant.principalId === member.principalId
        );
        const sessionId = previous?.sessionId ??
            (member.principalId === input.actor.principalId ? input.actor.sessionId : null);
        const participant = present.find((participant) =>
            participant.principalId === member.principalId &&
            (sessionId === null || participant.sessionId === sessionId)
        );
        if (participant === undefined) {
            return Either.ofLeft({
                code: 'group-move-rejected',
                message: 'Every party member must be present as a player in the source room.'
            });
        }
        selected.push(participant);
    }
    return Either.ofRight(selected.toSorted((left, right) => left.sessionId.localeCompare(right.sessionId)));
}

function presentPlayers(
    source: Pick<GroupSnapshot, 'group' | 'members' | 'activeSessions'>,
    nowEpochMs: number
): readonly GroupMoveParticipant[] {
    const players = new Set(
        source.members.filter((member) => member.status === 'active' && member.role !== 'spectator')
            .map((member) => member.principalId)
    );
    const sessions = source.activeSessions.filter((session) =>
        players.has(session.principalId) && session.status === 'active' && session.disconnectedAtEpochMs === null &&
        session.expiresAtEpochMs > nowEpochMs
    );
    if (new Set(sessions.map((session) => session.sessionId)).size !== sessions.length) {
        throw new TypeError('The source room has duplicate session identities');
    }
    return sessions.map((session): GroupMoveParticipant => ({
        principalId: session.principalId,
        sessionId: session.sessionId,
        generationId: session.generationId,
        generationVersion: session.generationVersion,
        confirmedAtEpochMs: null,
        arrivedAtEpochMs: null
    })).toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
}
