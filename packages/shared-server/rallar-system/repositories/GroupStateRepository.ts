import type {
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
    GroupRef,
    GroupScope,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    GroupJoinCodeWritten,
    GroupSnapshotPage,
    GroupSnapshotPageOptions,
    GroupStateWritten,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { isLogicallyActiveSession, toSessionPurgeAfterEpochMs } from './session-expiry.ts';
import { defaultGroupStateEventStoreFor, type GroupStateEventStore } from './StateEventStore.ts';
import { filterStateEventsForList, type StateEventListQuery } from '../state-event-listing.ts';

const GROUPS_NAMESPACE = 'group-state:groups';
const MEMBERS_NAMESPACE = 'group-state:members';
const SESSIONS_NAMESPACE = 'group-state:sessions';
const IDEMPOTENT_NAMESPACE = 'group-state:idempotent';
const JOIN_CODE_IDEMPOTENT_NAMESPACE = 'group-state:join-code-idempotent';

export type GroupStateRepositoryOptions = Readonly<{
    events?: GroupStateEventStore;
}>;

export class GroupStateRepository extends RuntimeStateJsonStore {
    private readonly events: GroupStateEventStore;

    constructor(
        repository: RuntimeStateRepositoryLike,
        options: GroupStateRepositoryOptions = {},
    ) {
        super(repository);
        this.events = options.events ?? defaultGroupStateEventStoreFor(repository);
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

    async addIdempotentGroupJoinCodeWritten(
        ref: GroupRef,
        requestId: string,
        groupJoinCodeWritten: GroupJoinCodeWritten,
        purgeAfterEpochMs: number = NEVER_EXPIRE_AT_TIMESTAMP,
    ): Promise<GroupJoinCodeWritten> {
        await this.putValue(
            JOIN_CODE_IDEMPOTENT_NAMESPACE,
            this.idempotentGroupKey(ref, requestId),
            groupJoinCodeWritten,
            purgeAfterEpochMs,
        );

        return groupJoinCodeWritten;
    }

    async findIdempotentGroupJoinCodeWritten(
        ref: GroupRef,
        requestId: string,
    ): Promise<GroupJoinCodeWritten | undefined> {
        return await this.getValue<GroupJoinCodeWritten>(
            JOIN_CODE_IDEMPOTENT_NAMESPACE,
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
            this.scopeChildPrefix(scope),
        );
    }

    async listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]> {
        const [groups, members, sessions] = await Promise.all([
            this.listEntryValues<Group>(GROUPS_NAMESPACE, this.scopeChildPrefix(scope)),
            this.listValues<GroupMember>(MEMBERS_NAMESPACE, this.scopeChildPrefix(scope)),
            this.listValues<GroupPresenceSession>(
                SESSIONS_NAMESPACE,
                this.scopeChildPrefix(scope),
            ),
        ]);
        const membersByGroupId = new Map<string, GroupMember[]>();
        for (const member of members) {
            const current = membersByGroupId.get(member.groupId) ?? [];
            current.push(member);
            membersByGroupId.set(member.groupId, current);
        }

        const activeSessionsByGroupId = new Map<string, GroupPresenceSession[]>();
        for (const session of this.toActiveSessions(sessions)) {
            const current = activeSessionsByGroupId.get(session.groupId) ?? [];
            current.push(session);
            activeSessionsByGroupId.set(session.groupId, current);
        }

        return groups.map(({ entry, value: group }) =>
            this.toSnapshot(
                group,
                membersByGroupId.get(group.groupId) ?? [],
                activeSessionsByGroupId.get(group.groupId) ?? [],
                entry.revision + 1,
            )
        );
    }

    async listSnapshotsPage(
        scope: GroupScope,
        options: GroupSnapshotPageOptions,
    ): Promise<GroupSnapshotPage> {
        const limit = Math.max(1, Math.floor(options.limit));
        const rawPageLimit = limit + 1;
        const pageGroups: Array<Readonly<{
            key: string;
            group: Group;
            stateRevision: number;
        }>> = [];
        let afterKey = options.afterKey;
        let hasMore = false;

        while (!hasMore) {
            const groupEntries = await this.listEntriesPage(
                GROUPS_NAMESPACE,
                this.scopeChildPrefix(scope),
                {
                    afterKey,
                    limit: rawPageLimit,
                },
            );

            if (groupEntries.length === 0) {
                break;
            }

            for (const entry of groupEntries) {
                afterKey = entry.key;
                const group = await this.toLiveValue<Group>(
                    GROUPS_NAMESPACE,
                    entry,
                );

                if (group === undefined) {
                    continue;
                }

                if (pageGroups.length === limit) {
                    hasMore = true;
                    break;
                }

                pageGroups.push({
                    key: entry.key,
                    group,
                    stateRevision: entry.revision + 1,
                });
            }

            if (groupEntries.length < rawPageLimit) {
                break;
            }
        }

        const snapshots = await Promise.all(
            pageGroups.map(async ({ group, stateRevision }) => {
                const [members, sessions] = await Promise.all([
                    this.listMembers(group),
                    this.listPresenceSessions(group),
                ]);
                return this.toSnapshot(
                    group,
                    members,
                    this.toActiveSessions(sessions),
                    stateRevision,
                );
            }),
        );

        return {
            snapshots,
            scannedGroupCount: snapshots.length,
            hasMore,
            nextGroupKey: pageGroups.at(-1)?.key,
        };
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
            toSessionPurgeAfterEpochMs(
                session.expiresAtEpochMs,
                session.disconnectedAtEpochMs,
            ),
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
        await this.events.appendGroupEvent(event);
    }

    async listEvents(ref: GroupRef): Promise<readonly GroupEvent[]> {
        return await this.events.listGroupEvents(ref);
    }

    async listRecentEvents(
        ref: GroupRef,
        query: StateEventListQuery = {},
    ): Promise<readonly GroupEvent[]> {
        return this.events.listRecentGroupEvents
            ? await this.events.listRecentGroupEvents(ref, query)
            : filterStateEventsForList(
                await this.events.listGroupEvents(ref),
                query,
            );
    }

    async listEventPage(
        ref: GroupRef,
        query: StateEventListQuery = {},
    ): Promise<StateEventPage<GroupEvent>> {
        return await this.events.listGroupEventPage(ref, query);
    }

    async readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined> {
        const stored = await this.getEntryValue<Group>(
            GROUPS_NAMESPACE,
            this.groupKey(ref),
        );
        if (!stored) {
            return undefined;
        }

        const members = await this.listMembers(ref);
        const activeSessions = this.toActiveSessions(
            await this.listPresenceSessions(ref),
        );
        return this.toSnapshot(
            stored.value,
            members,
            activeSessions,
            stored.entry.revision + 1,
        );
    }

    private toSnapshot(
        group: Group,
        members: readonly GroupMember[],
        activeSessions: readonly GroupPresenceSession[],
        stateRevision: number,
    ): GroupSnapshot {
        const activePrincipals = new Set(
            activeSessions.map((session) => session.principalId),
        );
        const activeMembers = members.filter(
            (member) => member.status === 'active',
        );

        return {
            stateRevision,
            group,
            members,
            activeSessions,
            memberCount: activeMembers.length,
            onlineMemberCount:
                activeMembers.filter((member) => activePrincipals.has(member.principalId)).length,
        };
    }

    private toActiveSessions(
        sessions: readonly GroupPresenceSession[],
    ): readonly GroupPresenceSession[] {
        return sessions.filter(
            (session) =>
                session.disconnectedAtEpochMs === undefined &&
                isLogicallyActiveSession(session.expiresAtEpochMs),
        );
    }

    private groupKey(ref: GroupRef): string {
        return [this.scopeKey(ref), this.idKey('group', ref.groupId)].join(':');
    }

    private idempotentGroupKey(ref: GroupRef, requestId: string): string {
        return [this.groupKey(ref), this.idKey('request', requestId)].join(':');
    }

    private memberPrefix(ref: GroupRef): string {
        return this.childKeyPrefix(this.groupKey(ref));
    }

    private memberKey(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): string {
        return [this.groupKey(ref), this.idKey('member', ref.principalId)].join(
            ':',
        );
    }

    private sessionPrefix(ref: GroupRef): string {
        return this.childKeyPrefix(this.groupKey(ref));
    }

    private sessionKey(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): string {
        return [this.groupKey(ref), this.idKey('session', ref.sessionId)].join(
            ':',
        );
    }
}
