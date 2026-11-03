import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import { decodePartyRef } from '@shared/api/parties/party-request.ts';
import { decodePartyInvitation, decodePartyMember } from '@shared/api/parties/party.ts';
import type { PartyRef } from '@shared/api/parties/party.ts';

import type { PartyRecord } from './party-record.ts';

export function decodePartyRecord(value: unknown, expected: PartyRef): PartyRecord {
    const record = requireRecord(value, 'Party record');
    requireExactKeys(record, [
        'ref',
        'status',
        'leaderPrincipalId',
        'rosterRevision',
        'createdAtEpochMs',
        'members',
        'invitations'
    ], 'Party record');
    const ref = decodePartyRef(record.ref);
    if (
        ref.applicationId !== expected.applicationId || ref.workspaceId !== expected.workspaceId ||
        ref.partyId !== expected.partyId
    ) {
        throw new TypeError('Party record identity differs from its expected scope or slot');
    }
    const status = requireOneOf(record.status, ['active', 'closed'], 'Party status');
    requireEpoch(record.rosterRevision, 'Party roster revision');
    requireEpoch(record.createdAtEpochMs, 'Party creation');
    if (record.leaderPrincipalId !== null) {
        requireString(record.leaderPrincipalId, 'Party leader');
    }
    if (!Array.isArray(record.members) || !Array.isArray(record.invitations)) {
        throw new TypeError('Party collections are invalid');
    }
    const members = record.members.map(decodePartyMember);
    const invitations = record.invitations.map(decodePartyInvitation);
    const decoded: PartyRecord = {
        ref,
        status,
        leaderPrincipalId: record.leaderPrincipalId,
        rosterRevision: record.rosterRevision,
        createdAtEpochMs: record.createdAtEpochMs,
        members,
        invitations
    };
    assertPartyRoster(decoded);
    assertPartyInvitations(decoded);
    return decoded;
}

function assertPartyRoster(record: PartyRecord): void {
    const { members, leaderPrincipalId, status } = record;
    if (status === 'closed') {
        if (members.length !== 0 || leaderPrincipalId !== null || record.invitations.length !== 0) {
            throw new TypeError('Closed party retains membership, leadership or invitations');
        }
        return;
    }
    if (
        members.length < 1 || members.length > 16 || !members.some((member) => member.principalId === leaderPrincipalId)
    ) {
        throw new TypeError('Active party membership or leadership is invalid');
    }
    let previous: string | null = null;
    for (const member of members) {
        if (
            (previous !== null && member.principalId <= previous) || member.joinedAtEpochMs < record.createdAtEpochMs
        ) {
            throw new TypeError('Party membership has duplicate, noncanonical or invalid entries');
        }
        previous = member.principalId;
    }
}

function assertPartyInvitations(record: PartyRecord): void {
    if (record.invitations.length > 256) {
        throw new TypeError('Party invitation collection exceeds its bound');
    }
    const memberIds = new Set(record.members.map((member) => member.principalId));
    const recipients = new Set<string>();
    let previous: string | null = null;
    for (const invitation of record.invitations) {
        if (
            !memberIds.has(invitation.senderPrincipalId) || memberIds.has(invitation.principalId) ||
            recipients.has(invitation.principalId) || (previous !== null && invitation.invitationId <= previous) ||
            invitation.createdAtEpochMs < record.createdAtEpochMs
        ) {
            throw new TypeError('Party invitation identity, consent or lifetime is invalid');
        }
        recipients.add(invitation.principalId);
        previous = invitation.invitationId;
    }
}
