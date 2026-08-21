import { defaultRepositoryManager } from './defaultRepositoryManager.ts';
import { LatestRepository, type LatestRepositoryOptions } from './LatestRepository.ts';
import { ObservableLatestRepository, type ObservableLatestRepositoryOptions } from './ObservableLatestRepository.ts';
import type { RepositoryManager } from './RepositoryManager.ts';
import { RepositoryToken, type DisposableRepository } from './RepositoryToken.ts';

export function newLatestRepositoryToken<K, V>(
    id: string,
    missingMessage: string
): RepositoryToken<LatestRepository<K, V>> {
    return new RepositoryToken<LatestRepository<K, V>>(
        id,
        () => {
            throw new Error(missingMessage);
        }
    );
}

export function newObservableLatestRepositoryToken<K, V>(
    id: string,
    missingMessage: string
): RepositoryToken<ObservableLatestRepository<K, V>> {
    return new RepositoryToken<ObservableLatestRepository<K, V>>(
        id,
        () => {
            throw new Error(missingMessage);
        }
    );
}

export function configureLatestRepository<K, V>(
    token: RepositoryToken<LatestRepository<K, V>>,
    options: LatestRepositoryOptions<V>,
    manager: RepositoryManager = defaultRepositoryManager
): LatestRepository<K, V> {
    const previous = manager.get(token) as DisposableRepository | undefined;
    const repository = new LatestRepository<K, V>(options);
    manager.set(token, repository);
    disposePreviousRepository(previous, token.id);
    return repository;
}

export function configureObservableLatestRepository<K, V>(
    token: RepositoryToken<ObservableLatestRepository<K, V>>,
    options: ObservableLatestRepositoryOptions<K, V>,
    manager: RepositoryManager = defaultRepositoryManager
): ObservableLatestRepository<K, V> {
    const previous = manager.get(token) as DisposableRepository | undefined;
    const repository = new ObservableLatestRepository<K, V>(options);
    manager.set(token, repository);
    disposePreviousRepository(previous, token.id);
    return repository;
}

export function requireLatestRepository<K, V>(
    token: RepositoryToken<LatestRepository<K, V>>,
    manager: RepositoryManager = defaultRepositoryManager
): LatestRepository<K, V> {
    return manager.require(token);
}

export function requireObservableLatestRepository<K, V>(
    token: RepositoryToken<ObservableLatestRepository<K, V>>,
    manager: RepositoryManager = defaultRepositoryManager
): ObservableLatestRepository<K, V> {
    return manager.require(token);
}

export function readLatestRepositoryValue<K, V>(
    token: RepositoryToken<LatestRepository<K, V>>,
    key: K,
    manager: RepositoryManager = defaultRepositoryManager
): V | undefined {
    return requireLatestRepository(token, manager).read(key);
}

export function readObservableLatestRepositoryValue<K, V>(
    token: RepositoryToken<ObservableLatestRepository<K, V>>,
    key: K,
    manager: RepositoryManager = defaultRepositoryManager
): V | undefined {
    return requireObservableLatestRepository(token, manager).read(key);
}

export function readAllLatestRepository<K, V>(
    token: RepositoryToken<LatestRepository<K, V>>,
    manager: RepositoryManager = defaultRepositoryManager
): V[] {
    return requireLatestRepository(token, manager).readAllValues();
}

export function readAllObservableLatestRepository<K, V>(
    token: RepositoryToken<ObservableLatestRepository<K, V>>,
    manager: RepositoryManager = defaultRepositoryManager
): V[] {
    return requireObservableLatestRepository(token, manager).readAllValues();
}

function disposePreviousRepository(
    repository: DisposableRepository | undefined,
    id: string
): void {
    const disposal = repository?.dispose?.();
    if (disposal) {
        void Promise.resolve(disposal).catch((error) => {
            console.error(`Error disposing replaced repository ${id}`, error);
        });
    }
}
