import { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { LatestRepository, type LatestRepositoryOptions } from '@shared/cache/LatestRepository.ts';
import {
    configureLatestRepository,
    newLatestRepositoryToken,
    readAllLatestRepository,
    requireLatestRepository
} from '@shared/cache/LatestRepositoryHelpers.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';

export type RttRepositoryOptions =
    & Omit<LatestRepositoryOptions<RttMeasurementInfo>, 'ttlMs'>
    & { ttlMs: number; };

export const rttRepositoryToken = newLatestRepositoryToken<string, RttMeasurementInfo>(
    'shared.repository.rtt',
    'RTT repository is not configured'
);

export function configureRttRepository(
    options: RttRepositoryOptions,
    manager?: RepositoryManager
): LatestRepository<string, RttMeasurementInfo> {
    return configureLatestRepository(rttRepositoryToken, options, manager);
}

function requireRttRepository(
    manager?: RepositoryManager
): LatestRepository<string, RttMeasurementInfo> {
    return requireLatestRepository(rttRepositoryToken, manager);
}

export function latestRttById(
    manager?: RepositoryManager
): LatestRepository<string, RttMeasurementInfo> {
    return requireRttRepository(manager);
}

export function pairKey(sessionIdA: string, sessionIdB: string): string {
    return sessionIdA <= sessionIdB
        ? `${sessionIdA}::${sessionIdB}`
        : `${sessionIdB}::${sessionIdA}`;
}

export function setRttById(
    id: string,
    rtt: RttMeasurementInfo,
    manager?: RepositoryManager
): boolean {
    return requireRttRepository(manager).updateIfNewer(id, rtt, {
        versionOf: (value) => value.version,
        onNewer: (next) => {
            console.log(`Received updated rtt details: ${JSON.stringify(next)}`);
        }
    });
}

export function setRtt(
    rtt: RttMeasurementInfo,
    manager?: RepositoryManager
): boolean {
    return setRttById(pairKey(rtt.sessionIdFrom, rtt.sessionIdTo), rtt, manager);
}

export function getAllRtt(
    manager?: RepositoryManager
): RttMeasurementInfo[] {
    return readAllLatestRepository(rttRepositoryToken, manager);
}
