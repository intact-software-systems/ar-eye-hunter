import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { StateSnapshotObservation } from '@shared/repository/state-snapshot-revision.ts';
import type { GroupStateService } from '../group-state-service-contracts.ts';

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

export type CachedGroupStateService =
    & GroupStateService
    & Readonly<{
        observeSnapshot(snapshot: GroupSnapshot): Promise<GroupSnapshot>;
        readCurrentSnapshot(ref: GroupRef): Promise<GroupSnapshot | undefined>;
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
    }>
): CachedGroupStateService {
    return {
        sessionGenerationLifecycle: options.durable.sessionGenerationLifecycle,
        authorizeMutation: async (descriptor, authority) =>
            await options.durable.authorizeMutation(descriptor, authority),
        captureMutationIngress: async (descriptor, authority) =>
            await options.durable.captureMutationIngress(descriptor, authority),
        captureAppInboxMutationIngress: async (descriptor, authority) =>
            await options.durable.captureAppInboxMutationIngress(descriptor, authority),
        captureExpiredPresenceMutationIngresses: async (atEpochMs) =>
            await options.durable.captureExpiredPresenceMutationIngresses(atEpochMs),
        captureSessionCleanupMutationIngresses: async (input) =>
            await options.durable.captureSessionCleanupMutationIngresses(input),
        captureFormationCriterionMutationIngress: async (command, atEpochMs) =>
            await options.durable.captureFormationCriterionMutationIngress(command, atEpochMs),
        captureFormationAutomationMutationIngress: async (command, atEpochMs) =>
            await options.durable.captureFormationAutomationMutationIngress(command, atEpochMs),
        captureTopologyPublicationMutationIngress: async (command, atEpochMs) =>
            await options.durable.captureTopologyPublicationMutationIngress(command, atEpochMs),
        captureActivationStatusMutationIngress: async (command, atEpochMs) =>
            await options.durable.captureActivationStatusMutationIngress(command, atEpochMs),
        read: async (command) => await options.durable.read(command),
        compute: (command, read) => options.durable.compute(command, read),
        validate: (command, read, computed) => options.durable.validate(command, read, computed),
        write: async (transaction, computed) => await options.durable.write(transaction, computed),
        observeSnapshot: (snapshot) =>
            Promise.resolve().then(() => {
                options.cache.observe(snapshot);
                return snapshot;
            }),
        readCurrentSnapshot: async (ref) => await options.durable.readSnapshot(ref),
        readSnapshotAtLeast: async (ref, readOptions) => await options.cache.findOrLoadByRef(ref, readOptions),
        listSnapshots: async (scope) => await options.durable.listSnapshots(scope),
        listSnapshotsPage: async (scope, pageOptions) => await options.durable.listSnapshotsPage(scope, pageOptions),
        readCausalRevision: async (ref) => await options.durable.readCausalRevision(ref),
        readIssuedAuthSession: async (sessionId) => await options.durable.readIssuedAuthSession(sessionId),
        listEvents: async (ref) => await options.durable.listEvents(ref),
        listRecentEvents: async (ref, query) => await options.durable.listRecentEvents(ref, query),
        listEventPage: async (ref, query) => await options.durable.listEventPage(ref, query),
        readSnapshot: async (ref) => await options.cache.findOrLoadByRef(ref)
    };
}
