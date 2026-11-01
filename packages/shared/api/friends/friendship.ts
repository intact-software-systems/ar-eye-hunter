import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import type { GroupRef } from '../group-types.ts';
import { assertValidRallarGroupRef } from '../rallar-validation.ts';

export type FriendshipStatus = 'outgoing' | 'incoming' | 'friend' | 'blocked';
export type FriendshipAction = 'request' | 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock';
export type FriendshipRefusal = 'request-unavailable' | 'person-unavailable';

export interface FriendContact {
    readonly principalId: string;
    readonly status: FriendshipStatus;
}

export interface FriendInvitation {
    readonly invitationId: string;
    readonly senderPrincipalId: string;
    readonly kind: 'room' | 'scheduled-session';
    readonly roomRef: GroupRef;
    readonly createdAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export function decodeFriendInvitation(value: unknown): FriendInvitation {
    const invitation = requireRecord(value, 'Friend invitation');
    requireExactKeys(invitation, [
        'invitationId',
        'senderPrincipalId',
        'kind',
        'roomRef',
        'createdAtEpochMs',
        'expiresAtEpochMs'
    ], 'Friend invitation');
    requireString(invitation.invitationId, 'Friend invitation identity');
    requireString(invitation.senderPrincipalId, 'Friend invitation sender');
    const kind = requireOneOf(invitation.kind, ['room', 'scheduled-session'], 'Friend invitation kind');
    const ref = requireRecord(invitation.roomRef, 'Friend invitation destination');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Friend invitation destination');
    const roomRef = assertValidRallarGroupRef(ref);
    requireEpoch(invitation.createdAtEpochMs, 'Friend invitation creation');
    requireEpoch(invitation.expiresAtEpochMs, 'Friend invitation expiry');
    if (invitation.expiresAtEpochMs <= invitation.createdAtEpochMs) {
        throw new TypeError('Friend invitation lifetime is invalid');
    }
    return {
        invitationId: invitation.invitationId,
        senderPrincipalId: invitation.senderPrincipalId,
        kind,
        roomRef,
        createdAtEpochMs: invitation.createdAtEpochMs,
        expiresAtEpochMs: invitation.expiresAtEpochMs
    };
}
