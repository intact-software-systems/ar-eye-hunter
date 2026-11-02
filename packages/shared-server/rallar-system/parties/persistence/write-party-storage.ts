import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchWrite
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { insertRuntimeState, type RuntimeStateInsert } from '../../../runtime-state/postgres/insert-runtime-state.ts';
import { writeRuntimeStateGuardedBatch } from '../../../runtime-state/postgres/write-runtime-state-guarded-batch.ts';
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
import type { PartyRepository } from './party-repository.ts';

export interface PartyStorageInput {
    readonly read: PartyRepository.Read;
    readonly party: PartyRecord;
}

export interface PartyStorageWrite {
    readonly creation: RuntimeStateInsert | null;
    readonly batch: RuntimeStateGuardedBatchWrite;
    readonly accountInserts: readonly RuntimeStateInsert[];
}

export function computePartyStorage(input: PartyStorageInput): PartyStorageWrite {
    const { read } = input;
    const party = decodePartyRecord(input.party, read.ref);
    const value = JSON.stringify(party);
    const accounts = computePartyAccounts(read, party);
    const accountInserts: RuntimeStateInsert[] = [];
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    for (const { entry, account } of accounts) {
        const key = partyAccountKey(account.scope, account.principalId);
        const value = JSON.stringify(decodePartyAccount(account, account.scope, account.principalId));
        if (entry === null) {
            accountInserts.push(toInsert(PARTY_ACCOUNTS_NAMESPACE, key, value));
        }
        else {
            effects.push({
                effectId: `account:${account.principalId}`,
                operation: 'update',
                namespace: PARTY_ACCOUNTS_NAMESPACE,
                key,
                value,
                expectedRevision: entry.revision,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            });
        }
    }
    const key = partyRecordKey(read.ref);
    return {
        creation: read.entry === null ? toInsert(PARTY_RECORDS_NAMESPACE, key, value) : null,
        batch: computeRuntimeStateGuardedBatchWrite({
            guard: {
                operation: 'update',
                namespace: PARTY_RECORDS_NAMESPACE,
                key,
                value,
                expectedRevision: read.entry?.revision ?? 0,
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            },
            effects
        }),
        accountInserts
    };
}

export async function writePartyStorage(transaction: PSqlSql, computed: PartyStorageWrite): Promise<void> {
    if (computed.creation !== null) {
        await insertRuntimeState(transaction, computed.creation);
    }
    const result = await writeRuntimeStateGuardedBatch(transaction, computed.batch);
    if (result.guard.status !== 'applied' || result.effects.some((effect) => effect.status !== 'applied')) {
        throw new RuntimeStateWriteConflictError();
    }
    for (const insert of computed.accountInserts) {
        await insertRuntimeState(transaction, insert);
    }
}

function computePartyAccounts(read: PartyRepository.Read, party: PartyRecord): readonly PartyRepository.AccountRead[] {
    const principalIds = new Set([
        ...read.record?.members.map((member) => member.principalId) ?? [],
        ...read.record?.invitations.map((invitation) => invitation.principalId) ?? [],
        ...party.members.map((member) => member.principalId),
        ...party.invitations.map((invitation) => invitation.principalId)
    ]);
    return [...principalIds].sort().map((principalId) => {
        const stored = read.accounts.find((candidate) => candidate.account.principalId === principalId);
        if (stored === undefined) {
            throw new TypeError('Party account write requires an exact observed pointer');
        }
        return { entry: stored.entry, account: computePartyAccount(stored.account, party, read.observedAtEpochMs) };
    });
}

function computePartyAccount(account: PartyAccount, party: PartyRecord, nowEpochMs: number): PartyAccount {
    const member = party.members.some((member) => member.principalId === account.principalId);
    if (member && account.partyId !== null && account.partyId !== party.ref.partyId) {
        throw new TypeError('Party admission computation retained another party membership');
    }
    const invitation = party.invitations.find((invitation) => invitation.principalId === account.principalId);
    const invitations = account.invitations.filter((entry) =>
        entry.partyId !== party.ref.partyId && entry.expiresAtEpochMs > nowEpochMs
    );
    if (invitation !== undefined && invitation.expiresAtEpochMs > nowEpochMs) {
        invitations.push({
            partyId: party.ref.partyId,
            invitationId: invitation.invitationId,
            expiresAtEpochMs: invitation.expiresAtEpochMs
        });
    }
    return {
        ...account,
        partyId: member ? party.ref.partyId : account.partyId === party.ref.partyId ? null : account.partyId,
        invitations: invitations.sort((left, right) =>
            left.partyId < right.partyId ? -1 : left.partyId > right.partyId ? 1 : 0
        )
    };
}

function toInsert(namespace: string, key: string, value: string): RuntimeStateInsert {
    return { namespace, key, value, expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString() };
}
