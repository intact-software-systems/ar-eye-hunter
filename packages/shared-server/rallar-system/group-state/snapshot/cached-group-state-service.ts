import type { GroupRef, GroupScope, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';
import { compareRuntimeStateKeys } from '../../../runtime-state/read-batch/compare-runtime-state-keys.ts';
import type { GroupStateService } from '../group-state-service-contracts.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import type { GroupPublicationAuthority } from '../persistence/subscription/read-group-topic-subscriptions.ts';

export type CachedGroupStateServiceCache = Readonly<{
    findOrLoadByRef(
        ref: GroupRef,
        options?: Readonly<{
            minSnapshotVersion?: number;
            minCausalRevision?: GroupStateCausalRevision;
        }>
    ): Promise<GroupSnapshot | undefined>;
    observe(snapshot: GroupSnapshot): StateSnapshotObservation;
}>;

export interface CachedGroupStateServicePrincipalGroups {
    listSnapshotsForPrincipal(scope: GroupScope, principalId: string): Promise<readonly GroupSnapshot[]>;
}

export type CachedGroupStateService =
    & GroupStateService
    & CachedGroupStateServicePrincipalGroups
    & Readonly<{
        observeSnapshot(snapshot: GroupSnapshot): Promise<GroupSnapshot>;
        readCurrentSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
        /**
         * The probed current snapshot and, read after it, the topic's subscription rows and live client generations;
         * undefined when the group has no current snapshot. The rows are never cached.
         */
        readCurrentPublicationAuthority(ref: GroupRef, topicId: string): Promise<GroupPublicationAuthority | undefined>;
        readSnapshotAtLeast(
            ref: GroupRef,
            options: Readonly<{
                minSnapshotVersion?: number;
                minCausalRevision?: GroupStateCausalRevision;
            }>
        ): Promise<GroupSnapshot | undefined>;
    }>;

export function createCachedGroupStateService(
    options: Readonly<{
        durable: GroupStateService;
        cache: CachedGroupStateServiceCache;
        /** The current-state reader: as durable as the service, and may serve an unchanged revision from memory. */
        current: Readonly<{ readSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>; }>;
        /** The groups a principal is an active member of, read through the member index; as durable as the service. */
        principalGroups: CachedGroupStateServicePrincipalGroups;
    }>
): CachedGroupStateService {
    return {
        ...options.durable,
        observeSnapshot: (snapshot) =>
            Promise.resolve().then(() => {
                options.cache.observe(snapshot);
                return snapshot;
            }),
        readCurrentSnapshot: async (ref) => await options.current.readSnapshot(ref),
        readCurrentPublicationAuthority: async (ref, topicId) => {
            const snapshot = await options.current.readSnapshot(ref);
            return snapshot === undefined
                ? undefined
                : { snapshot, ...await options.durable.readGroupTopicSubscriptionAuthority(snapshot, topicId) };
        },
        readSnapshotAtLeast: async (ref, readOptions) => await options.cache.findOrLoadByRef(ref, readOptions),
        listSnapshotsForPrincipal: async (scope, principalId) =>
            toGroupStorageKeyOrder(await options.principalGroups.listSnapshotsForPrincipal(scope, principalId)),
        readSnapshot: async (ref) => await options.cache.findOrLoadByRef(ref)
    };
}

/** The member index yields member-key order; a list answers in group-key order, as the scope scan does. */
function toGroupStorageKeyOrder(snapshots: readonly GroupSnapshot[]): readonly GroupSnapshot[] {
    return snapshots
        .map((snapshot) => ({ snapshot, key: groupStateGroupStorageKey(snapshot.group) }))
        .sort((left, right) => compareRuntimeStateKeys(left.key, right.key))
        .map(({ snapshot }) => snapshot);
}
