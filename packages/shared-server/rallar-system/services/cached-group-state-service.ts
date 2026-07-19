import type {
    GroupRef,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
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
            minCausalRevision?: GroupStateCausalRevision;
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
            minCausalRevision?: GroupStateCausalRevision;
            minStateRevision?: number;
        }>,
    ): Promise<GroupSnapshot | undefined>;
}>;

export function createCachedGroupStateService(options: Readonly<{
    durable: GroupStateService;
    cache: CachedGroupStateServiceCache;
}>): CachedGroupStateService {
    const observeSnapshot = (
        snapshot: GroupSnapshot,
    ): Promise<GroupSnapshot> => {
        options.cache.observe(snapshot);
        return Promise.resolve(snapshot);
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
    const service: CachedGroupStateService = {
        ...options.durable,
        observeSnapshot,
        readCurrentSnapshot: async (ref) =>
            await options.durable.readSnapshot(ref),
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
        createGroup: async (scope, request, authority) =>
            await observeWritten(
                await options.durable.createGroup(scope, request, authority),
            ),
        updateGroup: async (scope, groupId, request, authority) =>
            await observeWritten(
                await options.durable.updateGroup(scope, groupId, request, authority),
            ),
        appointDirector: async (scope, groupId, request, authority) =>
            await observeWritten(
                await options.durable.appointDirector(scope, groupId, request, authority),
            ),
        joinGroup: async (scope, groupId, request, authority) =>
            await observeWritten(
                await options.durable.joinGroup(scope, groupId, request, authority),
            ),
        createGroupInvite: async (scope, groupId, principalId, request, authority) =>
            await observeWritten(
                await options.durable.createGroupInvite(
                    scope,
                    groupId,
                    principalId,
                    request,
                    authority,
                ),
            ),
        revokeGroupInvite: async (scope, groupId, principalId, request, authority) =>
            await observeWritten(
                await options.durable.revokeGroupInvite(
                    scope,
                    groupId,
                    principalId,
                    request,
                    authority,
                ),
            ),
        acceptGroupInvite: async (scope, groupId, request, authority) =>
            await observeWritten(
                await options.durable.acceptGroupInvite(
                    scope, groupId, request, authority,
                ),
            ),
        rotateGroupJoinCode: async (scope, groupId, request, authority) =>
            await observeJoinCodeWritten(
                await options.durable.rotateGroupJoinCode(
                    scope, groupId, request, authority,
                ),
            ),
        removeGroupMember: async (scope, groupId, principalId, request, authority) =>
            await observeWritten(
                await options.durable.removeGroupMember(
                    scope,
                    groupId,
                    principalId,
                    request,
                    authority,
                ),
            ),
        banGroupMember: async (scope, groupId, principalId, request, authority) =>
            await observeWritten(
                await options.durable.banGroupMember(
                    scope,
                    groupId,
                    principalId,
                    request,
                    authority,
                ),
            ),
        unbanGroupMember: async (scope, groupId, principalId, request, authority) =>
            await observeWritten(
                await options.durable.unbanGroupMember(
                    scope,
                    groupId,
                    principalId,
                    request,
                    authority,
                ),
            ),
        setGroupMemberRole: async (scope, groupId, principalId, request, authority) =>
            await observeWritten(
                await options.durable.setGroupMemberRole(
                    scope,
                    groupId,
                    principalId,
                    request,
                    authority,
                ),
            ),
        transferGroupOwnership: async (scope, groupId, request, authority) =>
            await observeWritten(
                await options.durable.transferGroupOwnership(
                    scope,
                    groupId,
                    request,
                    authority,
                ),
            ),
        upsertMember: async (scope, groupId, principalId, request, authority) =>
            await observeWritten(
                await options.durable.upsertMember(
                    scope,
                    groupId,
                    principalId,
                    request,
                    authority,
                ),
            ),
        connectPresenceSession: async (scope, groupId, sessionId, request, authority) =>
            await observeWritten(
                await options.durable.connectPresenceSession(
                    scope,
                    groupId,
                    sessionId,
                    request,
                    authority,
                ),
            ),
        heartbeatPresenceSession: async (scope, groupId, sessionId, request, authority) =>
            await observeWritten(
                await options.durable.heartbeatPresenceSession(
                    scope,
                    groupId,
                    sessionId,
                    request,
                    authority,
                ),
            ),
        disconnectPresenceSession: async (scope, groupId, sessionId, request, authority) =>
            await observeWritten(
                await options.durable.disconnectPresenceSession(
                    scope,
                    groupId,
                    sessionId,
                    request,
                    authority,
                ),
            ),
    };

    return service;
}
