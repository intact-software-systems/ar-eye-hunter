import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import type { PartyRef } from '@shared/api/parties/party.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import {
    groupStateChildStorageKeySuffix,
    groupStateScopeStorageKey
} from '../../group-state/persistence/aggregate/group-aggregate-storage-keys.ts';

export interface PartyAccountInvitation {
    readonly partyId: string;
    readonly invitationId: string;
    readonly expiresAtEpochMs: number;
}

export interface PartyAccount {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly partyId: string | null;
    readonly invitations: readonly PartyAccountInvitation[];
}

export const PARTY_RECORDS_NAMESPACE = 'parties:records';
export const PARTY_ACCOUNTS_NAMESPACE = 'parties:accounts';

export function partyRecordKey(ref: PartyRef): string {
    return groupStateScopeStorageKey(ref) + groupStateChildStorageKeySuffix('party', ref.partyId);
}

export function partyAccountKey(scope: StateScope, principalId: string): string {
    return groupStateScopeStorageKey(scope) + groupStateChildStorageKeySuffix('principal', principalId);
}

export function decodePartyAccount(value: unknown, scope: StateScope, principalId: string): PartyAccount {
    const account = requireRecord(value, 'Party account');
    requireExactKeys(account, ['scope', 'principalId', 'partyId', 'invitations'], 'Party account');
    const storedScope = requireRecord(account.scope, 'Party account scope');
    requireExactKeys(storedScope, ['applicationId', 'workspaceId'], 'Party account scope');
    if (
        storedScope.applicationId !== scope.applicationId || storedScope.workspaceId !== scope.workspaceId ||
        account.principalId !== principalId
    ) {
        throw new TypeError('Party account identity differs from its expected slot');
    }
    if (account.partyId !== null) {
        requireString(account.partyId, 'Current party identity');
    }
    if (!Array.isArray(account.invitations) || account.invitations.length > 256) {
        throw new TypeError('Party account invitation collection is invalid');
    }
    const invitations = account.invitations.map(decodeAccountInvitation);
    for (let index = 1; index < invitations.length; index++) {
        if (invitations[index - 1]!.partyId >= invitations[index]!.partyId) {
            throw new TypeError('Party account invitations have duplicate or noncanonical identities');
        }
    }
    return { scope, principalId, partyId: account.partyId, invitations };
}

function decodeAccountInvitation(value: unknown): PartyAccountInvitation {
    const invitation = requireRecord(value, 'Party account invitation');
    requireExactKeys(invitation, ['partyId', 'invitationId', 'expiresAtEpochMs'], 'Party account invitation');
    requireString(invitation.partyId, 'Inviting party identity');
    requireString(invitation.invitationId, 'Party invitation identity');
    requireEpoch(invitation.expiresAtEpochMs, 'Party invitation lookup expiry');
    return {
        partyId: invitation.partyId,
        invitationId: invitation.invitationId,
        expiresAtEpochMs: invitation.expiresAtEpochMs
    };
}
