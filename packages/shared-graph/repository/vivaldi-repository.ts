import { VivaldiNode, type VivaldiNodeData } from '@shared-graph/graph/vivaldi-core.ts';
import { LatestRepository, type LatestRepositoryOptions, } from '@shared/cache/LatestRepository.ts';
import {
    configureLatestRepository,
    newLatestRepositoryToken,
    readLatestRepositoryValue,
    requireLatestRepository,
} from '@shared/cache/LatestRepositoryHelpers.ts';
import type { RepositoryManager } from '@shared/cache/RepositoryManager.ts';

export type VivaldiRepositoryOptions =
    & Omit<LatestRepositoryOptions<VivaldiNode>, 'ttlMs'>
    & { ttlMs: number };

export const vivaldiRepositoryToken =
    newLatestRepositoryToken<string, VivaldiNode>(
        'shared-graph.repository.vivaldi',
        'Vivaldi repository is not configured',
    );

export function configureVivaldiRepository(
    options: VivaldiRepositoryOptions,
    manager?: RepositoryManager,
): LatestRepository<string, VivaldiNode> {
    return configureLatestRepository(vivaldiRepositoryToken, options, manager);
}

function requireVivaldiRepository(
    manager?: RepositoryManager,
): LatestRepository<string, VivaldiNode> {
    return requireLatestRepository(vivaldiRepositoryToken, manager);
}

export function hasNode(
    nodeId: string,
    manager?: RepositoryManager,
): boolean {
    return requireVivaldiRepository(manager).has(nodeId);
}

export function getNodeById(
    nodeId: string,
    manager?: RepositoryManager,
): VivaldiNode | undefined {
    return readLatestRepositoryValue(vivaldiRepositoryToken, nodeId, manager);
}

export function getOrCreateNode(
    nodeId: string,
    dimensions = 4,
    initialError = 1.0,
    manager?: RepositoryManager,
): VivaldiNode {
    return requireVivaldiRepository(manager).setIfAbsent(
        nodeId,
        () => new VivaldiNode({ dimensions, initialError })
    );
}

export function getAllNodeIds(
    manager?: RepositoryManager,
): string[] {
    return [...requireVivaldiRepository(manager).keys()];
}

export function getAllNodeData(
    manager?: RepositoryManager,
): ReadonlyMap<string, VivaldiNodeData> {
    return getNodeDataById(getAllNodeIds(manager), manager);
}

export function getNodeDataById(
    keys: readonly string[],
    manager?: RepositoryManager,
): ReadonlyMap<string, VivaldiNodeData> {
    const nodeById = requireVivaldiRepository(manager);
    const nodeDataById = new Map<string, VivaldiNodeData>();

    for (const nodeId of keys) {
        const vivaldiNode = nodeById.read(nodeId);
        if (vivaldiNode === undefined) {
            continue;
        }

        nodeDataById.set(nodeId, vivaldiNode.toNodeData(nodeId));
    }

    return nodeDataById;
}


export function clearAllNodes(
    manager?: RepositoryManager,
): void {
    requireVivaldiRepository(manager).clearAll();
}
