import { configureSharedGraphRepositories } from '@shared-graph/repository/configure-shared-graph-repositories.ts';
import { configureRttRepository } from '@shared/repository/rtt-repository.ts';
import { configureSharedStateRepositories } from '@shared/repository/configure-shared-state-repositories.ts';

const MINUTE_MS = 60_000;

export type InitialiseRallarServerCacheRepositoriesOptions = Readonly<{
    clientSnapshotsTtlMs?: number;
    groupSnapshotsTtlMs?: number;
    rttTtlMs?: number;
    graphsTtlMs?: number;
    vivaldiTtlMs?: number;
}>;

export function initialiseRallarServerCacheRepositories(
    options: InitialiseRallarServerCacheRepositoriesOptions = {},
): void {
    configureSharedStateRepositories({
        clientSnapshots: {
            ttlMs: options.clientSnapshotsTtlMs ?? 2 * MINUTE_MS,
        },
        groupSnapshots: {
            ttlMs: options.groupSnapshotsTtlMs ?? 2 * MINUTE_MS,
        },
    });
    configureRttRepository({
        ttlMs: options.rttTtlMs ?? MINUTE_MS,
    });

    configureSharedGraphRepositories({
        graphs: {
            ttlMs: options.graphsTtlMs ?? 2 * MINUTE_MS,
        },
        vivaldi: {
            ttlMs: options.vivaldiTtlMs ?? 5 * MINUTE_MS,
        },
    });
}

export const initialiseServerCacheRepositories = initialiseRallarServerCacheRepositories;
