import { configureSharedGraphRepositories } from '@shared-graph/repository/configure-shared-graph-repositories.ts';
import { configureSharedStateRepositories } from '@shared/repository/configure-shared-state-repositories.ts';
import { configureRttRepository } from '@shared/repository/rtt-repository.ts';

const MINUTE_MS = 60_000;

export type InitialiseRallarServerCacheRepositoriesOptions = Readonly<{
    clientSnapshotsTtlMs?: number;
    groupSnapshotsTtlMs?: number;
    rttTtlMs?: number;
    graphsTtlMs?: number;
    vivaldiTtlMs?: number;
    deleteExpiredIntervalMs?: number;
}>;

export function initialiseRallarServerCacheRepositories(
    options: InitialiseRallarServerCacheRepositoriesOptions = {}
): void {
    const deleteExpiredIntervalMs = options.deleteExpiredIntervalMs ?? MINUTE_MS;

    configureSharedStateRepositories({
        clientSnapshots: {
            ttlMs: options.clientSnapshotsTtlMs ?? 2 * MINUTE_MS,
            deleteExpiredIntervalMs
        },
        groupSnapshots: {
            ttlMs: options.groupSnapshotsTtlMs ?? 2 * MINUTE_MS,
            deleteExpiredIntervalMs
        }
    });
    configureRttRepository({
        ttlMs: options.rttTtlMs ?? MINUTE_MS,
        deleteExpiredIntervalMs
    });

    configureSharedGraphRepositories({
        graphs: {
            ttlMs: options.graphsTtlMs ?? 2 * MINUTE_MS,
            deleteExpiredIntervalMs
        },
        vivaldi: {
            ttlMs: options.vivaldiTtlMs ?? 5 * MINUTE_MS,
            deleteExpiredIntervalMs
        }
    });
}

export const initialiseServerCacheRepositories = initialiseRallarServerCacheRepositories;
