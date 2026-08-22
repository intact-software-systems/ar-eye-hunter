import type { GroupRef } from '@shared/api/group-types.ts';
import { LatestRepository, type LatestRepositoryOptions } from '@shared/cache/LatestRepository.ts';
import {
    configureLatestRepository,
    newLatestRepositoryToken,
    readAllLatestRepository,
    readLatestRepositoryValue,
    requireLatestRepository
} from '@shared/cache/LatestRepositoryHelpers.ts';
import { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { GraphInfoSnapshot } from '../shared-graph-types.ts';

export type GraphRepositoryOptions =
    & Omit<LatestRepositoryOptions<GraphInfoSnapshot>, 'ttlMs'>
    & { ttlMs: number; };

export const graphRepositoryToken = newLatestRepositoryToken<string, GraphInfoSnapshot>(
    'shared-graph.repository.graphs',
    'Graph repository is not configured'
);

export function configureGraphRepository(
    options: GraphRepositoryOptions,
    manager?: RepositoryManager
): LatestRepository<string, GraphInfoSnapshot> {
    return configureLatestRepository(graphRepositoryToken, options, manager);
}

function requireGraphRepository(
    manager?: RepositoryManager
): LatestRepository<string, GraphInfoSnapshot> {
    return requireLatestRepository(graphRepositoryToken, manager);
}

export function readableGraphCache(
    manager?: RepositoryManager
): ReadableKeyedValues<string, GraphInfoSnapshot> {
    return requireGraphRepository(manager).readable();
}

export function findGraphByRef(
    groupRef: GroupRef,
    manager?: RepositoryManager
): GraphInfoSnapshot | undefined {
    return readLatestRepositoryValue(
        graphRepositoryToken,
        toGraphRepositoryKey(groupRef),
        manager
    );
}

export function computeIfAbsent(
    groupRef: GroupRef,
    creator: () => GraphInfoSnapshot,
    manager?: RepositoryManager
): GraphInfoSnapshot {
    return requireGraphRepository(manager).setIfAbsent(
        toGraphRepositoryKey(groupRef),
        creator
    );
}

export function setGraphs(
    graphs: GraphInfoSnapshot[],
    manager?: RepositoryManager
): boolean {
    let isAnyUpdated = false;
    for (const graph of graphs) {
        if (setGraph(graph, manager)) {
            isAnyUpdated = true;
        }
    }
    return isAnyUpdated;
}

export function setGraph(
    graph: GraphInfoSnapshot,
    manager?: RepositoryManager
): boolean {
    return requireGraphRepository(manager).updateIfNewer(
        toGraphRepositoryKey(graph.groupRef),
        graph,
        {
            versionOf: (value) => value.version,
            onNewer: (next) => {
                console.log(`Received updated graph details: ${JSON.stringify(next)}`);
            }
        }
    );
}

export function getAllGraphs(
    manager?: RepositoryManager
): GraphInfoSnapshot[] {
    return readAllLatestRepository(graphRepositoryToken, manager);
}

export function toGraphRepositoryKey(ref: GroupRef): string {
    return JSON.stringify([
        ref.applicationId,
        ref.workspaceId ?? '',
        ref.groupId
    ]);
}
