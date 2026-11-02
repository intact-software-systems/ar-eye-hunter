import type { StateScope } from '../state-types.ts';

export interface PartyRef extends StateScope {
    readonly partyId: string;
}

export interface PartyMember {
    readonly principalId: string;
    readonly joinedAtEpochMs: number;
}

export interface PartyInvitation {
    readonly invitationId: string;
    readonly senderPrincipalId: string;
    readonly principalId: string;
    readonly createdAtEpochMs: number;
    readonly expiresAtEpochMs: number;
}

export type PartyRosterIntent =
    | Readonly<{ action: 'create'; }>
    | Readonly<{ action: 'leave'; }>
    | Readonly<{ action: 'disband'; }>
    | Readonly<{ action: 'take-leadership'; }>
    | Readonly<{ action: 'invite'; principalId: string; invitationId: string; }>
    | Readonly<{ action: 'accept'; invitationId: string; }>
    | Readonly<{ action: 'decline'; invitationId: string; }>
    | Readonly<{ action: 'revoke'; invitationId: string; }>
    | Readonly<{ action: 'transfer'; principalId: string; }>;

export type PartyRefusal =
    | 'unauthorized'
    | 'already-in-party'
    | 'party-unavailable'
    | 'party-changed'
    | 'party-full'
    | 'invitation-capacity'
    | 'invitation-unavailable'
    | 'person-unavailable'
    | 'member-required'
    | 'leader-required'
    | 'leader-present'
    | 'member-away';

export interface PartyPolicy {
    readonly maxMembers: number;
    readonly maxInvitations: number;
    readonly invitationLifetimeMs: number;
}
