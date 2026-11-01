import type { GroupRef } from '../group-types.ts';

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
