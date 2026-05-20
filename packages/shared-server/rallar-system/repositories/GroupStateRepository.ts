import type {
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
    GroupRef,
    GroupScope,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { GroupStateWritten } from '@shared-server/rallar-system/services/group-state-service.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

const GROUPS_NAMESPACE = 'group-state:groups';
const MEMBERS_NAMESPACE = 'group-state:members';
const SESSIONS_NAMESPACE = 'group-state:sessions';
const EVENTS_NAMESPACE = 'group-state:events';
const IDEMPOTENT_NAMESPACE = 'group-state:idempotent';

export class GroupStateRepository extends RuntimeStateJsonStore {
    constructor(repository: RuntimeStateRepositoryLike) {
        super(repository);
    }

    async addIdempotentGroupStateWritten(
        ref: GroupRef,
        requestId: string,
        groupStateWritten: GroupStateWritten,
        purgeAfterEpochMs: number = NEVER_EXPIRE_AT_TIMESTAMP,
    ): Promise<GroupStateWritten> {
        await this.putValue(
            IDEMPOTENT_NAMESPACE,
            this.idempotentGroupKey(ref, requestId),
            groupStateWritten,
            purgeAfterEpochMs,
        );

        return groupStateWritten;
    }

    async findIdempotentGroupStateWritten(
        ref: GroupRef,
        requestId: string,
    ): Promise<GroupStateWritten | undefined> {
        return await this.getValue<GroupStateWritten>(
            IDEMPOTENT_NAMESPACE,
            this.idempotentGroupKey(ref, requestId),
        );
    }

    async putGroup(group: Group): Promise<void> {
        await this.putValue(
            GROUPS_NAMESPACE,
            this.groupKey(group),
            group,
            group.purgeAfterEpochMs ?? this.neverExpireAtTimestamp(),
        );
    }

    async findGroup(ref: GroupRef): Promise<Group | undefined> {
        return await this.getValue<Group>(GROUPS_NAMESPACE, this.groupKey(ref));
    }

    async listGroups(scope: GroupScope): Promise<readonly Group[]> {
        return await this.listValues<Group>(
            GROUPS_NAMESPACE,
            this.scopePrefix(scope),
        );
    }

    async findGroupBySlug(
        scope: GroupScope,
        slug: string,
    ): Promise<Group | undefined> {
        return (await this.listGroups(scope)).find(
            (group) => group.slug === slug,
        );
    }

    async removeGroup(ref: GroupRef): Promise<void> {
        await this.deleteValue(GROUPS_NAMESPACE, this.groupKey(ref));
    }

    async putMember(member: GroupMember): Promise<void> {
        await this.putValue(MEMBERS_NAMESPACE, this.memberKey(member), member);
    }

    async findMember(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<GroupMember | undefined> {
        return await this.getValue<GroupMember>(
            MEMBERS_NAMESPACE,
            this.memberKey(ref),
        );
    }

    async listMembers(ref: GroupRef): Promise<readonly GroupMember[]> {
        return await this.listValues<GroupMember>(
            MEMBERS_NAMESPACE,
            this.memberPrefix(ref),
        );
    }

    async removeMember(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<void> {
        await this.deleteValue(MEMBERS_NAMESPACE, this.memberKey(ref));
    }

    async putPresenceSession(session: GroupPresenceSession): Promise<void> {
        await this.putValue(
            SESSIONS_NAMESPACE,
            this.sessionKey(session),
            session,
            session.expiresAtEpochMs,
        );
    }

    async findPresenceSession(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<GroupPresenceSession | undefined> {
        return await this.getValue<GroupPresenceSession>(
            SESSIONS_NAMESPACE,
            this.sessionKey(ref),
        );
    }

    async listPresenceSessions(
        ref: GroupRef,
    ): Promise<readonly GroupPresenceSession[]> {
        return await this.listValues<GroupPresenceSession>(
            SESSIONS_NAMESPACE,
            this.sessionPrefix(ref),
        );
    }

    async listAllPresenceSessions(): Promise<readonly GroupPresenceSession[]> {
        return await this.listValues<GroupPresenceSession>(SESSIONS_NAMESPACE);
    }

    async removePresenceSession(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<void> {
        await this.deleteValue(SESSIONS_NAMESPACE, this.sessionKey(ref));
    }

    async appendEvent(event: GroupEvent): Promise<void> {
        await this.putValue(EVENTS_NAMESPACE, this.eventKey(event), event);
    }

    async listEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
        const events = await this.listValues<GroupEvent>(
            EVENTS_NAMESPACE,
            this.eventPrefix(ref),
        );

        return [...events].sort(
            (left, right) => left.occurredAtEpochMs - right.occurredAtEpochMs,
        );
    }

    async readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined> {
        const group = await this.findGroup(ref);
        if (!group) {
            return undefined;
        }

        const members = await this.listMembers(ref);
        const activeSessions = this.toActiveSessions(
            await this.listPresenceSessions(ref),
        );
        const activePrincipals = new Set(
            activeSessions.map((session) => session.principalId),
        );
        const activeMembers = members.filter(
            (member) => member.status === 'active',
        );

        return {
            group,
            members,
            activeSessions,
            memberCount: activeMembers.length,
            onlineMemberCount: activeMembers.filter((member) =>
                activePrincipals.has(member.principalId),
            ).length,
        };
    }

    private toActiveSessions(
        sessions: readonly GroupPresenceSession[],
    ): readonly GroupPresenceSession[] {
        return sessions.filter(
            (session) => session.disconnectedAtEpochMs === undefined,
        );
    }

    private scopePrefix(scope: GroupScope): string {
        return this.scopeKey(scope);
    }

    private groupKey(ref: GroupRef): string {
        return [this.scopeKey(ref), this.idKey('group', ref.groupId)].join(':');
    }

    private idempotentGroupKey(ref: GroupRef, requestId: string): string {
        return [this.groupKey(ref), this.idKey('request', requestId)].join(':');
    }

    private memberPrefix(ref: GroupRef): string {
        return this.groupKey(ref);
    }

    private memberKey(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): string {
        return [this.groupKey(ref), this.idKey('member', ref.principalId)].join(
            ':',
        );
    }

    private sessionPrefix(ref: GroupRef): string {
        return this.groupKey(ref);
    }

    private sessionKey(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): string {
        return [this.groupKey(ref), this.idKey('session', ref.sessionId)].join(
            ':',
        );
    }

    private eventPrefix(ref: GroupRef): string {
        return this.groupKey(ref);
    }

    private eventKey(event: GroupEvent): string {
        return [
            this.groupKey(event),
            this.idKey('event-at', this.timeKey(event.occurredAtEpochMs)),
            this.idKey('event', event.eventId),
        ].join(':');
    }
}
