import { isSameGroupRef } from '../api-type-utils.ts';
import { GROUP_POLICY_REASON_CODES } from '../group-policy-types.ts';
import type { GroupRef } from '../group-types.ts';
import {
    GROUP_MOVE_MAX_SESSIONS,
    GROUP_MOVE_PROPOSAL_TTL_MS,
    type GroupMove,
    type GroupMoveParticipant
} from './group-move.ts';

import { requireExactKeys, requireOneOf, requireRecord, requireString } from '../exact-object-decoding.ts';

export interface GroupMoveClaim {
    readonly source: GroupRef;
    readonly moveId: string;
}

export function decodeGroupMoveClaim(value: unknown): GroupMoveClaim {
    const claim = requireRecord(value, 'Group move claim');
    requireExactKeys(claim, ['source', 'moveId'], 'Group move claim');
    return { source: decodeGroupMoveRef(claim.source), moveId: moveIdentifier(claim.moveId) };
}

export function decodeGroupMoveRef(value: unknown): GroupRef {
    const ref = requireRecord(value, 'Group move room');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Group move room');
    return {
        applicationId: moveIdentifier(ref.applicationId),
        workspaceId: moveIdentifier(ref.workspaceId),
        groupId: moveIdentifier(ref.groupId)
    };
}

const GROUP_MOVE_FIELDS = [
    'moveId',
    'source',
    'destination',
    'organizerSessionId',
    'participants',
    'createdAtEpochMs',
    'expiresAtEpochMs',
    'completedAtEpochMs',
    'status',
    'reason',
    'admissionFailure'
];

export function decodeGroupMove(value: unknown): GroupMove {
    const move = requireRecord(value, 'Group move');
    requireExactKeys(move, GROUP_MOVE_FIELDS, 'Group move');
    const source = decodeGroupMoveRef(move.source);
    const destination = decodeGroupMoveRef(move.destination);
    if (
        source.applicationId !== destination.applicationId || source.workspaceId !== destination.workspaceId ||
        isSameGroupRef(source, destination)
    ) {
        throw new TypeError('Group move must target a different room in the same scope');
    }
    if (
        !Array.isArray(move.participants) || move.participants.length === 0 ||
        move.participants.length > GROUP_MOVE_MAX_SESSIONS
    ) {
        throw new TypeError('Group move participants must be a nonempty bounded array');
    }
    const participants = Array.from(move.participants, decodeParticipant);
    const organizerSessionId = moveIdentifier(move.organizerSessionId);
    if (
        new Set(participants.map((participant) => participant.sessionId)).size !== participants.length ||
        !participants.some((participant) => participant.sessionId === organizerSessionId)
    ) {
        throw new TypeError('Group move cohort repeats a session or omits the organizer');
    }
    const decoded: GroupMove = {
        moveId: moveIdentifier(move.moveId),
        source,
        destination,
        organizerSessionId,
        participants,
        createdAtEpochMs: moveEpoch(move.createdAtEpochMs),
        expiresAtEpochMs: moveEpoch(move.expiresAtEpochMs),
        completedAtEpochMs: nullableMoveEpoch(move.completedAtEpochMs),
        status: requireOneOf(
            move.status,
            ['proposed', 'committed', 'cancelled', 'expired', 'denied'],
            'Group move status'
        ),
        reason: move.reason === null
            ? null
            : requireOneOf(
                move.reason,
                [
                    'participant-declined',
                    'organizer-cancelled',
                    'source-roster-changed',
                    'source-unavailable',
                    'proposal-expired',
                    'admission-denied'
                ] as const,
                'Group move reason'
            ),
        admissionFailure: decodeAdmissionFailure(move.admissionFailure)
    };
    validateMoveState(decoded);
    return decoded;
}

export function moveIdentifier(value: unknown): string {
    requireString(value, 'Group move identifier or credential');
    if (value.length > 256) {
        throw new TypeError('Group move identifier or credential exceeds 256 characters');
    }
    return value;
}

function decodeParticipant(value: unknown): GroupMoveParticipant {
    const participant = requireRecord(value, 'Group move participant');
    requireExactKeys(participant, [
        'principalId',
        'sessionId',
        'generationId',
        'generationVersion',
        'confirmedAtEpochMs',
        'arrivedAtEpochMs'
    ], 'Group move participant');
    return {
        principalId: moveIdentifier(participant.principalId),
        sessionId: moveIdentifier(participant.sessionId),
        generationId: moveIdentifier(participant.generationId),
        generationVersion: moveEpoch(participant.generationVersion),
        confirmedAtEpochMs: nullableMoveEpoch(participant.confirmedAtEpochMs),
        arrivedAtEpochMs: nullableMoveEpoch(participant.arrivedAtEpochMs)
    };
}

function decodeAdmissionFailure(value: unknown): GroupMove['admissionFailure'] {
    if (value === null) {
        return null;
    }
    const failure = requireRecord(value, 'Group move admission failure');
    requireExactKeys(failure, ['principalId', 'code', 'message'], 'Group move admission failure');
    requireString(failure.message, 'Group move admission failure message');
    return {
        principalId: moveIdentifier(failure.principalId),
        code: requireOneOf(failure.code, [
            ...GROUP_POLICY_REASON_CODES,
            'group-move-approval-required',
            'group-move-destination-missing'
        ], 'Group move admission failure code'),
        message: failure.message
    };
}

function validateMoveState(move: GroupMove): void {
    if (
        move.expiresAtEpochMs - move.createdAtEpochMs !== GROUP_MOVE_PROPOSAL_TTL_MS ||
        (move.status === 'proposed') !== (move.completedAtEpochMs === null) ||
        (move.completedAtEpochMs !== null && move.completedAtEpochMs < move.createdAtEpochMs) ||
        (move.status === 'committed' && (move.completedAtEpochMs ?? Infinity) >= move.expiresAtEpochMs) ||
        (move.status === 'expired' && (move.completedAtEpochMs ?? 0) < move.expiresAtEpochMs)
    ) {
        throw new TypeError('Group move deadlines or completion are inconsistent');
    }
    const expectedReasons: Readonly<Record<GroupMove['status'], readonly GroupMove['reason'][]>> = {
        proposed: [null],
        committed: [null],
        expired: ['proposal-expired'],
        denied: ['admission-denied'],
        cancelled: ['participant-declined', 'organizer-cancelled', 'source-roster-changed', 'source-unavailable']
    };
    if (
        !expectedReasons[move.status].includes(move.reason) ||
        (move.status === 'denied') !== (move.admissionFailure !== null) ||
        (move.admissionFailure !== null &&
            !move.participants.some((participant) => participant.principalId === move.admissionFailure?.principalId))
    ) {
        throw new TypeError('Group move outcome and reason differ');
    }
    for (const participant of move.participants) {
        if (
            (participant.confirmedAtEpochMs !== null &&
                (participant.confirmedAtEpochMs < move.createdAtEpochMs ||
                    participant.confirmedAtEpochMs >= move.expiresAtEpochMs ||
                    (move.completedAtEpochMs !== null && participant.confirmedAtEpochMs > move.completedAtEpochMs))) ||
            (move.status === 'committed' && participant.confirmedAtEpochMs === null) ||
            (participant.arrivedAtEpochMs !== null &&
                (move.status !== 'committed' || participant.arrivedAtEpochMs < (move.completedAtEpochMs ?? Infinity)))
        ) {
            throw new TypeError('Group move consent or arrival is inconsistent');
        }
    }
}

function moveEpoch(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new TypeError('Group move timestamp must be a non-negative safe integer');
    }
    return value;
}

function nullableMoveEpoch(value: unknown): number | null {
    return value === null ? null : moveEpoch(value);
}
