import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    configureClientStateSnapshotRepository,
    type ClientStateSnapshotRepositoryOptions
} from './client-state-snapshots-repository.ts';
import {
    configureGroupStateSnapshotRepository,
    type GroupStateSnapshotRepositoryOptions
} from './group-state-snapshots-repository.ts';

export interface SharedStateRepositoryCacheConfiguration {
    clientSnapshots: ClientStateSnapshotRepositoryOptions;
    groupSnapshots: GroupStateSnapshotRepositoryOptions;
}

export function configureSharedStateRepositories(
    config: SharedStateRepositoryCacheConfiguration,
    manager: RepositoryManager = defaultRepositoryManager
): void {
    configureClientStateSnapshotRepository(config.clientSnapshots, manager);
    configureGroupStateSnapshotRepository(config.groupSnapshots, manager);
}
