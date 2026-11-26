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
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { createTransactionBoundPSqlRuntimeStateRepository } from '../../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import type { GroupStateEventStore } from '../../state-events/group-state-event-store.ts';
import { PSqlGroupStateEventRepository } from '../../state-events/postgres/p-sql-group-state-event-repository.ts';
import type { StateEventListQuery } from '../../state-events/state-event-listing.ts';
import { GroupAggregateRepository } from './aggregate/group-aggregate-repository.ts';
import { GroupLifecyclePolicyRepository, type GroupLifecyclePolicyRead } from './group-lifecycle-policy-repository.ts';
import type { GroupStateAuthorityGuard } from './group-state-persistence-contracts.ts';
import { GroupStateRepositoryReads } from './group-state-repository-reads.ts';
import { GroupMembershipRepository } from './membership/group-membership-repository.ts';
import { GroupPresenceRepository } from './presence/group-presence-repository.ts';

import { RoomEventRepository } from '../../room-events/room-event-repository.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { computeEmptyGroupLifetime, readArrivalRetention } from '../retention/compute-empty-group-lifetime.ts';
import { readRoomEventLifetime } from '../../room-events/room-event-lifetime.ts';

export function createTransactionBoundGroupStateRepository(
    transaction: PSqlSql
): GroupStateRepository {
    return new GroupStateRepository(
        createTransactionBoundPSqlRuntimeStateRepository(transaction),
        new PSqlGroupStateEventRepository(transaction)
    );
}

export class GroupStateRepository extends GroupStateRepositoryReads {
    private readonly aggregate: GroupAggregateRepository;
    private readonly membership: GroupMembershipRepository;
    private readonly presence: GroupPresenceRepository;

    constructor(repository: RuntimeStateRepositoryLike, events: GroupStateEventStore) {
        super(repository);
        this.aggregate = new GroupAggregateRepository(repository, events);
        this.membership = new GroupMembershipRepository(repository);
        this.presence = new GroupPresenceRepository(repository);
    }

    async isTemporaryRoomAvailable(group: Group, now: number, expectedRevision?: number): Promise<boolean> {
        if (group.status !== 'active' || (group.expiresAtEpochMs !== null && now >= group.expiresAtEpochMs)) return false;
        if (group.temporaryPlayerRoom) {
            const policy = readArrivalRetention(group);
            if (!policy) return false;
            if (now - group.created.atEpochMs < policy.reconnectGraceMs) return true;
            const authority = await this.readPresenceSummaryEntries(group);
            if (expectedRevision !== undefined && authority.group?.entry.revision !== expectedRevision) {
                throw new RuntimeStateWriteConflictError();
            }
            const current = authority.group?.value;
            if (!current?.temporaryPlayerRoom || current.status !== 'active') return false;
            const currentPolicy = readArrivalRetention(current);
            return currentPolicy !== null && computeEmptyGroupLifetime(authority, currentPolicy, now) !== 'expired';
        }
        if (!group.eventRoom) return true;
        const lobby = { applicationId: group.applicationId, workspaceId: group.workspaceId, groupId: group.eventRoom.lobbyGroupId };
        const event = (await new RoomEventRepository(this.repository).read(lobby))?.value;
        if (!event || event.closed || event.closesAt <= now || group.status !== 'active' ||
            (group.groupId !== lobby.groupId && !event.courts.some(court => court.groupId === group.groupId))) return false;
        if (now - event.createdAt < event.emptyReturnWindowMs) return true;
        return now < (await readRoomEventLifetime(this, event)).dueAt;
    }

    async readLifecyclePolicy(ref: GroupRef): Promise<GroupLifecyclePolicyRead> {
        return await new GroupLifecyclePolicyRepository(this.repository).readPolicy(ref);
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

    async readEvent(ref: GroupRef, eventId: string): Promise<GroupEvent | undefined> {
        return await this.aggregate.readEvent(ref, eventId);
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
