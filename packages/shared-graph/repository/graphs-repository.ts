import { GraphInfoSnapshot } from '../shared-graph-types.ts';
import { LatestRepository, type LatestRepositoryOptions, } from '@shared/cache/LatestRepository.ts';
import {
    configureLatestRepository,
    newLatestRepositoryToken,
    readAllLatestRepository,
    readLatestRepositoryValue,
    requireLatestRepository,
} from '@shared/cache/LatestRepositoryHelpers.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';

export type GraphRepositoryOptions =
    & Omit<LatestRepositoryOptions<GraphInfoSnapshot>, 'ttlMs'>
    & { ttlMs: number };

export const graphRepositoryToken =
    newLatestRepositoryToken<string, GraphInfoSnapshot>(
        'shared-graph.repository.graphs',
        'Graph repository is not configured',
    );

export function configureGraphRepository(
    options: GraphRepositoryOptions,
    manager?: RepositoryManager,
): LatestRepository<string, GraphInfoSnapshot> {
    return configureLatestRepository(graphRepositoryToken, options, manager);
}

function requireGraphRepository(
    manager?: RepositoryManager,
): LatestRepository<string, GraphInfoSnapshot> {
    return requireLatestRepository(graphRepositoryToken, manager);
}

export function readableGraphCache(
    manager?: RepositoryManager,
): ReadableKeyedValues<string, GraphInfoSnapshot> {
    return requireGraphRepository(manager).readable();
}

export function findGraphById(
    id: string,
    manager?: RepositoryManager,
): GraphInfoSnapshot | undefined {
    return readLatestRepositoryValue(graphRepositoryToken, id, manager);
}

export function computeIfAbsent(
    id: string,
    creator: () => GraphInfoSnapshot,
    manager?: RepositoryManager,
): GraphInfoSnapshot {
    return requireGraphRepository(manager).setIfAbsent(id, creator);
}

export function setGraphs(
    graphs: GraphInfoSnapshot[],
    manager?: RepositoryManager,
): boolean {
    let isAnyUpdated = false;
    for (const graph of graphs) {
        if (setGraphById(graph.graphId, graph, manager)) {
            isAnyUpdated = true;
        }
    }
    return isAnyUpdated;
}

export function setGraphById(
    id: string,
    graph: GraphInfoSnapshot,
    manager?: RepositoryManager,
): boolean {
    return requireGraphRepository(manager).updateIfNewer(id, graph, {
        versionOf: (value) => value.version,
        onNewer: (next) => {
            console.log(`Received updated graph details: ${JSON.stringify(next)}`);
        },
    });
}

export function getAllGraphs(
    manager?: RepositoryManager,
): GraphInfoSnapshot[] {
    return readAllLatestRepository(graphRepositoryToken, manager);
}
