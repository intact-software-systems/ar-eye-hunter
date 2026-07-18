import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';
import type {
    GroupJoinCodeMutationWritten,
    GroupJoinCodeWritten,
    GroupMutationWritten,
    GroupStateService,
    GroupStateWritten,
} from './group-state-service.ts';

export type CachedGroupStateServiceCache = Readonly<{
    findOrLoadByRef(
        ref: GroupRef,
        options?: Readonly<{
            minSnapshotVersion?: number;
            minStateRevision?: number;
        }>,
    ): Promise<GroupSnapshot | undefined>;
    observe(snapshot: GroupSnapshot): StateSnapshotObservation;
}>;

export type CachedGroupStateService = GroupStateService & Readonly<{
    observeSnapshot(snapshot: GroupSnapshot): Promise<GroupSnapshot>;
    readCurrentSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
    readSnapshotAtLeast(
        ref: GroupRef,
        options: Readonly<{
            minSnapshotVersion?: number;
            minStateRevision?: number;
        }>,
    ): Promise<GroupSnapshot | undefined>;
}>;

export function createCachedGroupStateService(options: Readonly<{
    durable: GroupStateService;
    cache: CachedGroupStateServiceCache;
}>): CachedGroupStateService {
    const observeSnapshot = async (
        snapshot: GroupSnapshot,
    ): Promise<GroupSnapshot> => {
        options.cache.observe(snapshot);
        return snapshot;
    };
    const observeMutation = async <T extends GroupMutationWritten>(
        mutation: T,
    ): Promise<T> => ({
        ...mutation,
        snapshot: await observeSnapshot(mutation.snapshot),
    });
    const observeWritten = async (
        written: GroupStateWritten,
    ): Promise<GroupStateWritten> => {
        if (!written.result.right) {
            return written;
        }
        return {
            ...written,
            result: Either.ofRight(
                await observeMutation(written.result.right),
            ),
        };
    };
    const observeJoinCodeWritten = async (
        written: GroupJoinCodeWritten,
    ): Promise<GroupJoinCodeWritten> => {
        if (!written.result.right) {
            return written;
        }
        return {
            ...written,
            result: Either.ofRight(
                await observeMutation(
                    written.result.right as GroupJoinCodeMutationWritten &
                        GroupMutationWritten,
                ),
            ),
        };
    };
    const observeWrittenList = async (
        values: readonly GroupStateWritten[],
    ): Promise<readonly GroupStateWritten[]> =>
        await Promise.all(values.map(observeWritten));

    const service: CachedGroupStateService = {
        ...options.durable,
        observeSnapshot,
        readCurrentSnapshot: async (ref) => {
            const stateRevision = await options.durable.readStateRevision(ref);
            return stateRevision === undefined
                ? undefined
                : await options.cache.findOrLoadByRef(ref, {
                    minStateRevision: stateRevision,
                });
        },
        readSnapshotAtLeast: async (ref, readOptions) =>
            await options.cache.findOrLoadByRef(ref, readOptions),
        listSnapshots: async (scope) => {
            const snapshots = await options.durable.listSnapshots(scope);
            return await Promise.all(snapshots.map(observeSnapshot));
        },
        listSnapshotsPage: async (scope, pageOptions) => {
            const page = await options.durable.listSnapshotsPage(
                scope,
                pageOptions,
            );
            return {
                ...page,
                snapshots: await Promise.all(
                    page.snapshots.map(observeSnapshot),
                ),
            };
        },
        readSnapshot: async (ref) =>
            await options.cache.findOrLoadByRef(ref),
        createGroup: async (scope, request) =>
            await observeWritten(
                await options.durable.createGroup(scope, request),
            ),
        updateGroup: async (scope, groupId, request) =>
            await observeWritten(
                await options.durable.updateGroup(scope, groupId, request),
            ),
        appointDirector: async (scope, groupId, request) =>
            await observeWritten(
                await options.durable.appointDirector(scope, groupId, request),
            ),
        joinGroup: async (scope, groupId, request) =>
            await observeWritten(
                await options.durable.joinGroup(scope, groupId, request),
            ),
        createGroupInvite: async (scope, groupId, principalId, request) =>
            await observeWritten(
                await options.durable.createGroupInvite(
                    scope,
                    groupId,
                    principalId,
                    request,
                ),
            ),
        revokeGroupInvite: async (scope, groupId, principalId, request) =>
            await observeWritten(
                await options.durable.revokeGroupInvite(
                    scope,
                    groupId,
                    principalId,
                    request,
                ),
            ),
        acceptGroupInvite: async (scope, groupId, request) =>
            await observeWritten(
                await options.durable.acceptGroupInvite(scope, groupId, request),
            ),
        rotateGroupJoinCode: async (scope, groupId, request) =>
            await observeJoinCodeWritten(
                await options.durable.rotateGroupJoinCode(scope, groupId, request),
            ),
        removeGroupMember: async (scope, groupId, principalId, request) =>
            await observeWritten(
                await options.durable.removeGroupMember(
                    scope,
                    groupId,
                    principalId,
                    request,
                ),
            ),
        banGroupMember: async (scope, groupId, principalId, request) =>
            await observeWritten(
                await options.durable.banGroupMember(
                    scope,
                    groupId,
                    principalId,
                    request,
                ),
            ),
        unbanGroupMember: async (scope, groupId, principalId, request) =>
            await observeWritten(
                await options.durable.unbanGroupMember(
                    scope,
                    groupId,
                    principalId,
                    request,
                ),
            ),
        setGroupMemberRole: async (scope, groupId, principalId, request) =>
            await observeWritten(
                await options.durable.setGroupMemberRole(
                    scope,
                    groupId,
                    principalId,
                    request,
                ),
            ),
        transferGroupOwnership: async (scope, groupId, request) =>
            await observeWritten(
                await options.durable.transferGroupOwnership(
                    scope,
                    groupId,
                    request,
                ),
            ),
        upsertMember: async (scope, groupId, principalId, request) =>
            await observeWritten(
                await options.durable.upsertMember(
                    scope,
                    groupId,
                    principalId,
                    request,
                ),
            ),
        connectPresenceSession: async (scope, groupId, sessionId, request) =>
            await observeWritten(
                await options.durable.connectPresenceSession(
                    scope,
                    groupId,
                    sessionId,
                    request,
                ),
            ),
        heartbeatPresenceSession: async (scope, groupId, sessionId, request) =>
            await observeWritten(
                await options.durable.heartbeatPresenceSession(
                    scope,
                    groupId,
                    sessionId,
                    request,
                ),
            ),
        disconnectPresenceSession: async (scope, groupId, sessionId, request) =>
            await observeWritten(
                await options.durable.disconnectPresenceSession(
                    scope,
                    groupId,
                    sessionId,
                    request,
                ),
            ),
        disconnectPresenceSessionsBySessionId: async (sessionId, request) => {
            const snapshots = await options.durable
                .disconnectPresenceSessionsBySessionId(sessionId, request);
            return await Promise.all(snapshots.map(observeSnapshot));
        },
        disconnectPresenceSessionsBySessionIdWritten: async (
            sessionId,
            request,
        ) =>
            await observeWrittenList(
                await options.durable
                    .disconnectPresenceSessionsBySessionIdWritten(
                        sessionId,
                        request,
                    ),
            ),
        expireExpiredPresenceSessions: async (atEpochMs) =>
            await observeWrittenList(
                await options.durable.expireExpiredPresenceSessions(atEpochMs),
            ),
    };

    return service;
}
