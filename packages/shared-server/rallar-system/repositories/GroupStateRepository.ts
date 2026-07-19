import type {
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceAdmission,
    GroupPresenceSummary,
    GroupPresenceSession,
    GroupRef,
    GroupScope,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import type { StateEventPage } from '@shared/api/state-event-types.ts';
import type { RuntimeStateRepositoryLike } from '../../runtime-state/RuntimeStateRepository.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateJsonStore,
    type RuntimeStateEntryValue,
} from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    GroupMutationIdempotencyRecord,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';
import type { GroupSnapshotPage, GroupSnapshotPageOptions } from '@shared-server/rallar-system/services/group-state-service.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { isLogicallyActiveSession, toSessionPurgeAfterEpochMs } from './session-expiry.ts';
import { defaultGroupStateEventStoreFor, type GroupStateEventStore } from './StateEventStore.ts';
import { filterStateEventsForList, type StateEventListQuery } from '../state-event-listing.ts';
import { readStableStateSnapshot } from './state-snapshot-read.ts';
import {
    decodeGroupStateGroupStorageKey,
    decodeGroupStateIdempotencyStorageKey,
    decodeGroupStateMemberStorageKey,
    decodeGroupStatePresenceAdmissionStorageKey,
    decodeGroupStatePresenceSessionStorageKey,
    groupStateGroupStorageKey,
    groupStateIdempotencyStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStateScopeStorageKey,
} from '../group-state-storage-keys.ts';

const GROUPS_NAMESPACE = 'group-state:groups';
const MEMBERS_NAMESPACE = 'group-state:members';
const SESSIONS_NAMESPACE = 'group-state:sessions';
const PRESENCE_SUMMARIES_NAMESPACE = 'group-state:presence-summaries';
const PRESENCE_ADMISSIONS_NAMESPACE = 'group-state:presence-admissions';
const IDEMPOTENT_NAMESPACE = 'group-state:idempotent';

export type GroupStateRepositoryOptions = Readonly<{
    events?: GroupStateEventStore;
}>;

export class GroupStateRepositoryInvariantCorruptionError extends Error {
    readonly code = 'group-state-repository-invariant-corruption';

    constructor(readonly storageKey: string, message: string) {
        super(`${message}: ${storageKey}`);
        this.name = 'GroupStateRepositoryInvariantCorruptionError';
    }
}

export class GroupStateRepository extends RuntimeStateJsonStore {
    private readonly events: GroupStateEventStore;

    constructor(
        repository: RuntimeStateRepositoryLike,
        options: GroupStateRepositoryOptions = {},
    ) {
        super(repository);
        this.events = options.events ?? defaultGroupStateEventStoreFor(repository);
    }

    async insertIdempotentGroupMutationReceipt(
        ref: GroupRef,
        requestId: string,
        record: GroupMutationIdempotencyRecord,
        purgeAfterEpochMs: number = NEVER_EXPIRE_AT_TIMESTAMP,
    ): Promise<RuntimeStateConditionalWriteResult> {
        const key = this.idempotentGroupKey(ref, requestId);
        assertIdempotencyIdentity(record, { ...ref, requestId }, key);
        return await this.putValueIfAbsent(
            IDEMPOTENT_NAMESPACE,
            key,
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
        const stored = await this.getEntryValue<GroupMutationIdempotencyRecord>(
            IDEMPOTENT_NAMESPACE,
            this.idempotentGroupKey(ref, requestId),
        );
        if (stored) assertStoredIdempotency(stored, { ...ref, requestId });
        return stored;
    }

    async findGroupEntry(
        ref: GroupRef,
    ): Promise<RuntimeStateEntryValue<Group> | undefined> {
        const stored = await this.getEntryValue<Group>(
            GROUPS_NAMESPACE,
            this.groupKey(ref),
        );
        if (stored) {
            const decoded = decodeStoredKey(
                stored.entry.key,
                decodeGroupStateGroupStorageKey,
            );
            assertGroupRefIdentity(decoded, ref, stored.entry.key);
            assertGroupRefIdentity(stored.value, decoded, stored.entry.key);
        }
        return stored;
    }

    async insertGroup(group: Group): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            GROUPS_NAMESPACE,
            this.groupKey(group),
            group,
            group.purgeAfterEpochMs ?? this.neverExpireAtTimestamp(),
        );
    }

    async updateGroup(
        group: Group,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfRevision(
            GROUPS_NAMESPACE,
            this.groupKey(group),
            group,
            group.purgeAfterEpochMs ?? this.neverExpireAtTimestamp(),
            expectedRevision,
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
        return (await this.findGroupEntry(ref))?.value;
    }

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
    ): Promise<import('@shared/api/group-types.ts').GroupStateCausalRevision | undefined> {
        const [stored, summary] = await Promise.all([
            this.findGroupEntry(ref),
            this.findPresenceSummaryEntry(ref),
        ]);
        return stored
            ? {
                groupRevision: stored.entry.revision + 1,
                presenceRevision:
                    summary?.value.causalRevision.presenceRevision ?? 0,
            }
            : undefined;
    }

    async listGroups(scope: GroupScope): Promise<readonly Group[]> {
        const stored = await this.listEntryValues<Group>(
            GROUPS_NAMESPACE,
            this.groupStateScopeChildPrefix(scope),
        );
        return stored.map((entry) => {
            assertStoredGroup(entry, scope);
            return entry.value;
        });
    }

    async listSnapshots(scope: GroupScope): Promise<readonly GroupSnapshot[]> {
        const keyPrefix = this.groupStateScopeChildPrefix(scope);
        const groupsBefore = await this.listEntryValues<Group>(
            GROUPS_NAMESPACE,
            keyPrefix,
        );
        const [memberEntries, summaryEntries] = await Promise.all([
            this.listEntryValues<GroupMember>(MEMBERS_NAMESPACE, keyPrefix),
            this.listEntryValues<GroupPresenceSummary>(
                PRESENCE_SUMMARIES_NAMESPACE,
                keyPrefix,
            ),
        ]);
        const groupsAfter = await this.listEntryValues<Group>(
            GROUPS_NAMESPACE,
            keyPrefix,
        );
        for (const stored of [...groupsBefore, ...groupsAfter]) {
            assertStoredGroup(stored, scope);
        }
        for (const stored of memberEntries) {
            assertDecodedScope(
                decodeStoredKey(stored.entry.key, decodeGroupStateMemberStorageKey),
                scope,
                stored.entry.key,
            );
            assertStoredMember(stored);
        }
        for (const stored of summaryEntries) {
            const decoded = decodeStoredKey(
                stored.entry.key,
                decodeGroupStateGroupStorageKey,
            );
            assertDecodedScope(decoded, scope, stored.entry.key);
            assertStoredSummary(stored, decoded);
        }
        const members = memberEntries.map(({ value }) => value);
        const summaries = summaryEntries.map(({ value }) => value);
        const membersByGroupId = new Map<string, GroupMember[]>();
        for (const member of members) {
            const current = membersByGroupId.get(member.groupId) ?? [];
            current.push(member);
            membersByGroupId.set(member.groupId, current);
        }

        const summariesByGroupId = new Map(
            summaries.map((summary) => [summary.groupId, summary]),
        );

        const beforeByKey = new Map(
            groupsBefore.map((stored) => [stored.entry.key, stored]),
        );
        const snapshots = await Promise.all(
            groupsAfter.map(async (stored) => {
                const before = beforeByKey.get(stored.entry.key);
                if (!before || before.entry.revision !== stored.entry.revision) {
                    return await this.readSnapshot(stored.value);
                }
                return this.toSnapshot(
                    stored.value,
                    membersByGroupId.get(stored.value.groupId) ?? [],
                    summariesByGroupId.get(stored.value.groupId),
                    stored.entry.revision + 1,
                );
            }),
        );
        return snapshots.filter(
            (snapshot): snapshot is GroupSnapshot => snapshot !== undefined,
        );
    }

    async listSnapshotsPage(
        scope: GroupScope,
        options: GroupSnapshotPageOptions,
    ): Promise<GroupSnapshotPage> {
        const limit = Math.max(1, Math.floor(options.limit));
        const rawPageLimit = limit + 1;
        const pageGroups: Array<Readonly<{
            entry: Readonly<{ key: string; revision: number }>;
            group: Group;
        }>> = [];
        let afterKey = options.afterKey;
        let hasMore = false;

        while (!hasMore) {
            const groupEntries = await this.listEntriesPage(
                GROUPS_NAMESPACE,
                this.groupStateScopeChildPrefix(scope),
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
                assertStoredGroup({ entry, value: group }, scope);

                if (pageGroups.length === limit) {
                    hasMore = true;
                    break;
                }

                pageGroups.push({
                    entry,
                    group,
                });
            }

            if (groupEntries.length < rawPageLimit) {
                break;
            }
        }

        const candidates = await Promise.all(
            pageGroups.map(async ({ entry, group }) => {
                const [members, summary] = await Promise.all([
                    this.listMembers(group),
                    this.findPresenceSummaryEntry(group),
                ]);
                return { entry, group, members, summary: summary?.value };
            }),
        );
        const groupsAfter = await this.listEntryValuesByKeys<Group>(
            GROUPS_NAMESPACE,
            pageGroups.map(({ entry }) => entry.key),
        );
        for (const stored of groupsAfter) {
            assertStoredGroup(stored, scope);
        }
        const afterByKey = new Map(
            groupsAfter.map((stored) => [stored.entry.key, stored]),
        );
        const resolved = await Promise.all(
            candidates.map(async (candidate) => {
                const after = afterByKey.get(candidate.entry.key);
                if (!after) {
                    return undefined;
                }
                if (after.entry.revision !== candidate.entry.revision) {
                    return await this.readSnapshot(after.value);
                }
                return this.toSnapshot(
                    after.value,
                    candidate.members,
                    candidate.summary,
                    after.entry.revision + 1,
                );
            }),
        );
        const snapshots = resolved.filter(
            (snapshot): snapshot is GroupSnapshot => snapshot !== undefined,
        );

        return {
            snapshots,
            scannedGroupCount: pageGroups.length,
            hasMore,
            nextGroupKey: pageGroups.at(-1)?.entry.key,
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
        return (await this.findMemberEntry(ref))?.value;
    }

    async findMemberEntry(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<RuntimeStateEntryValue<GroupMember> | undefined> {
        const stored = await this.getEntryValue<GroupMember>(
            MEMBERS_NAMESPACE,
            this.memberKey(ref),
        );
        if (stored) assertStoredMember(stored, ref);
        return stored;
    }

    async listMembers(ref: GroupRef): Promise<readonly GroupMember[]> {
        return (await this.listMemberEntries(ref)).map(({ value }) => value);
    }

    async listMemberEntries(
        ref: GroupRef,
    ): Promise<readonly RuntimeStateEntryValue<GroupMember>[]> {
        const stored = await this.listEntryValues<GroupMember>(
            MEMBERS_NAMESPACE,
            this.memberPrefix(ref),
        );
        for (const entry of stored) assertStoredMember(entry, ref);
        return stored;
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

    async findPresenceEntry(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<RuntimeStateEntryValue<GroupPresenceSession> | undefined> {
        const stored = await this.getEntryValue<GroupPresenceSession>(
            SESSIONS_NAMESPACE,
            this.sessionKey(ref),
        );
        if (stored) assertStoredSession(stored, ref);
        return stored;
    }

    async insertPresence(
        session: GroupPresenceSession,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            SESSIONS_NAMESPACE,
            this.sessionKey(session),
            session,
            toSessionPurgeAfterEpochMs(
                session.expiresAtEpochMs,
                session.disconnectedAtEpochMs,
            ),
        );
    }

    async updatePresence(
        session: GroupPresenceSession,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfRevision(
            SESSIONS_NAMESPACE,
            this.sessionKey(session),
            session,
            toSessionPurgeAfterEpochMs(
                session.expiresAtEpochMs,
                session.disconnectedAtEpochMs,
            ),
            expectedRevision,
        );
    }

    async deletePresence(
        ref: GroupRef & Readonly<{ sessionId: string }>,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.deleteValueIfRevision(
            SESSIONS_NAMESPACE,
            this.sessionKey(ref),
            expectedRevision,
        );
    }

    async findPresenceSession(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<GroupPresenceSession | undefined> {
        return (await this.findPresenceEntry(ref))?.value;
    }

    async listPresenceSessions(
        ref: GroupRef,
    ): Promise<readonly GroupPresenceSession[]> {
        return (await this.listPresenceSessionEntries(ref)).map(({ value }) => value);
    }

    async listPresenceSessionEntries(
        ref: GroupRef,
    ): Promise<readonly RuntimeStateEntryValue<GroupPresenceSession>[]> {
        const stored = await this.listEntryValues<GroupPresenceSession>(
            SESSIONS_NAMESPACE,
            this.sessionPrefix(ref),
        );
        for (const entry of stored) assertStoredSession(entry, ref);
        return stored;
    }

    async findPresenceAdmissionEntry(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): Promise<RuntimeStateEntryValue<GroupPresenceAdmission> | undefined> {
        const stored = await this.getEntryValue<GroupPresenceAdmission>(
            PRESENCE_ADMISSIONS_NAMESPACE,
            this.presenceAdmissionKey(ref),
        );
        if (stored) assertStoredAdmission(stored, ref);
        return stored;
    }

    async insertPresenceAdmission(
        admission: GroupPresenceAdmission,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            PRESENCE_ADMISSIONS_NAMESPACE,
            this.presenceAdmissionKey(admission),
            admission,
        );
    }

    async updatePresenceAdmission(
        admission: GroupPresenceAdmission,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfRevision(
            PRESENCE_ADMISSIONS_NAMESPACE,
            this.presenceAdmissionKey(admission),
            admission,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision,
        );
    }

    async listPresenceAdmissions(
        ref: GroupRef,
    ): Promise<readonly GroupPresenceAdmission[]> {
        return (await this.listPresenceAdmissionEntries(ref)).map(({ value }) => value);
    }

    async listPresenceAdmissionEntries(
        ref: GroupRef,
    ): Promise<readonly RuntimeStateEntryValue<GroupPresenceAdmission>[]> {
        const stored = await this.listEntryValues<GroupPresenceAdmission>(
            PRESENCE_ADMISSIONS_NAMESPACE,
            this.presenceAdmissionPrefix(ref),
        );
        for (const entry of stored) assertStoredAdmission(entry, ref);
        return stored;
    }

    async listAllPresenceSessions(): Promise<readonly GroupPresenceSession[]> {
        const stored = await this.listEntryValues<GroupPresenceSession>(SESSIONS_NAMESPACE);
        for (const entry of stored) assertStoredSession(entry);
        return stored.map(({ value }) => value);
    }

    async removePresenceSession(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): Promise<void> {
        await this.deleteValue(SESSIONS_NAMESPACE, this.sessionKey(ref));
    }

    async findPresenceSummaryEntry(
        ref: GroupRef,
    ): Promise<RuntimeStateEntryValue<GroupPresenceSummary> | undefined> {
        const stored = await this.getEntryValue<GroupPresenceSummary>(
            PRESENCE_SUMMARIES_NAMESPACE,
            this.groupKey(ref),
        );
        if (stored) assertStoredSummary(stored, ref);
        return stored;
    }

    async insertPresenceSummary(
        summary: GroupPresenceSummary,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfAbsent(
            PRESENCE_SUMMARIES_NAMESPACE,
            this.groupKey(summary),
            summary,
        );
    }

    async updatePresenceSummary(
        summary: GroupPresenceSummary,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        return await this.putValueIfRevision(
            PRESENCE_SUMMARIES_NAMESPACE,
            this.groupKey(summary),
            summary,
            NEVER_EXPIRE_AT_TIMESTAMP,
            expectedRevision,
        );
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
        const groupKey = this.groupKey(ref);
        return await readStableStateSnapshot({
            snapshotKey: groupKey,
            readAggregate: async () => await this.findGroupEntry(ref),
            readChildren: async () => {
                const [members, summary] = await Promise.all([
                    this.listMembers(ref),
                    this.findPresenceSummaryEntry(ref),
                ]);
                return [members, summary?.value] as const;
            },
            assemble: (stored, members, summary) =>
                this.toSnapshot(
                    stored.value,
                    members,
                    summary,
                    stored.entry.revision + 1,
                ),
        });
    }

    private toSnapshot(
        group: Group,
        members: readonly GroupMember[],
        summaryOrSessions: GroupPresenceSummary | readonly GroupPresenceSession[] | undefined,
        groupRevision: number,
    ): GroupSnapshot {
        const observedAtEpochMs = Date.now();
        const groupAllowsLivePresence = group.status === 'active' &&
            (group.expiresAtEpochMs === undefined ||
                group.expiresAtEpochMs > observedAtEpochMs);
        const activeMemberIds = new Set(
            members.filter((member) => member.status === 'active')
                .map((member) => member.principalId),
        );
        const summary = isPresenceSummary(summaryOrSessions)
            ? summaryOrSessions
            : undefined;
        const sourceSessions: readonly GroupPresenceSession[] = summary
            ? summary.activeSessions
            : Array.isArray(summaryOrSessions)
            ? summaryOrSessions as readonly GroupPresenceSession[]
            : [];
        const activeSessions = groupAllowsLivePresence
            ? this.toActiveSessions(sourceSessions, observedAtEpochMs)
                .filter((session) => activeMemberIds.has(session.principalId))
            : [];
        const presenceRevision = summary?.causalRevision.presenceRevision ?? 0;
        const causalRevision = { groupRevision, presenceRevision };
        const activePrincipals = new Set(
            activeSessions.map((session) => session.principalId),
        );
        const activeMembers = members.filter(
            (member) => member.status === 'active',
        );
        const activeOwners = activeMembers.filter((member) =>
            member.role === 'owner'
        );
        if (
            group.activeMemberCount !== activeMembers.length ||
            activeOwners.length !== 1 ||
            activeOwners[0]?.principalId !== group.ownerPrincipalId
        ) {
            throw new TypeError(
                `Group roster facts are inconsistent: ${group.groupId}`,
            );
        }

        return {
            stateRevision: toGroupSnapshotStateRevision(
                causalRevision.groupRevision,
                causalRevision.presenceRevision,
            ),
            causalRevision,
            group: { ...group, presenceVersion: presenceRevision },
            members,
            activeSessions,
            memberCount: activeMembers.length,
            onlineMemberCount:
                activeMembers.filter((member) => activePrincipals.has(member.principalId)).length,
        };
    }

    private toActiveSessions(
        sessions: readonly GroupPresenceSession[],
        observedAtEpochMs: number,
    ): readonly GroupPresenceSession[] {
        return sessions.filter(
            (session) =>
                session.disconnectedAtEpochMs === undefined &&
                isLogicallyActiveSession(
                    session.expiresAtEpochMs,
                    observedAtEpochMs,
                ),
        );
    }

    private groupKey(ref: GroupRef): string {
        return groupStateGroupStorageKey(ref);
    }

    private groupStateScopeChildPrefix(scope: GroupScope): string {
        return this.childKeyPrefix(groupStateScopeStorageKey(scope));
    }

    private idempotentGroupKey(ref: GroupRef, requestId: string): string {
        return groupStateIdempotencyStorageKey(ref, requestId);
    }

    private memberPrefix(ref: GroupRef): string {
        return this.childKeyPrefix(this.groupKey(ref));
    }

    private memberKey(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): string {
        return groupStateMemberStorageKey(ref);
    }

    private sessionPrefix(ref: GroupRef): string {
        return this.childKeyPrefix(this.groupKey(ref));
    }

    private sessionKey(
        ref: GroupRef & Readonly<{ sessionId: string }>,
    ): string {
        return groupStatePresenceSessionStorageKey(ref);
    }

    private presenceAdmissionPrefix(ref: GroupRef): string {
        return this.childKeyPrefix(this.groupKey(ref));
    }

    private presenceAdmissionKey(
        ref: GroupRef & Readonly<{ principalId: string }>,
    ): string {
        return groupStatePresenceAdmissionStorageKey(ref);
    }
}

function isPresenceSummary(
    value: GroupPresenceSummary | readonly GroupPresenceSession[] | undefined,
): value is GroupPresenceSummary {
    return value !== undefined && !Array.isArray(value) &&
        'causalRevision' in value;
}

function assertGroupRefIdentity(
    value: GroupRef,
    expected: GroupRef,
    storageKey: string,
): void {
    if (
        value.applicationId !== expected.applicationId ||
        value.workspaceId !== expected.workspaceId ||
        value.groupId !== expected.groupId
    ) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            storageKey,
            'Stored group-state identity differs from the requested slot',
        );
    }
}

function assertStoredGroup(
    stored: RuntimeStateEntryValue<Group>,
    expectedScope: GroupScope,
): void {
    let decoded: GroupRef;
    try {
        decoded = decodeGroupStateGroupStorageKey(stored.entry.key);
    } catch (error) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            stored.entry.key,
            error instanceof Error ? error.message : 'Stored group key is invalid',
        );
    }
    if (
        decoded.applicationId !== expectedScope.applicationId ||
        decoded.workspaceId !== expectedScope.workspaceId
    ) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            stored.entry.key,
            'Stored group key differs from the requested scope',
        );
    }
    assertGroupRefIdentity(stored.value, decoded, stored.entry.key);
}

function assertStoredMember(
    stored: RuntimeStateEntryValue<GroupMember>,
    expected?: GroupRef & Readonly<{ principalId?: string }>,
): void {
    const decoded = decodeStoredKey(
        stored.entry.key,
        decodeGroupStateMemberStorageKey,
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    assertGroupRefIdentity(stored.value, decoded, stored.entry.key);
    if (stored.value.principalId !== decoded.principalId ||
        (expected?.principalId !== undefined &&
            decoded.principalId !== expected.principalId)) {
        throwIdentityCorruption(stored.entry.key, 'member principal');
    }
}

function assertStoredSession(
    stored: RuntimeStateEntryValue<GroupPresenceSession>,
    expected?: GroupRef & Readonly<{ sessionId?: string }>,
): void {
    const decoded = decodeStoredKey(
        stored.entry.key,
        decodeGroupStatePresenceSessionStorageKey,
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    assertGroupRefIdentity(stored.value, decoded, stored.entry.key);
    if (stored.value.sessionId !== decoded.sessionId ||
        (expected?.sessionId !== undefined && decoded.sessionId !== expected.sessionId)) {
        throwIdentityCorruption(stored.entry.key, 'presence session');
    }
}

function assertStoredAdmission(
    stored: RuntimeStateEntryValue<GroupPresenceAdmission>,
    expected?: GroupRef & Readonly<{ principalId?: string }>,
): void {
    const decoded = decodeStoredKey(
        stored.entry.key,
        decodeGroupStatePresenceAdmissionStorageKey,
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    assertGroupRefIdentity(stored.value, decoded, stored.entry.key);
    if (stored.value.principalId !== decoded.principalId ||
        (expected?.principalId !== undefined &&
            decoded.principalId !== expected.principalId)) {
        throwIdentityCorruption(stored.entry.key, 'presence admission principal');
    }
}

function assertStoredSummary(
    stored: RuntimeStateEntryValue<GroupPresenceSummary>,
    expected: GroupRef,
): void {
    const decoded = decodeStoredKey(
        stored.entry.key,
        decodeGroupStateGroupStorageKey,
    );
    assertTrustedGroupRef(decoded, expected, stored.entry.key);
    assertGroupRefIdentity(stored.value, decoded, stored.entry.key);
}

function assertStoredIdempotency(
    stored: RuntimeStateEntryValue<GroupMutationIdempotencyRecord>,
    expected: GroupRef & Readonly<{ requestId: string }>,
): void {
    const decoded = decodeStoredKey(
        stored.entry.key,
        decodeGroupStateIdempotencyStorageKey,
    );
    assertGroupRefIdentity(decoded, expected, stored.entry.key);
    assertIdempotencyIdentity(stored.value, decoded, stored.entry.key);
}

function assertIdempotencyIdentity(
    value: GroupMutationIdempotencyRecord,
    expected: GroupRef & Readonly<{ requestId: string }>,
    storageKey: string,
): void {
    if (value.requestId !== expected.requestId ||
        typeof value.aggregateRef !== 'object' ||
        value.aggregateRef === null) {
        throwIdentityCorruption(storageKey, 'idempotency request');
    }
    assertGroupRefIdentity(value.aggregateRef, expected, storageKey);
}

function decodeStoredKey<T>(
    storageKey: string,
    decode: (storageKey: string) => T,
): T {
    try {
        return decode(storageKey);
    } catch (error) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            storageKey,
            error instanceof Error ? error.message : 'Stored group-state key is invalid',
        );
    }
}

function assertTrustedGroupRef(
    decoded: GroupRef,
    expected: GroupRef | undefined,
    storageKey: string,
): void {
    if (expected) assertGroupRefIdentity(decoded, expected, storageKey);
}

function assertDecodedScope(
    decoded: GroupRef,
    expected: GroupScope,
    storageKey: string,
): void {
    if (decoded.applicationId !== expected.applicationId ||
        decoded.workspaceId !== expected.workspaceId) {
        throwIdentityCorruption(storageKey, 'scope');
    }
}

function throwIdentityCorruption(storageKey: string, slot: string): never {
    throw new GroupStateRepositoryInvariantCorruptionError(
        storageKey,
        `Stored group-state ${slot} differs from the decoded slot`,
    );
}
