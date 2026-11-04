import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchGuard
} from '../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    writeRuntimeStateConditionalBatch,
    type RuntimeStateConditionalBatch
} from '../../runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { writeAppOutboxInserts, type AppOutboxInsert } from '../app-outbox/app-outbox-insert.ts';
import type { ClientMutationCommand, ClientMutationRead } from '../client-state/mutation/client-mutation-contracts.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication } from '../websocket/outbox/compute-view-invalidation-publication.ts';
import { isPartyMemberPresent } from './party-member-presence.ts';
import { decodePartyRecord } from './persistence/decode-party-record.ts';
import { PARTY_ACCOUNTS_NAMESPACE, PARTY_RECORDS_NAMESPACE, partyRecordKey } from './persistence/party-account.ts';
import { decodePartyAccountEntry } from './persistence/party-repository.ts';
import type { PartyRepository } from './persistence/party-repository.ts';

export interface PartyMemberViewRead {
    readonly account: PartyRepository.AccountRead;
    readonly party: PartyRepository.Read;
}

export interface PartyMemberViewPublication {
    readonly storage: RuntimeStateConditionalBatch;
    readonly outbox: readonly AppOutboxInsert[];
}

/** An indexed account lookup followed by its one current party, never a scope scan or a co-group audience. */
export async function readPartyMemberView(
    parties: PartyRepository,
    ref: ClientPrincipalRef
): Promise<PartyMemberViewRead | null> {
    const account = await parties.readAccount(ref, ref.principalId);
    if (account.account.partyId === null) {
        // Create and accept CAS this same client principal: a concurrent join invalidates the client's predecessor.
        return null;
    }
    const party = await parties.read({
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        partyId: account.account.partyId
    }, [ref.principalId]);
    const current = party.accounts.find((candidate) => candidate.account.principalId === ref.principalId);
    if (current?.entry?.revision !== account.entry?.revision || current?.entry?.value !== account.entry?.value) {
        throw new RuntimeStateWriteConflictError();
    }
    if (
        party.record?.status !== 'active' ||
        !party.record.members.some((member) => member.principalId === ref.principalId)
    ) {
        throw new TypeError('Party member view lost its exact account membership');
    }
    return { account, party };
}

/** Applied mutations only: ordinary live heartbeats and additional-session changes have no visible party effect. */
export function computePartyMemberViewPublication(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    snapshot: ClientSnapshot
): PartyMemberViewPublication | null {
    const member = read.partyMemberView;
    if (member === null || !hasPartyMemberViewChanged(command, read, snapshot)) {
        return null;
    }
    const account = member.account.entry;
    const party = member.party.entry;
    const record = member.party.record;
    if (!account || !party || !record) {
        throw new TypeError('Party member view requires exact persisted predecessors');
    }
    const publication = computeViewInvalidationPublication({
        resource: 'party',
        scope: { applicationId: command.aggregateRef.applicationId, workspaceId: command.aggregateRef.workspaceId },
        principalIds: record.members.map((candidate) => candidate.principalId),
        changeId: computeSha256CanonicalJson({
            principal: command.aggregateRef,
            commandId: command.commandId,
            stateRevision: snapshot.stateRevision,
            partyRevision: party.revision
        }),
        createdAtEpochMs: command.facts.nowEpochMs,
        retentionMs: command.facts.expireAtEpochMs - command.facts.nowEpochMs,
        serviceId: command.facts.serviceId,
        traceId: command.facts.traceId
    });
    return {
        storage: {
            creation: null,
            inserts: [],
            batch: computeRuntimeStateGuardedBatchWrite({
                guard: {
                    operation: 'update',
                    namespace: PARTY_RECORDS_NAMESPACE,
                    key: party.key,
                    value: party.value,
                    expectedRevision: party.revision,
                    expireAtTimestamp: party.expireAtTimestamp
                },
                effects: [
                    {
                        effectId: 'party-account',
                        operation: 'update',
                        namespace: PARTY_ACCOUNTS_NAMESPACE,
                        key: account.key,
                        value: account.value,
                        expectedRevision: account.revision,
                        expireAtTimestamp: account.expireAtTimestamp
                    },
                    ...publication.provenance
                ]
            })
        },
        outbox: publication.outbox
    };
}

function hasPartyMemberViewChanged(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    snapshot: ClientSnapshot
): boolean {
    const observedAt = Math.max(read.audienceObservedAtEpochMs, command.facts.nowEpochMs);
    const oldSession = read.session?.value;
    const endsSession = command.operation === 'expireSession' || command.operation === 'disconnectSession' ||
        command.operation === 'disconnectAuthorisedWsSession';
    const beforeAt = endsSession && oldSession ? Math.min(observedAt, oldSession.expiresAtEpochMs - 1) : observedAt;
    // Durable snapshot assembly can already filter an expired session; expiry still represents its last visible transition.
    const before = endsSession && oldSession && read.snapshot
        ? {
            ...read.snapshot,
            activeSessions: [
                ...read.snapshot.activeSessions.filter((session) => session.sessionId !== oldSession.sessionId),
                oldSession
            ]
        }
        : read.snapshot;
    const displayName = (value: ClientSnapshot | null) =>
        value?.principal.displayName?.trim() || command.aggregateRef.principalId;
    return displayName(before) !== displayName(snapshot) ||
        isPartyMemberPresent(before, beforeAt) !== isPartyMemberPresent(snapshot, observedAt);
}

/** Runs inside the client mutation's transaction, after its principal CAS (and the WS ticket/generation guard). */
export async function writePartyMemberViewPublication(
    transaction: PSqlSql,
    publication: PartyMemberViewPublication | null
): Promise<void> {
    if (publication === null) {
        return;
    }
    await writeRuntimeStateConditionalBatch(transaction, publication.storage);
    await writeAppOutboxInserts(transaction, publication.outbox);
}

/** A forged read cannot lend membership authority to another scope or another account. */
export function assertPartyMemberViewRead(ref: ClientPrincipalRef, member: PartyMemberViewRead | null): void {
    if (member === null) {
        return;
    }
    const account = decodePartyAccountEntry(member.account.entry ?? undefined, ref, ref.principalId);
    const entry = member.party.entry;
    if (
        !account.entry || account.account.partyId === null || !entry ||
        entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP
    ) {
        throw new TypeError('Party member view is missing durable membership');
    }
    const partyRef = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        partyId: account.account.partyId
    };
    const record = decodePartyRecord(JSON.parse(entry.value), partyRef);
    if (
        entry.key !== partyRecordKey(partyRef) || !jsonEquals(member.account.account, account.account) ||
        !jsonEquals(member.party.ref, partyRef) || !jsonEquals(member.party.record, record) ||
        record.status !== 'active' || !record.members.some((candidate) => candidate.principalId === ref.principalId)
    ) {
        throw new TypeError('Party member view differs from its exact stored membership');
    }
}

/** Page mutations share party/account predecessors; guard each exact observation once in the same transaction. */
export function combinePartyMemberViewPublications(
    publications: readonly (PartyMemberViewPublication | null)[]
): PartyMemberViewPublication | null {
    const rows = new Map<string, RuntimeStateGuardedBatchGuard>();
    const outbox: AppOutboxInsert[] = [];
    for (const publication of publications) {
        if (publication === null) {
            continue;
        }
        for (const row of [publication.storage.batch.guard, ...publication.storage.batch.effects]) {
            if (row.operation !== 'insert' && row.operation !== 'update') {
                throw new TypeError('Party member publication has an unexpected persistence operation');
            }
            const canonical: RuntimeStateGuardedBatchGuard = row.operation === 'insert'
                ? {
                    operation: 'insert',
                    namespace: row.namespace,
                    key: row.key,
                    value: row.value,
                    expireAtTimestamp: row.expireAtTimestamp
                }
                : {
                    operation: 'update',
                    namespace: row.namespace,
                    key: row.key,
                    value: row.value,
                    expireAtTimestamp: row.expireAtTimestamp,
                    expectedRevision: row.expectedRevision
                };
            const identity = JSON.stringify([row.namespace, row.key]);
            const previous = rows.get(identity);
            if (previous !== undefined && !jsonEquals(previous, canonical)) {
                throw new RuntimeStateWriteConflictError();
            }
            rows.set(identity, canonical);
        }
        outbox.push(...publication.outbox);
    }
    const [guard, ...remaining] = rows.values();
    if (guard === undefined) {
        return null;
    }
    const effects: RuntimeStateGuardedBatchEffect[] = remaining.map((row, index) => ({
        ...row,
        effectId: `party-publication:${index}`
    }));
    return {
        storage: { creation: null, inserts: [], batch: computeRuntimeStateGuardedBatchWrite({ guard, effects }) },
        outbox
    };
}
