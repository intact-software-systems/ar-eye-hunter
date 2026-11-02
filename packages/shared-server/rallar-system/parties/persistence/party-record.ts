import type { PartyInvitation, PartyMember, PartyRef } from '@shared/api/parties/party.ts';

export interface PartyRecord {
    readonly ref: PartyRef;
    readonly status: 'active' | 'closed';
    readonly leaderPrincipalId: string | null;
    readonly rosterRevision: number;
    readonly createdAtEpochMs: number;
    readonly members: readonly PartyMember[];
    readonly invitations: readonly PartyInvitation[];
}
