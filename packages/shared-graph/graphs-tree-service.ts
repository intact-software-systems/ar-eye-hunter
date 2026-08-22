import { readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { UndirectedGraph } from 'graphology';
import { GlobalArgs, MessageType, ReconfigAlgo } from './algo-props.ts';
import {
    compareVertexIds,
    TreeGraph,
    WeightedGraph,
    type EdgeProp,
    type GraphProp,
    type VertexId,
    type VertexProp
} from './graph-props.ts';
import { kBestLocatedNodesFromVertexSubsetAverage } from './graph/core-node-algorithms.ts';
import { diameterDistance } from './graph/graph-algs.ts';
import { validateGroupTopology, type GroupTopologyValidationResult } from './group-topology-validation.ts';
import { insertMinimumDiameterDegreeLimitedEdge } from './tree/insert-dynamics-mddl.ts';
import { mddlOTTC, relaxDegreeByOne, type RelaxDegreeFn } from './tree/mddl-ottc.ts';
import { removeTryReplaceMDDL } from './tree/remove-dynamics-mddl.ts';

export type CreateGroupTreeInputDto = {
    group: GroupSnapshot;
    globalGraph: WeightedGraph;
    maxDegree?: number;
    relaxDegree?: RelaxDegreeFn;
    selectSource?: (
        globalGraph: WeightedGraph,
        memberSessionIds: ReadonlySet<VertexId>
    ) => VertexId | undefined;
};

export type CreateGroupTreeComputedDto = {
    input: CreateGroupTreeInputDto;
    elapsedMs: number;
    success: boolean;
    source?: VertexId;
    tree: TreeGraph;
    validation: GroupTopologyValidationResult;
    reason?: string;
};

export type UpdateGroupTreeInputDto = {
    type: MessageType;
    fromNode: string;
    group: GroupSnapshot;
    groupGraph: TreeGraph;
    globalGraph: WeightedGraph;
    globalArgs: GlobalArgs;
    selectSteinerCandidate?: (
        tree: TreeGraph,
        globalGraph: WeightedGraph,
        actionVertexId: string,
        related: ReadonlySet<string>
    ) => string | undefined;
};

export type UpdateGroupTreeComputedDto = {
    input: UpdateGroupTreeInputDto;
    elapsedMs: number;
    reconfigured: boolean;
    tree: TreeGraph;
};

export function createGroupTree(
    input: CreateGroupTreeInputDto
): CreateGroupTreeComputedDto {
    const started = performance.now();
    // Canonical member iteration order: tree construction breaks weight ties
    // by first-encountered vertex, so the set must never carry arrival order.
    const memberSessionIds = new Set(
        [...new Set(readGroupMemberSessionIds(input.group))].sort(compareVertexIds)
    );
    const tree = createEmptyGroupGraphLike(input.globalGraph);

    if (memberSessionIds.size === 0) {
        const validation = validateGroupTopology({
            graph: tree,
            activeSessionIds: memberSessionIds,
            maxDegree: input.maxDegree
        });

        return {
            input,
            elapsedMs: performance.now() - started,
            success: validation.valid,
            tree,
            validation
        };
    }

    if (memberSessionIds.size === 1) {
        const [sessionId] = [...memberSessionIds];
        if (!input.globalGraph.hasNode(sessionId)) {
            const validation = validateGroupTopology({
                graph: tree,
                activeSessionIds: memberSessionIds,
                maxDegree: input.maxDegree
            });

            return {
                input,
                elapsedMs: performance.now() - started,
                success: false,
                tree,
                validation,
                reason: `Missing member ${sessionId} in global graph`
            };
        }

        addNodeFromGraph(tree, input.globalGraph, sessionId);

        const validation = validateGroupTopology({
            graph: tree,
            activeSessionIds: memberSessionIds,
            maxDegree: input.maxDegree
        });

        return {
            input,
            elapsedMs: performance.now() - started,
            success: validation.valid,
            source: sessionId,
            tree,
            validation
        };
    }

    const source = input.selectSource?.(input.globalGraph, memberSessionIds) ??
        pickSourceForCreate(input.globalGraph, memberSessionIds);

    if (source === undefined) {
        const validation = validateGroupTopology({
            graph: tree,
            activeSessionIds: memberSessionIds,
            maxDegree: input.maxDegree
        });

        return {
            input,
            elapsedMs: performance.now() - started,
            success: false,
            tree,
            validation,
            reason: 'Could not select source node for tree rebuild'
        };
    }

    const rebuild = mddlOTTC(
        input.globalGraph,
        source,
        memberSessionIds,
        input.relaxDegree ?? noDegreeRelaxation
    );
    const validation = validateGroupTopology({
        graph: rebuild.tree,
        activeSessionIds: memberSessionIds,
        maxDegree: input.maxDegree
    });

    return {
        input,
        elapsedMs: performance.now() - started,
        success: rebuild.success && validation.valid,
        source,
        tree: rebuild.tree,
        validation,
        reason: rebuild.success
            ? validation.valid ? undefined : 'Tree validation failed'
            : 'Tree rebuild failed'
    };
}

export const rebuildGroupTree = createGroupTree;

export function updateGroupTree(
    input: UpdateGroupTreeInputDto
): UpdateGroupTreeComputedDto {
    const started = performance.now();
    const memberSessionIds = readGroupMemberSessionIds(input.group);

    let updatedTree: TreeGraph;

    switch (input.type) {
        case MessageType.TO_SERVER_ENTER: {
            updatedTree = insertMinimumDiameterDegreeLimitedEdge(
                input.groupGraph,
                input.globalGraph,
                input.fromNode,
                (tree, g, actionVertexId, mcpVertexId) =>
                    input.selectSteinerCandidate?.(tree, g, actionVertexId, mcpVertexId)
            );
            break;
        }

        case MessageType.TO_SERVER_LEAVE: {
            updatedTree = removeTryReplaceMDDL(
                input.groupGraph,
                input.globalGraph,
                input.fromNode,
                (tree, g, actionVertexId, adjacent) => input.selectSteinerCandidate?.(tree, g, actionVertexId, adjacent)
            );
            break;
        }

        default:
            throw new Error(`Unsupported message type: ${input.type}`);
    }

    const computedReconfig = computeReconfig(
        updatedTree,
        new Set(memberSessionIds),
        input.globalGraph,
        input.globalArgs
    );

    return {
        input: input,
        elapsedMs: performance.now() - started,
        reconfigured: computedReconfig.left === undefined,
        tree: computedReconfig.right ?? updatedTree
    };
}

export function computeReconfig(
    tree: TreeGraph,
    members: ReadonlySet<string>,
    globalGraph: TreeGraph,
    globalArgs: GlobalArgs
): Either<boolean, TreeGraph> {
    if (members.size < 5) {
        return Either.ofLeft(false);
    }

    switch (globalArgs.reconfigAlgo) {
        case ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE: {
            const currentDiameter = diameterDistance(tree);

            if (currentDiameter <= globalArgs.diameterBound) {
                return Either.ofLeft(false);
            }

            const src = pickSourceForRebuild(tree, members);
            if (src === undefined) {
                return Either.ofLeft(false);
            }

            const rebuild = mddlOTTC(
                globalGraph,
                src,
                members,
                relaxDegreeByOne
            );
            if (!rebuild.success) {
                return Either.ofLeft(false);
            }

            return Either.ofRight(rebuild.tree);
        }

        case ReconfigAlgo.NO_RECONFIG_ALGO:
        default:
            return Either.ofLeft(false);
    }
}

export function pickSourceForRebuild(
    currentTree: TreeGraph,
    members: ReadonlySet<string>
): string | undefined {
    for (const node of currentTree.nodes() as string[]) {
        if (members.has(node)) {
            return node;
        }
    }
    return undefined;
}

export function pickSourceForCreate(
    globalGraph: WeightedGraph,
    members: ReadonlySet<VertexId>
): VertexId | undefined {
    const candidateMembers = new Set(
        [...members].filter((member) => globalGraph.hasNode(member))
    );

    return kBestLocatedNodesFromVertexSubsetAverage(
        globalGraph,
        candidateMembers,
        1
    )[0];
}

export function noDegreeRelaxation(): boolean {
    return false;
}

function createEmptyGroupGraphLike(inputGraph: WeightedGraph): TreeGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(inputGraph.getAttributes());
    return graph;
}

function addNodeFromGraph(
    target: TreeGraph,
    source: WeightedGraph,
    node: VertexId
): void {
    if (target.hasNode(node)) {
        return;
    }
    target.addNode(node, { ...source.getNodeAttributes(node) });
}
