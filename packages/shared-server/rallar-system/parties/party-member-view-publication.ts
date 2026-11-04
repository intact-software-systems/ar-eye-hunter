import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import type { ClientMutationCommand, ClientMutationRead } from '../client-state/mutation/client-mutation-contracts.ts';
import { computeClientPresenceTransition } from '../client-state/mutation/client-presence-transition.ts';
import { computeSha256CanonicalJson } from '../protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication } from '../websocket/outbox/compute-view-invalidation-publication.ts';
import type { GuardedViewPublication } from '../websocket/outbox/guarded-view-publication.ts';
import { isPartyMemberPresent } from './party-member-presence.ts';
import { decodePartyRecord } from './persistence/decode-party-record.ts';
import {
    PARTY_ACCOUNTS_NAMESPACE,
    PARTY_RECORDS_NAMESPACE,
    partyRecordKey
} from './persistence/party-account.ts';
import { decodePartyAccountEntry } from './persistence/party-repository.ts';
import type { PartyRepository } from './persistence/party-repository.ts';

export interface PartyMemberViewRead {
    readonly account: PartyRepository.AccountRead;
    readonly party: PartyRepository.Read;
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
): GuardedViewPublication | null {
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
        storage: computeRuntimeStateGuardedBatchWrite({
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
        }),
        outbox: publication.outbox
    };
}

function hasPartyMemberViewChanged(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    snapshot: ClientSnapshot
): boolean {
    const transition = computeClientPresenceTransition(command, read, snapshot);
    const displayName = (value: ClientSnapshot | null) =>
        value?.principal.displayName?.trim() || command.aggregateRef.principalId;
    return displayName(transition.before) !== displayName(snapshot) ||
        isPartyMemberPresent(transition.before, transition.beforeAtEpochMs) !==
            isPartyMemberPresent(snapshot, transition.afterAtEpochMs);
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
