import { UndirectedGraph } from 'graphology';

import { readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

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
import { mddlOTTC, relaxDegreeByOne } from './tree/mddl-ottc.ts';
import { removeTryReplaceMDDL } from './tree/remove-dynamics-mddl.ts';

export interface CreateGroupTreeInputDto {
    readonly group: GroupSnapshot;
    readonly globalGraph: WeightedGraph;
    readonly maxDegree: number;
    readonly preferredSource: VertexId | undefined;
}

export interface CreateGroupTreeComputedDto {
    readonly input: CreateGroupTreeInputDto;
    readonly elapsedMs: number;
    readonly success: boolean;
    readonly source: VertexId | undefined;
    readonly tree: TreeGraph;
    readonly validation: GroupTopologyValidationResult;
    readonly reason: string | undefined;
}

export interface UpdateGroupTreeInputDto {
    readonly type: MessageType;
    readonly fromNode: string;
    readonly group: GroupSnapshot;
    readonly groupGraph: TreeGraph;
    readonly globalGraph: WeightedGraph;
    readonly globalArgs: GlobalArgs;
}

export interface UpdateGroupTreeComputedDto {
    readonly input: UpdateGroupTreeInputDto;
    readonly elapsedMs: number;
    readonly reconfigured: boolean;
    readonly tree: TreeGraph;
}

export interface ComputeReconfigInput {
    readonly tree: TreeGraph;
    readonly members: ReadonlySet<string>;
    readonly globalGraph: TreeGraph;
    readonly globalArgs: GlobalArgs;
}

interface GroupTreeBuild {
    readonly tree: TreeGraph;
    readonly source: VertexId | undefined;
    readonly failureReason: string | undefined;
}

export function createGroupTree(
    input: CreateGroupTreeInputDto
): CreateGroupTreeComputedDto {
    const started = performance.now();
    // Canonical member iteration order: tree construction breaks weight ties
    // by first-encountered vertex, so the set must never carry arrival order.
    const memberSessionIds = new Set(
        [...new Set(readGroupMemberSessionIds(input.group))].sort(compareVertexIds)
    );
    const build = computeGroupTreeBuild(input, memberSessionIds);
    const validation = validateGroupTopology({
        graph: build.tree,
        activeSessionIds: memberSessionIds,
        maxDegree: input.maxDegree
    });

    return {
        input,
        elapsedMs: performance.now() - started,
        success: build.failureReason === undefined && validation.valid,
        source: build.source,
        tree: build.tree,
        validation,
        reason: build.failureReason ?? (validation.valid ? undefined : 'Tree validation failed')
    };
}

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
                input.fromNode
            );
            break;
        }

        case MessageType.TO_SERVER_LEAVE: {
            updatedTree = removeTryReplaceMDDL(
                input.groupGraph,
                input.globalGraph,
                input.fromNode
            );
            break;
        }

        default:
            throw new Error(`Unsupported message type: ${input.type}`);
    }

    const computedReconfig = computeReconfig({
        tree: updatedTree,
        members: new Set(memberSessionIds),
        globalGraph: input.globalGraph,
        globalArgs: input.globalArgs
    });

    return {
        input,
        elapsedMs: performance.now() - started,
        reconfigured: computedReconfig.left === undefined,
        tree: computedReconfig.right ?? updatedTree
    };
}

export function computeReconfig(input: ComputeReconfigInput): Either<boolean, TreeGraph> {
    const { tree, members, globalGraph, globalArgs } = input;
    if (members.size < 5) {
        return Either.ofLeft(false);
    }

    switch (globalArgs.reconfigAlgo) {
        case ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE: {
            const currentDiameter = diameterDistance(tree);

            if (currentDiameter <= globalArgs.diameterBound) {
                return Either.ofLeft(false);
            }

            const source = pickSourceForRebuild(tree, members);
            if (source === undefined) {
                return Either.ofLeft(false);
            }

            const rebuild = mddlOTTC(
                globalGraph,
                source,
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

function computeGroupTreeBuild(
    input: CreateGroupTreeInputDto,
    memberSessionIds: ReadonlySet<VertexId>
): GroupTreeBuild {
    const tree = createEmptyGroupGraphLike(input.globalGraph);
    if (memberSessionIds.size === 0) {
        return { tree, source: undefined, failureReason: undefined };
    }

    if (memberSessionIds.size === 1) {
        const [sessionId] = memberSessionIds;
        if (!input.globalGraph.hasNode(sessionId)) {
            return { tree, source: undefined, failureReason: `Missing member ${sessionId} in global graph` };
        }
        addNodeFromGraph(tree, input.globalGraph, sessionId);
        return { tree, source: sessionId, failureReason: undefined };
    }

    const source = resolveGroupTreeSource(input, memberSessionIds);
    if (source === undefined) {
        return { tree, source: undefined, failureReason: 'Could not select source node for tree rebuild' };
    }

    const rebuild = mddlOTTC(input.globalGraph, source, memberSessionIds, noDegreeRelaxation);
    return {
        tree: rebuild.tree,
        source,
        failureReason: rebuild.success ? undefined : 'Tree rebuild failed'
    };
}

function resolveGroupTreeSource(
    input: CreateGroupTreeInputDto,
    memberSessionIds: ReadonlySet<VertexId>
): VertexId | undefined {
    const { preferredSource, globalGraph } = input;
    if (
        preferredSource !== undefined &&
        memberSessionIds.has(preferredSource) &&
        globalGraph.hasNode(preferredSource)
    ) {
        return preferredSource;
    }
    return pickSourceForCreate(globalGraph, memberSessionIds);
}

function noDegreeRelaxation(): boolean {
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
