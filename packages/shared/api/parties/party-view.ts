import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../exact-object-decoding.ts';
import { decodeStateScope, type StateScope } from '../state-types.ts';
import { decodePartyRef } from './party-request.ts';
import { decodePartyInvitation, decodePartyMember } from './party.ts';
import type { PartyInvitation, PartyMember, PartyRef } from './party.ts';

export interface PartyMemberView extends PartyMember {
    readonly displayName: string;
    readonly presence: 'present' | 'away';
}

export interface PartyRosterView {
    readonly ref: PartyRef;
    readonly rosterRevision: number;
    readonly leaderPrincipalId: string;
    readonly members: readonly PartyMemberView[];
    readonly invitations: readonly PartyInvitation[];
}

export interface PartyReceivedInvitation extends PartyInvitation {
    readonly ref: PartyRef;
}

export interface PartyView {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly observedAtEpochMs: number;
    readonly maxMembers: number;
    readonly party: PartyRosterView | null;
    readonly invitations: readonly PartyReceivedInvitation[];
}

export function decodePartyView(value: unknown): PartyView {
    const view = requireRecord(value, 'Party view');
    requireExactKeys(
        view,
        ['scope', 'principalId', 'observedAtEpochMs', 'maxMembers', 'party', 'invitations'],
        'Party view'
    );
    const scope = decodeStateScope(view.scope);
    requireString(view.principalId, 'Party view account');
    requireEpoch(view.observedAtEpochMs, 'Party observation time');
    requireEpoch(view.maxMembers, 'Party member limit');
    if (
        view.maxMembers < 2 || view.maxMembers > 16 || !Array.isArray(view.invitations) || view.invitations.length > 256
    ) {
        throw new TypeError('Party view capacity or invitations are invalid');
    }
    const party = view.party === null
        ? null
        : decodePartyRosterView(view.party, view.principalId, view.observedAtEpochMs);
    const invitations = view.invitations.map((value): PartyReceivedInvitation => {
        const received = requireRecord(value, 'Received party invitation');
        const { ref, ...invitation } = received;
        return { ...decodePartyInvitation(invitation), ref: decodePartyRef(ref) };
    });
    const invitationParties = new Set<string>();
    for (const invitation of invitations) {
        if (
            invitation.principalId !== view.principalId || invitation.expiresAtEpochMs <= view.observedAtEpochMs ||
            invitation.createdAtEpochMs > view.observedAtEpochMs || invitationParties.has(invitation.ref.partyId) ||
            invitation.ref.partyId === party?.ref.partyId
        ) {
            throw new TypeError('Received party invitation has unrelated or expired consent');
        }
        invitationParties.add(invitation.ref.partyId);
    }
    for (const ref of [...(party === null ? [] : [party.ref]), ...invitations.map((invitation) => invitation.ref)]) {
        if (ref.applicationId !== scope.applicationId || ref.workspaceId !== scope.workspaceId) {
            throw new TypeError('Party view contains a foreign scope');
        }
    }
    return {
        scope,
        principalId: view.principalId,
        observedAtEpochMs: view.observedAtEpochMs,
        maxMembers: view.maxMembers,
        party,
        invitations
    };
}

function decodePartyRosterView(value: unknown, principalId: string, observedAtEpochMs: number): PartyRosterView {
    const roster = requireRecord(value, 'Party roster view');
    requireExactKeys(
        roster,
        ['ref', 'rosterRevision', 'leaderPrincipalId', 'members', 'invitations'],
        'Party roster view'
    );
    const ref = decodePartyRef(roster.ref);
    requireEpoch(roster.rosterRevision, 'Party roster revision');
    requireString(roster.leaderPrincipalId, 'Party leader');
    if (
        !Array.isArray(roster.members) || roster.members.length < 1 || roster.members.length > 16 ||
        !Array.isArray(roster.invitations) || roster.invitations.length > 256
    ) {
        throw new TypeError('Party roster view collections are invalid');
    }
    const members = roster.members.map(decodePartyMemberView);
    const memberIds = new Set<string>();
    let previous: string | null = null;
    for (const member of members) {
        if (
            memberIds.has(member.principalId) || (previous !== null && previous >= member.principalId) ||
            member.joinedAtEpochMs > observedAtEpochMs
        ) {
            throw new TypeError('Party members have duplicate, noncanonical or future identities');
        }
        memberIds.add(member.principalId);
        previous = member.principalId;
    }
    if (!memberIds.has(principalId) || !memberIds.has(roster.leaderPrincipalId)) {
        throw new TypeError('Party view requires the viewer and leader in its roster');
    }
    const invitations = roster.invitations.map(decodePartyInvitation);
    const recipients = new Set<string>();
    const ids = new Set<string>();
    for (const invitation of invitations) {
        if (
            principalId !== roster.leaderPrincipalId || !memberIds.has(invitation.senderPrincipalId) ||
            memberIds.has(invitation.principalId) || recipients.has(invitation.principalId) ||
            ids.has(invitation.invitationId) ||
            invitation.expiresAtEpochMs <= observedAtEpochMs || invitation.createdAtEpochMs > observedAtEpochMs
        ) {
            throw new TypeError('Party view exposes unrelated, duplicated or expired invitations');
        }
        recipients.add(invitation.principalId);
        ids.add(invitation.invitationId);
    }
    return {
        ref,
        rosterRevision: roster.rosterRevision,
        leaderPrincipalId: roster.leaderPrincipalId,
        members,
        invitations
    };
}

function decodePartyMemberView(value: unknown): PartyMemberView {
    const visible = requireRecord(value, 'Party member view');
    const { displayName, presence, ...member } = visible;
    requireString(displayName, 'Party member display name');
    return {
        ...decodePartyMember(member),
        displayName,
        presence: requireOneOf(presence, ['present', 'away'], 'Party member presence')
    };
}
