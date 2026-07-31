import type {
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef,
    GroupScope,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryRead,
    type RuntimeStateEntryValue,
} from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import {
    PSqlRuntimeStateRepository,
} from '../../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
    PSqlGroupStateEventRepository,
} from '../../../postgres/rallar-system/PSqlStateEventRepository.ts';
import type { GroupMutationIdempotencyRecord } from '../mutation/group-mutation-contracts.ts';
import type {
    GroupSnapshotPage,
    GroupSnapshotPageOptions,
} from '../group-state-service-contracts.ts';
import { defaultGroupStateEventStoreFor } from '../../repositories/StateEventStore.ts';
import type { StateEventListQuery } from '../../state-event-listing.ts';
import {
    assertStoredIdempotency,
    canonicalStoredGroup,
    GroupAggregateRepository,
} from './group-aggregate-repository.ts';
import {
    canonicalStoredMember,
    GroupMembershipRepository,
} from './group-membership-repository.ts';
import {
    canonicalStoredAdmission,
    canonicalStoredSession,
    canonicalStoredSummary,
    GroupPresenceRepository,
} from './group-presence-repository.ts';
import {
    toLiveGroupStateEntryValue,
    type GroupStateAuthoritativeSnapshot,
    type GroupStateAuthorityGuard,
    type GroupStateRepositoryOptions,
} from './group-state-persistence-contracts.ts';
import { GroupStateSnapshotRepository } from './group-state-snapshot-repository.ts';
import {
    readGroupStateMutationExactEntries,
    type GroupStateMutationExactReadInput,
    type GroupStateMutationExactReadResult,
} from './read-exact-group-state-mutation.ts';

export function createTransactionBoundGroupStateRepository(
    transaction: PSqlTransactionSql,
): GroupStateRepository {
    return new GroupStateRepository(
        new PSqlRuntimeStateRepository(transaction),
        { events: new PSqlGroupStateEventRepository(transaction) },
    );
}

export class GroupStateRepository extends RuntimeStateJsonStore {
    private readonly aggregate: GroupAggregateRepository;
    private readonly membership: GroupMembershipRepository;
    private readonly presence: GroupPresenceRepository;
    private readonly snapshots: GroupStateSnapshotRepository;
    constructor(
        repository: RuntimeStateRepositoryLike,
        options: GroupStateRepositoryOptions = {},
    ) {
        super(repository);
        const events = options.events ?? defaultGroupStateEventStoreFor(repository);
        this.aggregate = new GroupAggregateRepository(repository, events);
        this.membership = new GroupMembershipRepository(repository);
        this.presence = new GroupPresenceRepository(repository);
        this.snapshots = new GroupStateSnapshotRepository(repository);
    }

    async readMutationExactEntries(
        input: GroupStateMutationExactReadInput,
    ): Promise<GroupStateMutationExactReadResult> {
        return await readGroupStateMutationExactEntries(
            this.repository,
            input,
            async (namespace, entry) =>
                await this.toLiveEntryValue<unknown>(namespace, entry),
            {
                group: (entry) => canonicalStoredGroup(entry, input.aggregateRef),
                presenceSummary: (entry) =>
                    canonicalStoredSummary(entry, input.aggregateRef),
                idempotency: (requestId, entry) => {
                    const stored = entry as RuntimeStateEntryValue<
                        GroupMutationIdempotencyRecord
                    >;
                    assertStoredIdempotency(stored, {
                        ...input.aggregateRef,
                        requestId,
                    });
                    return stored;
                },
                member: (principalId, entry) => canonicalStoredMember(entry, {
                    ...input.aggregateRef,
                    principalId,
                }),
                presenceSession: (sessionId, entry) =>
                    canonicalStoredSession(entry, {
                        ...input.aggregateRef,
                        sessionId,
                    }),
                admission: (principalId, entry) => canonicalStoredAdmission(entry, {
                    ...input.aggregateRef,
                    principalId,
                }),
            },
        );
    }

    protected override async toLiveEntryValue<T>(
        namespace: string,
        entry: RuntimeStateEntry,
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        void namespace;
        return await toLiveGroupStateEntryValue<T>(entry);
    }
    async insertIdempotentGroupMutationReceipt(
        ref: GroupRef,
        requestId: string,
        record: GroupMutationIdempotencyRecord,
        purgeAfterEpochMs: number = NEVER_EXPIRE_AT_TIMESTAMP,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.aggregate.insertIdempotentGroupMutationReceipt(
            ref,
            requestId,
            record,
            purgeAfterEpochMs,
        );
    }

    async findIdempotentGroupMutationReceipt(
        ref: GroupRef,
        requestId: string,
    ): Promise<GroupMutationIdempotencyRecord | undefined> {
        return (await this.findIdempotentGroupMutationReceiptEntry(ref, requestId))
            ?.value;
    }

    async findIdempotentGroupMutationReceiptEntry(
        ref: GroupRef,
        requestId: string,
    ): Promise<RuntimeStateEntryValue<GroupMutationIdempotencyRecord> | undefined> {
        return await this.aggregate.findIdempotentGroupMutationReceiptEntry(
            ref,
            requestId,
        );
    }

    async findGroupEntry(
        ref: GroupRef,
    ): Promise<RuntimeStateEntryValue<Group> | undefined> {
        return (await this.readGroupEntry(ref)).value;
    }

    async readGroupEntry(ref: GroupRef): Promise<RuntimeStateEntryRead<Group>> {
        return await this.aggregate.readGroupEntry(ref);
    }

    async insertGroup(group: Group): Promise<RuntimeStateConditionalWriteResult> {
        return await this.aggregate.insertGroup(group);
    }
    async updateGroup(
        group: Group,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.aggregate.updateGroup(group, expectedRevision);
    }

    async advanceAuthorityFence(
        guard: GroupStateAuthorityGuard,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.aggregate.advanceAuthorityFence(guard);
    }
    async putGroup(group: Group): Promise<void> { await this.aggregate.putGroup(group); }

    async findGroup(ref: GroupRef): Promise<Group | undefined> {
        return (await this.findGroupEntry(ref))?.value; }
    async readStateRevision(ref: GroupRef): Promise<number | undefined> {
        const causalRevision = await this.readCausalRevision(ref);
        return causalRevision
            ? toGroupSnapshotStateRevision(
                causalRevision.groupRevision,
                causalRevision.presenceRevision,
            )
            : undefined;
    }

    async readCausalRevision(
        ref: GroupRef,
    ): Promise<
        import('@shared/api/group-types.ts').GroupStateCausalRevision | undefined
    > {
        const [stored, summary] = await Promise.all([
            this.findGroupEntry(ref),
            this.findPresenceSummaryEntry(ref),
        ]);
        return stored
            ? {
                groupRevision: stored.value.snapshotVersion,
                presenceRevision:
                    summary?.value.causalRevision.presenceRevision ?? 0,
            }
            : undefined;
    }
    async listGroups(scope: GroupScope): Promise<readonly Group[]> {
        return await this.aggregate.listGroups(scope); }
    async listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]> {
        return await this.snapshots.listSnapshots(scope); }
    async listSnapshotsPage(
        scope: GroupScope,
        options: GroupSnapshotPageOptions,
    ): Promise<GroupSnapshotPage> {
        return await this.snapshots.listSnapshotsPage(scope, options);
    }

    async findGroupBySlug(
        scope: GroupScope,
        slug: string,
    ): Promise<Group | undefined> {
        return (await this.listGroups(scope)).find((group) => group.slug === slug);
    }
    async removeGroup(ref: GroupRef): Promise<void> {
        await this.aggregate.removeGroup(ref); }
    async putMember(member: GroupMember): Promise<void> {
        await this.membership.putMember(member); }
    async findMember(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<GroupMember | undefined> {
        return (await this.findMemberEntry(ref))?.value; }

    async findMemberEntry(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<RuntimeStateEntryValue<GroupMember> | undefined> {
        return await this.membership.findMemberEntry(ref);
    }
    async listMembers(ref: GroupRef): Promise<readonly GroupMember[]> {
        return (await this.listMemberEntries(ref)).map(({ value }) => value); }

    async listMemberEntries(
        ref: GroupRef,
    ): Promise<readonly RuntimeStateEntryValue<GroupMember>[]> {
        return await this.membership.listMemberEntries(ref);
    }
    async removeMember(ref: GroupRef & Readonly<{ principalId: string }>): Promise<void> {
        await this.membership.removeMember(ref); }

    async putPresenceSession(session: GroupPresenceSession): Promise<void> {
        await this.presence.putPresenceSession(session); }
    async findPresenceEntry(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<RuntimeStateEntryValue<GroupPresenceSession> | undefined> {
        return (await this.readPresenceEntry(ref)).value; }

    async readPresenceEntry(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<RuntimeStateEntryRead<GroupPresenceSession>> {
        return await this.presence.readPresenceEntry(ref);
    }

    async insertPresence(
        session: GroupPresenceSession,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.insertPresence(session);
    }

    async updatePresence(
        session: GroupPresenceSession,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.updatePresence(session, expectedRevision);
    }

    async deletePresence(
        ref: GroupRef & Readonly<{ sessionId: string }>,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.presence.deletePresence(ref, expectedRevision);
    }

    async findPresenceSession(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<GroupPresenceSession | undefined> {
        return (await this.findPresenceEntry(ref))?.value; }

    async listPresenceSessions(ref: GroupRef): Promise<readonly GroupPresenceSession[]> {
        return (await this.listPresenceSessionEntries(ref)).map(({ value }) => value); }

    async listPresenceSessionEntries(
        ref: GroupRef,
    ): Promise<readonly RuntimeStateEntryValue<GroupPresenceSession>[]> {
        return await this.presence.listPresenceSessionEntries(ref);
    }

    async findPresenceAdmissionEntry(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<RuntimeStateEntryValue<GroupPresenceAdmission> | undefined> {
        return await this.presence.findPresenceAdmissionEntry(ref);
    }

    async insertPresenceAdmission(
        admission: GroupPresenceAdmission,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.insertPresenceAdmission(admission);
    }

    async updatePresenceAdmission(
        admission: GroupPresenceAdmission,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.updatePresenceAdmission(admission, expectedRevision);
    }

    async listPresenceAdmissions(ref: GroupRef): Promise<readonly GroupPresenceAdmission[]> {
        return (await this.listPresenceAdmissionEntries(ref)).map(({ value }) => value); }

    async listPresenceAdmissionEntries(
        ref: GroupRef,
    ): Promise<readonly RuntimeStateEntryValue<GroupPresenceAdmission>[]> {
        return await this.presence.listPresenceAdmissionEntries(ref);
    }

    async listAllPresenceSessions(): Promise<readonly GroupPresenceSession[]> {
        return await this.presence.listAllPresenceSessions(); }

    async removePresenceSession(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<void> {
        await this.presence.removePresenceSession(ref);
    }

    async findPresenceSummaryEntry(
        ref: GroupRef,
    ): Promise<RuntimeStateEntryValue<GroupPresenceSummary> | undefined> {
        return await this.presence.findPresenceSummaryEntry(ref);
    }

    async insertPresenceSummary(
        summary: GroupPresenceSummary,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.insertPresenceSummary(summary);
    }

    async updatePresenceSummary(
        summary: GroupPresenceSummary,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.updatePresenceSummary(summary, expectedRevision);
    }

    async appendEvent(event: GroupEvent): Promise<void> {
        await this.aggregate.appendEvent(event); }
    async listEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
        return await this.aggregate.listEvents(ref); }
    async listRecentEvents(
        ref: GroupRef,
        query: StateEventListQuery = {},
    ): Promise<readonly GroupEvent[]> {
        return await this.aggregate.listRecentEvents(ref, query);
    }

    async listEventPage(
        ref: GroupRef,
        query: StateEventListQuery = {},
    ): Promise<StateEventPage<GroupEvent>> {
        return await this.aggregate.listEventPage(ref, query);
    }

    async readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined> {
        return (await this.readSnapshotWithAuthorityGuard(ref))?.snapshot; }

    async readSnapshotWithAuthorityGuard(
        ref: GroupRef,
    ): Promise<GroupStateAuthoritativeSnapshot | undefined> {
        return await this.snapshots.readSnapshotWithAuthorityGuard(ref);
    }
}
