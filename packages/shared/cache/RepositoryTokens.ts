import { RepositoryToken } from './RepositoryToken.ts';
import { LatestMementoRepository, LatestMementoRepositoryOptions } from './LatestMementoRepository.ts';
import { LoanedMementoRepository, LoanedMementoRepositoryOptions } from './LoanedMementoRepository.ts';
import { LoanedRepositoryRefresh } from './RepositoryInterfaces.ts';

export function latestMementoRepositoryToken<K, V>(
    id: string,
    options: LatestMementoRepositoryOptions<V> = {},
): RepositoryToken<LatestMementoRepository<K, V>> {
    return new RepositoryToken(
        id,
        () => new LatestMementoRepository<K, V>(options),
    );
}

export function loanedMementoRepositoryToken<K, V>(
    id: string,
    refresher: LoanedRepositoryRefresh<K, V>,
    options: LoanedMementoRepositoryOptions<V> = {},
): RepositoryToken<LoanedMementoRepository<K, V>> {
    return new RepositoryToken(
        id,
        () => new LoanedMementoRepository<K, V>(refresher, options),
    );
}