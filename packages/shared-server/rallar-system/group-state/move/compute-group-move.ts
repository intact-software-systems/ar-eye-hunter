import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    GROUP_MOVE_MAX_SESSIONS,
    GROUP_MOVE_PROPOSAL_TTL_MS,
    type GroupMove,
    type GroupMoveAction,
    type GroupMoveParticipant
} from '@shared/api/mutation/group-move.ts';

import { Either } from '@shared/resilience/Either.ts';

export interface GroupMoveRejection {
    readonly code: 'group-move-rejected' | 'optimistic-conflict';
    readonly message: string;
}
import { requireActiveGroup } from '../policy/group-policy-primitives.ts';
import type { GroupMoveAdmissionResult } from './compute-group-move-admission.ts';

export interface GroupMoveComputationInput {
    readonly proposal: GroupMove | null;
    readonly source: Pick<GroupSnapshot, 'group' | 'members' | 'activeSessions'> | null;
    readonly sourceRef: GroupRef;
    readonly destination: GroupRef;
    readonly moveId: string;
    readonly action: GroupMoveAction;
    readonly actor: Readonly<{ principalId: string; sessionId: string; }>;
    readonly nowEpochMs: number;
    readonly admission: GroupMoveAdmissionResult | null;
}

/** The caller supplies decoded, revision-fenced source facts and writes the result through AppInbox. */
export function computeGroupMove(input: GroupMoveComputationInput): Either<GroupMoveRejection, GroupMove> {
    const proposal = input.proposal;
    if (proposal === null) {
        if (input.action !== 'propose') {
            return rejectMove('The group move does not exist.');
        }
        return proposeMove(input);
    }
    if (
        proposal.moveId !== input.moveId || !isSameGroupRef(proposal.source, input.sourceRef) ||
        !isSameGroupRef(proposal.destination, input.destination)
    ) {
        throw new TypeError('Group move command and stored identity differ');
    }
    const participant = proposal.participants.find((candidate) =>
        candidate.sessionId === input.actor.sessionId && candidate.principalId === input.actor.principalId
    );
    if (!participant) {
        return rejectMove('Only a selected participant may act on this move.');
    }
    if (proposal.status !== 'proposed') {
        return Either.ofRight(
            proposal.status === 'committed' && input.action === 'arrive' && participant.arrivedAtEpochMs === null
                ? changeParticipant(proposal, { ...participant, arrivedAtEpochMs: input.nowEpochMs })
                : proposal
        );
    }
    if (input.nowEpochMs >= proposal.expiresAtEpochMs) {
        return Either.ofRight({
            ...proposal,
            status: 'expired',
            reason: 'proposal-expired',
            completedAtEpochMs: input.nowEpochMs
        });
    }
    if (input.source === null || requireActiveGroup(input.source.group, input.nowEpochMs)) {
        return Either.ofRight({
            ...proposal,
            status: 'cancelled',
            reason: 'source-unavailable',
            completedAtEpochMs: input.nowEpochMs
        });
    }
    if (!sameCohort(proposal.participants, presentPlayers(input.source, input.nowEpochMs))) {
        return Either.ofRight({
            ...proposal,
            status: 'cancelled',
            reason: 'source-roster-changed',
            completedAtEpochMs: input.nowEpochMs
        });
    }
    return applyConsent(input, proposal, participant);
}

function applyConsent(
    input: GroupMoveComputationInput,
    proposal: GroupMove,
    participant: GroupMoveParticipant
): Either<GroupMoveRejection, GroupMove> {
    switch (input.action) {
        case 'propose':
            return Either.ofRight(proposal);
        case 'confirm':
            return Either.ofRight(
                participant.confirmedAtEpochMs === null
                    ? changeParticipant(proposal, { ...participant, confirmedAtEpochMs: input.nowEpochMs })
                    : proposal
            );
        case 'withdraw':
            return Either.ofRight(changeParticipant(proposal, { ...participant, confirmedAtEpochMs: null }));
        case 'decline':
            return Either.ofRight({
                ...proposal,
                status: 'cancelled',
                reason: 'participant-declined',
                completedAtEpochMs: input.nowEpochMs
            });
        case 'cancel':
            if (proposal.organizerSessionId !== input.actor.sessionId) {
                return rejectMove('Only the move organizer may commit or cancel for everyone.');
            }
            return Either.ofRight({
                ...proposal,
                status: 'cancelled',
                reason: 'organizer-cancelled',
                completedAtEpochMs: input.nowEpochMs
            });
        case 'commit':
            return commitMove(input, proposal);
        case 'arrive':
            return rejectMove('Arrival requires a committed group move.');
    }
}

function proposeMove(input: GroupMoveComputationInput): Either<GroupMoveRejection, GroupMove> {
    if (input.source === null || !isSameGroupRef(input.source.group, input.sourceRef)) {
        return rejectMove('The source room is unavailable.');
    }
    const source = input.source.group;
    if (requireActiveGroup(source, input.nowEpochMs)) {
        return rejectMove('The source room is unavailable.');
    }
    if (
        source.applicationId !== input.destination.applicationId ||
        source.workspaceId !== input.destination.workspaceId ||
        isSameGroupRef(source, input.destination)
    ) {
        return rejectMove('Choose a different room in the same application and workspace.');
    }
    const participants = presentPlayers(input.source, input.nowEpochMs);
    if (participants.length === 0 || participants.length > GROUP_MOVE_MAX_SESSIONS) {
        return rejectMove(
            `A group move requires between one and ${GROUP_MOVE_MAX_SESSIONS} player sessions.`
        );
    }
    if (
        !participants.some((participant) =>
            participant.principalId === input.actor.principalId && participant.sessionId === input.actor.sessionId
        )
    ) {
        return rejectMove('Only a present player may organize a group move.');
    }
    return Either.ofRight({
        moveId: input.moveId,
        source: { applicationId: source.applicationId, workspaceId: source.workspaceId, groupId: source.groupId },
        destination: input.destination,
        organizerSessionId: input.actor.sessionId,
        participants,
        createdAtEpochMs: input.nowEpochMs,
        expiresAtEpochMs: input.nowEpochMs + GROUP_MOVE_PROPOSAL_TTL_MS,
        completedAtEpochMs: null,
        status: 'proposed',
        reason: null,
        admissionFailure: null
    });
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

function sameCohort(previous: readonly GroupMoveParticipant[], current: readonly GroupMoveParticipant[]): boolean {
    return previous.length === current.length &&
        previous.every((participant) =>
            current.some((candidate) =>
                candidate.principalId === participant.principalId && candidate.sessionId === participant.sessionId &&
                candidate.generationId === participant.generationId &&
                candidate.generationVersion === participant.generationVersion
            )
        );
}

function changeParticipant(proposal: GroupMove, participant: GroupMoveParticipant): GroupMove {
    return {
        ...proposal,
        participants: proposal.participants.map((candidate) =>
            candidate.sessionId === participant.sessionId ? participant : candidate
        )
    };
}

function commitMove(input: GroupMoveComputationInput, proposal: GroupMove): Either<GroupMoveRejection, GroupMove> {
    if (proposal.organizerSessionId !== input.actor.sessionId) {
        return rejectMove('Only the move organizer may commit or cancel for everyone.');
    }
    if (proposal.participants.some((participant) => participant.confirmedAtEpochMs === null)) {
        return rejectMove('Every player must confirm before the group can move.');
    }
    if (input.admission === null) {
        throw new TypeError('A group move commit requires the current destination admission decision');
    }
    if (input.admission.status === 'conflict') {
        return Either.ofLeft({ code: 'optimistic-conflict', message: 'Destination facts changed during the read.' });
    }
    if (input.admission.status === 'denied') {
        const { status: _status, ...admissionFailure } = input.admission;
        return Either.ofRight({
            ...proposal,
            status: 'denied',
            reason: 'admission-denied',
            admissionFailure,
            completedAtEpochMs: input.nowEpochMs
        });
    }
    return Either.ofRight({ ...proposal, status: 'committed', completedAtEpochMs: input.nowEpochMs });
}

function rejectMove(message: string): Either<GroupMoveRejection, GroupMove> {
    return Either.ofLeft({ code: 'group-move-rejected', message });
}
