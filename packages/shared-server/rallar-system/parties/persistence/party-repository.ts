import type { PartyRef } from '@shared/api/parties/party.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { assertRuntimeStateReadBatchResult } from '../../../runtime-state/read-batch/assert-runtime-state-read-batch-result.ts';
import type { RuntimeStateReadBatchSelector } from '../../../runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry, RuntimeStateRepositoryLike } from '../../../runtime-state/runtime-state-repository.ts';
import { decodePartyRecord } from './decode-party-record.ts';
import {
    decodePartyAccount,
    PARTY_ACCOUNTS_NAMESPACE,
    PARTY_RECORDS_NAMESPACE,
    partyAccountKey,
    partyRecordKey
} from './party-account.ts';
import type { PartyAccount } from './party-account.ts';
import type { PartyRecord } from './party-record.ts';

export namespace PartyRepository {
    export interface AccountRead {
        readonly entry: RuntimeStateEntry | null;
        readonly account: PartyAccount;
    }
    export interface Read {
        readonly ref: PartyRef;
        readonly observedAtEpochMs: number;
        readonly entry: RuntimeStateEntry | null;
        readonly record: PartyRecord | null;
        readonly accounts: readonly AccountRead[];
    }
}

export class PartyRepository {
    private readonly runtime: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>;

    private readonly nowEpochMs: () => number;

    constructor(
        runtime: Pick<RuntimeStateRepositoryLike, 'findEntry' | 'readRuntimeStateBatch'>,
        nowEpochMs: () => number
    ) {
        this.runtime = runtime;
        this.nowEpochMs = nowEpochMs;
    }

    async read(ref: PartyRef, principalIds: readonly string[] = []): Promise<PartyRepository.Read> {
        const initial = decodeStoredParty(
            await this.runtime.findEntry(PARTY_RECORDS_NAMESPACE, partyRecordKey(ref)),
            ref
        );
        const principals = [
            ...new Set([
                ...principalIds,
                ...initial.record?.members.map((member) => member.principalId) ?? [],
                ...initial.record?.invitations.map((invitation) => invitation.principalId) ?? []
            ])
        ].sort();
        const selectors: RuntimeStateReadBatchSelector[] = [
            { selectorId: 'party', kind: 'key', namespace: PARTY_RECORDS_NAMESPACE, key: partyRecordKey(ref) },
            ...principals.map((principalId, index): RuntimeStateReadBatchSelector => ({
                selectorId: `account:${index}`,
                kind: 'key',
                namespace: PARTY_ACCOUNTS_NAMESPACE,
                key: partyAccountKey(ref, principalId)
            }))
        ];
        const selections = assertRuntimeStateReadBatchResult(
            selectors,
            await this.runtime.readRuntimeStateBatch(selectors)
        );
        const current = decodeStoredParty(selections[0].entries[0], ref);
        if (initial.entry?.revision !== current.entry?.revision || initial.entry?.value !== current.entry?.value) {
            throw new RuntimeStateWriteConflictError();
        }
        const accounts = principals.map((principalId, index) =>
            decodeStoredAccount(selections[index + 1].entries[0], ref, principalId)
        );
        const observedAtEpochMs = this.nowEpochMs();
        assertPartyAccountLinks(current.record, accounts, observedAtEpochMs);
        return { ref, ...current, accounts, observedAtEpochMs };
    }

    async readAccount(scope: StateScope, principalId: string): Promise<PartyRepository.AccountRead> {
        const entry = await this.runtime.findEntry(PARTY_ACCOUNTS_NAMESPACE, partyAccountKey(scope, principalId));
        return decodeStoredAccount(entry, scope, principalId);
    }
}

function decodeStoredParty(entry: RuntimeStateEntry | undefined, ref: PartyRef) {
    if (entry === undefined) {
        return { entry: null, record: null };
    }
    if (entry.key !== partyRecordKey(ref) || entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
        throw new TypeError('Party record storage identity or lifetime is invalid');
    }
    return { entry, record: decodePartyRecord(JSON.parse(entry.value), ref) };
}

function decodeStoredAccount(
    entry: RuntimeStateEntry | undefined,
    scope: StateScope,
    principalId: string
): PartyRepository.AccountRead {
    const canonicalScope = { applicationId: scope.applicationId, workspaceId: scope.workspaceId };
    if (entry === undefined) {
        return { entry: null, account: { scope: canonicalScope, principalId, partyId: null, invitations: [] } };
    }
    if (entry.key !== partyAccountKey(scope, principalId) || entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
        throw new TypeError('Party account storage identity or lifetime is invalid');
    }
    return { entry, account: decodePartyAccount(JSON.parse(entry.value), canonicalScope, principalId) };
}

function assertPartyAccountLinks(
    record: PartyRecord | null,
    accounts: readonly PartyRepository.AccountRead[],
    nowEpochMs: number
): void {
    if (record === null) {
        return;
    }
    for (const member of record.members) {
        if (
            accounts.find((stored) => stored.account.principalId === member.principalId)?.account.partyId !==
                record.ref.partyId
        ) {
            throw new TypeError('Party membership lost its exact account lookup');
        }
    }
    for (const invitation of record.invitations) {
        // Both complete records have already decoded. Expired consent no longer owns an account lookup slot.
        if (invitation.expiresAtEpochMs <= nowEpochMs) {
            continue;
        }
        const account = accounts.find((stored) => stored.account.principalId === invitation.principalId)?.account;
        if (
            !account?.invitations.some((entry) =>
                entry.partyId === record.ref.partyId && entry.invitationId === invitation.invitationId &&
                entry.expiresAtEpochMs === invitation.expiresAtEpochMs
            )
        ) {
            throw new TypeError('Party invitation lost its exact account lookup');
        }
    }
}
