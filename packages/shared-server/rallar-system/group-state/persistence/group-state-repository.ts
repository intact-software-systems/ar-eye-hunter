import type {
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupPresenceSummary,
    GroupRef
} from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { PSqlGroupStateEventRepository } from '../../../postgres/rallar-system/PSqlStateEventRepository.ts';
import { PSqlRuntimeStateRepository } from '../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import type { StateEventListQuery } from '../../state-events/state-event-listing.ts';
import { defaultGroupStateEventStoreFor } from '../../state-events/state-event-store.ts';
import type { GroupMutationIdempotencyRecord } from '../mutation/group-mutation-contracts.ts';
import { GroupAggregateRepository } from './group-aggregate-repository.ts';
import { GroupMembershipRepository } from './group-membership-repository.ts';
import { GroupPresenceRepository } from './group-presence-repository.ts';
import type { GroupStateAuthorityGuard, GroupStateRepositoryOptions } from './group-state-persistence-contracts.ts';
import { GroupStateRepositoryReads } from './group-state-repository-reads.ts';

export function createTransactionBoundGroupStateRepository(
    transaction: PSqlSql
): GroupStateRepository {
    return new GroupStateRepository(new PSqlRuntimeStateRepository(transaction), {
        events: new PSqlGroupStateEventRepository(transaction)
    });
}

import { GroupLifecyclePolicyRepository, type GroupLifecyclePolicyRead } from './group-lifecycle-policy-repository.ts';

export class GroupStateRepository extends GroupStateRepositoryReads {
    private readonly aggregate: GroupAggregateRepository;
    private readonly membership: GroupMembershipRepository;
    private readonly presence: GroupPresenceRepository;

    constructor(repository: RuntimeStateRepositoryLike, options: GroupStateRepositoryOptions = {}) {
        super(repository);
        const events = options.events ?? defaultGroupStateEventStoreFor(repository);
        this.aggregate = new GroupAggregateRepository(repository, events);
        this.membership = new GroupMembershipRepository(repository);
        this.presence = new GroupPresenceRepository(repository);
    }

    async readLifecyclePolicy(ref: GroupRef): Promise<GroupLifecyclePolicyRead> {
        return await new GroupLifecyclePolicyRepository(this.repository).readPolicy(ref);
    }

    async insertIdempotentGroupMutationReceipt(
        ref: GroupRef,
        requestId: string,
        record: GroupMutationIdempotencyRecord,
        purgeAfterEpochMs: number = NEVER_EXPIRE_AT_TIMESTAMP
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.aggregate.insertIdempotentGroupMutationReceipt(
            ref,
            requestId,
            record,
            purgeAfterEpochMs
        );
    }

    async insertGroup(group: Group): Promise<RuntimeStateConditionalWriteResult> {
        return await this.aggregate.insertGroup(group);
    }

    async updateGroup(
        group: Group,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.aggregate.updateGroup(group, expectedRevision);
    }

    async advanceAuthorityFence(
        guard: GroupStateAuthorityGuard
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.aggregate.advanceAuthorityFence(guard);
    }

    async putGroup(group: Group): Promise<void> {
        await this.aggregate.putGroup(group);
    }

    async removeGroup(ref: GroupRef): Promise<void> {
        await this.aggregate.removeGroup(ref);
    }

    async putMember(member: GroupMember): Promise<void> {
        await this.membership.putMember(member);
    }

    async removeMember(ref: GroupRef & Readonly<{ principalId: string; }>): Promise<void> {
        await this.membership.removeMember(ref);
    }

    async putPresenceSession(session: GroupPresenceSession): Promise<void> {
        await this.presence.putPresenceSession(session);
    }

    async insertPresence(session: GroupPresenceSession): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.insertPresence(session);
    }

    async updatePresence(
        session: GroupPresenceSession,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.updatePresence(session, expectedRevision);
    }

    async deletePresence(
        ref: GroupRef & Readonly<{ sessionId: string; }>,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.presence.deletePresence(ref, expectedRevision);
    }

    async insertPresenceAdmission(
        admission: GroupPresenceAdmission
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.insertPresenceAdmission(admission);
    }

    async updatePresenceAdmission(
        admission: GroupPresenceAdmission,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.updatePresenceAdmission(admission, expectedRevision);
    }

    async removePresenceSession(ref: GroupRef & Readonly<{ sessionId: string; }>): Promise<void> {
        await this.presence.removePresenceSession(ref);
    }

    async insertPresenceSummary(
        summary: GroupPresenceSummary
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.insertPresenceSummary(summary);
    }

    async updatePresenceSummary(
        summary: GroupPresenceSummary,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.presence.updatePresenceSummary(summary, expectedRevision);
    }

    async appendEvent(event: GroupEvent): Promise<void> {
        await this.aggregate.appendEvent(event);
    }

    async listEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
        return await this.aggregate.listEvents(ref);
    }

    async listRecentEvents(
        ref: GroupRef,
        query: StateEventListQuery = {}
    ): Promise<readonly GroupEvent[]> {
        return await this.aggregate.listRecentEvents(ref, query);
    }

    async listEventPage(
        ref: GroupRef,
        query: StateEventListQuery = {}
    ): Promise<StateEventPage<GroupEvent>> {
        return await this.aggregate.listEventPage(ref, query);
    }
}
