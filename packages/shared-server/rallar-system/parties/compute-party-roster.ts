import type { FriendshipStatus } from '@shared/api/friends/friendship.ts';
import type {
    PartyInvitation,
    PartyPolicy,
    PartyRef,
    PartyRefusal,
    PartyRosterIntent
} from '@shared/api/parties/party.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { PartyRecord } from './persistence/party-record.ts';

export interface PartyInvitationConsent {
    readonly sender: FriendshipStatus | null;
    readonly recipient: FriendshipStatus | null;
}

export interface PartyRosterInput {
    readonly ref: PartyRef;
    readonly actorPrincipalId: string;
    readonly actorPartyId: string | null;
    readonly targetPartyId: string | null;
    readonly targetInvitationCount: number;
    readonly record: PartyRecord | null;
    readonly expectedRosterRevision: number | null;
    readonly intent: PartyRosterIntent;
    readonly friendship: PartyInvitationConsent | null;
    readonly presentPrincipalIds: readonly string[];
    readonly capturedAtEpochMs: number;
    readonly nowEpochMs: number;
    readonly policy: PartyPolicy;
}

export interface PartyRosterComputed {
    readonly party: PartyRecord;
    readonly rosterChanged: boolean;
}

export function computePartyRoster(input: PartyRosterInput): Either<PartyRefusal, PartyRosterComputed> {
    if (input.intent.action === 'create') {
        return computePartyCreation(input);
    }
    const record = input.record;
    if (record === null || record.status !== 'active') {
        return Either.ofLeft('party-unavailable');
    }
    if (input.intent.action === 'accept' || input.intent.action === 'decline') {
        return computeInvitationResponse(input, record, input.intent);
    }
    if (input.actorPartyId !== record.ref.partyId || !isMember(record, input.actorPrincipalId)) {
        return Either.ofLeft('member-required');
    }
    if (input.expectedRosterRevision !== record.rosterRevision) {
        return Either.ofLeft('party-changed');
    }
    switch (input.intent.action) {
        case 'leave':
            return computePartyDeparture(input, record);
        case 'take-leadership':
            return computePartyTakeover(input, record);
        default:
            return record.leaderPrincipalId !== input.actorPrincipalId
                ? Either.ofLeft('leader-required')
                : computePartyLeaderAction(input, record, input.intent);
    }
}

function computePartyCreation(input: PartyRosterInput): Either<PartyRefusal, PartyRosterComputed> {
    if (input.record !== null) {
        return Either.ofLeft('party-unavailable');
    }
    if (input.actorPartyId !== null) {
        return Either.ofLeft('already-in-party');
    }
    return Either.ofRight({
        party: {
            ref: input.ref,
            status: 'active',
            leaderPrincipalId: input.actorPrincipalId,
            rosterRevision: 0,
            createdAtEpochMs: input.capturedAtEpochMs,
            members: [{ principalId: input.actorPrincipalId, joinedAtEpochMs: input.capturedAtEpochMs }],
            invitations: []
        },
        rosterChanged: true
    });
}

function computePartyLeaderAction(
    input: PartyRosterInput,
    record: PartyRecord,
    intent: Extract<PartyRosterIntent, { action: 'invite' | 'revoke' | 'transfer'; }> | Readonly<{ action: 'disband'; }>
): Either<PartyRefusal, PartyRosterComputed> {
    switch (intent.action) {
        case 'invite':
            return computePartyInvitation(input, record, intent);
        case 'revoke':
            return Either.ofRight({
                party: {
                    ...record,
                    invitations: record.invitations.filter((entry) => entry.invitationId !== intent.invitationId)
                },
                rosterChanged: false
            });
        case 'transfer':
            return !isMember(record, intent.principalId)
                ? Either.ofLeft('member-required')
                : Either.ofRight({
                    party: {
                        ...record,
                        leaderPrincipalId: intent.principalId,
                        rosterRevision: record.rosterRevision + Number(record.leaderPrincipalId !== intent.principalId)
                    },
                    rosterChanged: record.leaderPrincipalId !== intent.principalId
                });
        case 'disband':
            return Either.ofRight({
                party: {
                    ...record,
                    status: 'closed',
                    leaderPrincipalId: null,
                    members: [],
                    invitations: [],
                    rosterRevision: record.rosterRevision + 1
                },
                rosterChanged: true
            });
    }
}

function computePartyInvitation(
    input: PartyRosterInput,
    record: PartyRecord,
    intent: Extract<PartyRosterIntent, { action: 'invite'; }>
): Either<PartyRefusal, PartyRosterComputed> {
    if (input.friendship?.sender !== 'friend' || input.friendship.recipient !== 'friend') {
        return Either.ofLeft('person-unavailable');
    }
    if (isMember(record, intent.principalId)) {
        return Either.ofRight({ party: record, rosterChanged: false });
    }
    if (input.targetPartyId !== null) {
        return Either.ofLeft('person-unavailable');
    }
    const invitations = record.invitations.filter((entry) => entry.expiresAtEpochMs > input.nowEpochMs);
    if (invitations.some((entry) => entry.principalId === intent.principalId)) {
        return Either.ofRight({ party: { ...record, invitations }, rosterChanged: false });
    }
    if (invitations.some((entry) => entry.invitationId === intent.invitationId)) {
        return Either.ofLeft('invitation-unavailable');
    }
    if (
        invitations.length >= input.policy.maxInvitations || input.targetInvitationCount >= input.policy.maxInvitations
    ) {
        return Either.ofLeft('invitation-capacity');
    }
    const invitation: PartyInvitation = {
        invitationId: intent.invitationId,
        senderPrincipalId: input.actorPrincipalId,
        principalId: intent.principalId,
        createdAtEpochMs: input.capturedAtEpochMs,
        expiresAtEpochMs: input.capturedAtEpochMs + input.policy.invitationLifetimeMs
    };
    if (invitation.expiresAtEpochMs <= input.nowEpochMs) {
        return Either.ofLeft('invitation-unavailable');
    }
    return Either.ofRight({
        party: {
            ...record,
            invitations: [...invitations, invitation].sort((left, right) =>
                ordinal(left.invitationId, right.invitationId)
            )
        },
        rosterChanged: false
    });
}

function computeInvitationResponse(
    input: PartyRosterInput,
    record: PartyRecord,
    intent: Readonly<{ action: 'accept' | 'decline'; invitationId: string; }>
): Either<PartyRefusal, PartyRosterComputed> {
    const invitation = record.invitations.find((entry) =>
        entry.invitationId === intent.invitationId && entry.principalId === input.actorPrincipalId &&
        entry.expiresAtEpochMs > input.nowEpochMs && isMember(record, entry.senderPrincipalId)
    );
    if (invitation === undefined) {
        return Either.ofLeft('invitation-unavailable');
    }
    const invitations = record.invitations.filter((entry) => entry !== invitation);
    if (intent.action === 'decline') {
        return Either.ofRight({ party: { ...record, invitations }, rosterChanged: false });
    }
    if (input.friendship?.sender !== 'friend' || input.friendship.recipient !== 'friend') {
        return Either.ofLeft('person-unavailable');
    }
    if (input.actorPartyId !== null) {
        return Either.ofLeft('already-in-party');
    }
    if (record.members.length >= input.policy.maxMembers) {
        return Either.ofLeft('party-full');
    }
    return Either.ofRight({
        party: {
            ...record,
            members: [...record.members, { principalId: input.actorPrincipalId, joinedAtEpochMs: input.nowEpochMs }]
                .sort((left, right) => ordinal(left.principalId, right.principalId)),
            invitations,
            rosterRevision: record.rosterRevision + 1
        },
        rosterChanged: true
    });
}

function computePartyDeparture(
    input: PartyRosterInput,
    record: PartyRecord
): Either<PartyRefusal, PartyRosterComputed> {
    const members = record.members.filter((member) => member.principalId !== input.actorPrincipalId)
        .sort((left, right) => ordinal(left.principalId, right.principalId));
    const nextLeader =
        [...members].sort((left, right) =>
            left.joinedAtEpochMs - right.joinedAtEpochMs || ordinal(left.principalId, right.principalId)
        )[0]?.principalId ?? null;
    return Either.ofRight({
        party: {
            ...record,
            members,
            status: members.length === 0 ? 'closed' : 'active',
            leaderPrincipalId: record.leaderPrincipalId === input.actorPrincipalId
                ? nextLeader
                : record.leaderPrincipalId,
            invitations: record.invitations.filter((entry) => entry.senderPrincipalId !== input.actorPrincipalId),
            rosterRevision: record.rosterRevision + 1
        },
        rosterChanged: true
    });
}

function computePartyTakeover(input: PartyRosterInput, record: PartyRecord): Either<PartyRefusal, PartyRosterComputed> {
    if (record.leaderPrincipalId === input.actorPrincipalId) {
        return Either.ofRight({ party: record, rosterChanged: false });
    }
    if (record.leaderPrincipalId !== null && input.presentPrincipalIds.includes(record.leaderPrincipalId)) {
        return Either.ofLeft('leader-present');
    }
    if (!input.presentPrincipalIds.includes(input.actorPrincipalId)) {
        return Either.ofLeft('member-away');
    }
    return Either.ofRight({
        party: { ...record, leaderPrincipalId: input.actorPrincipalId, rosterRevision: record.rosterRevision + 1 },
        rosterChanged: true
    });
}

function isMember(record: PartyRecord, principalId: string): boolean {
    return record.members.some((member) => member.principalId === principalId);
}

function ordinal(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
