import type { GroupPolicyReasonCode } from '../group-policy-types.ts';
import type { GroupRef } from '../group-types.ts';

export const GROUP_MOVE_MAX_SESSIONS = 16;
export const GROUP_MOVE_PROPOSAL_TTL_MS = 120_000;

export interface GroupMoveParticipant {
    readonly principalId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly generationVersion: number;
    readonly confirmedAtEpochMs: number | null;
    readonly arrivedAtEpochMs: number | null;
}

export interface GroupMoveAdmissionFailure {
    readonly principalId: string;
    readonly code: GroupPolicyReasonCode | 'group-move-approval-required' | 'group-move-destination-missing';
    readonly message: string;
}

export type GroupMoveAction = 'propose' | 'confirm' | 'withdraw' | 'decline' | 'cancel' | 'commit' | 'arrive';

export interface GroupMove {
    readonly moveId: string;
    readonly source: GroupRef;
    readonly destination: GroupRef;
    readonly organizerSessionId: string;
    readonly participants: readonly GroupMoveParticipant[];
    readonly createdAtEpochMs: number;
    readonly expiresAtEpochMs: number;
    readonly completedAtEpochMs: number | null;
    readonly status: 'proposed' | 'committed' | 'cancelled' | 'expired' | 'denied';
    readonly reason:
        | 'participant-declined'
        | 'organizer-cancelled'
        | 'source-roster-changed'
        | 'source-unavailable'
        | 'proposal-expired'
        | 'admission-denied'
        | null;
    readonly admissionFailure: GroupMoveAdmissionFailure | null;
}

/** Every action has its own stable request identity; credentials are accepted only on confirmation. */
export interface GroupMoveRequest {
    readonly requestId: string;
    readonly moveId: string;
    readonly source: GroupRef;
    readonly destination: GroupRef;
    readonly action: GroupMoveAction;
    readonly joinCode: string | null;
    readonly inviteToken: string | null;
}
