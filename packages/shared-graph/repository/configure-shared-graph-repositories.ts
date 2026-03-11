import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import { configureGraphRepository, type GraphRepositoryOptions, } from './graphs-repository.ts';
import { configureVivaldiRepository, type VivaldiRepositoryOptions, } from './vivaldi-repository.ts';

export interface SharedGraphRepositoryCacheConfiguration {
    graphs: GraphRepositoryOptions;
    vivaldi: VivaldiRepositoryOptions;
}

export function configureSharedGraphRepositories(
    config: SharedGraphRepositoryCacheConfiguration,
    manager: RepositoryManager = defaultRepositoryManager,
): void {
    configureGraphRepository(config.graphs, manager);
    configureVivaldiRepository(config.vivaldi, manager);
}
