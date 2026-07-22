import type {
    GroupRef,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';
import type { GroupStateService } from './group-state-service.ts';

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
    return {
        prepareMutation: async (descriptor, authority) =>
            await options.durable.prepareMutation(descriptor, authority),
        prepareExpiredPresenceMutations: async (atEpochMs) =>
            await options.durable.prepareExpiredPresenceMutations(atEpochMs),
        prepareSessionCleanupMutations: async (sessionId, disconnectedAtEpochMs) =>
            await options.durable.prepareSessionCleanupMutations(
                sessionId,
                disconnectedAtEpochMs,
            ),
        read: async (command) => await options.durable.read(command),
        compute: (command, read) => options.durable.compute(command, read),
        validate: (command, read, computed) =>
            options.durable.validate(command, read, computed),
        write: async (transaction, computed) =>
            await options.durable.write(transaction, computed),
        observeSnapshot: (snapshot) => Promise.resolve().then(() => {
            options.cache.observe(snapshot);
            return snapshot;
        }),
        readCurrentSnapshot: async (ref) =>
            await options.durable.readSnapshot(ref),
        readSnapshotAtLeast: async (ref, readOptions) =>
            await options.cache.findOrLoadByRef(ref, readOptions),
        listSnapshots: async (scope) =>
            await options.durable.listSnapshots(scope),
        listSnapshotsPage: async (scope, pageOptions) =>
            await options.durable.listSnapshotsPage(scope, pageOptions),
        readStateRevision: async (ref) =>
            await options.durable.readStateRevision(ref),
        readCausalRevision: async (ref) =>
            await options.durable.readCausalRevision(ref),
        readIssuedAuthSession: async (sessionId) =>
            await options.durable.readIssuedAuthSession(sessionId),
        listEvents: async (ref) =>
            await options.durable.listEvents(ref),
        listRecentEvents: options.durable.listRecentEvents
            ? async (ref, query) => await options.durable.listRecentEvents!(ref, query)
            : undefined,
        listEventPage: async (ref, query) =>
            await options.durable.listEventPage(ref, query),
        readSnapshot: async (ref) =>
            await options.cache.findOrLoadByRef(ref),
    };
}
