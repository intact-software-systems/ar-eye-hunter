import { TreeGraph, VertexId, VertexState } from '../graph-props.ts';
import { cloneGraph } from '../graph/graph-algs.ts';
import { createCMGraph, updateCMTree } from './complete-graph-member.ts';
import { createCMGraphSteinerSet, updateCMGraphSteinerSet } from './complete-graph-steiner.ts';
import { GraphAlgo, type CompleteGraphInputDto, type CompleteGraphResult } from './complete-graph-types.ts';

export function compGraph(
    input: CompleteGraphInputDto
): CompleteGraphResult {
    const {
        globalGraph,
        currentGraph,
        groupMembers,
        newMember,
        existingSteiner = new Set<VertexId>(),
        fifoSteinerSet = new Set<VertexId>(),
        algo,
        update,
        wcnAlgo,
        deps
    } = input;

    let steinerSet = new Set<VertexId>();

    if (algo !== GraphAlgo.COMPLETE_MEMBER_GRAPH) {
        if (algo === GraphAlgo.COMPLETE_MEMBER_GRAPH_NEW_STEINER) {
            const numSteiner = deps.generateSizeOfSteinerSet(groupMembers.size);
            if (numSteiner > 0) {
                steinerSet = new Set(
                    deps.findWCNodes(
                        globalGraph,
                        fifoSteinerSet,
                        groupMembers,
                        union(groupMembers, new Set(newMember ? [newMember] : [])),
                        numSteiner,
                        wcnAlgo
                    )
                );
            }
        }
        else if (algo === GraphAlgo.COMPLETE_MEMBER_GRAPH_KEEP_STEINER) {
            const numSteiner = deps.generateSizeOfSteinerSet(groupMembers.size) - existingSteiner.size;

            if (numSteiner > 0) {
                const selected = deps.findWCNodes(
                    globalGraph,
                    fifoSteinerSet,
                    groupMembers,
                    union(groupMembers, union(existingSteiner, new Set(newMember ? [newMember] : []))),
                    numSteiner,
                    wcnAlgo
                );
                steinerSet = new Set(selected);
            }

            steinerSet = union(steinerSet, existingSteiner);
        }
    }

    switch (algo) {
        case GraphAlgo.COMPLETE_MEMBER_GRAPH:
            return {
                graph: !update
                    ? createCMGraph(globalGraph, groupMembers)
                    : updateCMTree(
                        requiredCurrentGraph(currentGraph),
                        globalGraph,
                        groupMembers,
                        requiredNewMember(newMember)
                    ),
                steinerSet
            };

        case GraphAlgo.COMPLETE_MEMBER_GRAPH_KEEP_STEINER:
        case GraphAlgo.COMPLETE_MEMBER_GRAPH_NEW_STEINER:
            return {
                graph: !update
                    ? createCMGraphSteinerSet(globalGraph, groupMembers, steinerSet)
                    : updateCMGraphSteinerSet(
                        requiredCurrentGraph(currentGraph),
                        globalGraph,
                        groupMembers,
                        steinerSet,
                        requiredNewMember(newMember)
                    ),
                steinerSet
            };

        case GraphAlgo.COMPLETE_GRAPH:
            return {
                graph: !update
                    ? createCGraph(globalGraph, groupMembers)
                    : updateCTree(
                        requiredCurrentGraph(currentGraph),
                        globalGraph,
                        groupMembers,
                        requiredNewMember(newMember)
                    ),
                steinerSet
            };

        default:
            throw new Error(`Unsupported graph algo: ${algo}`);
    }
}

export function createCGraph(
    globalGraph: TreeGraph,
    groupMembers: ReadonlySet<VertexId>
): TreeGraph {
    return cloneGraph(globalGraph);
}

export function updateCTree(
    currentGraph: TreeGraph,
    globalGraph: TreeGraph,
    groupMembers: ReadonlySet<VertexId>,
    newVertex: VertexId
): TreeGraph {
    const next = cloneGraph(currentGraph);

    if (groupMembers.has(newVertex)) {
        const attrs = next.getNodeAttributes(newVertex);
        next.replaceNodeAttributes(newVertex, {
            ...attrs,
            state: VertexState.MEMBER
        });
    }
    else if (next.hasNode(newVertex)) {
        const attrs = next.getNodeAttributes(newVertex);
        next.replaceNodeAttributes(newVertex, {
            ...attrs,
            state: VertexState.STEINER
        });
    }

    return next;
}

function requiredCurrentGraph(graph?: TreeGraph): TreeGraph {
    if (!graph) {
        throw new Error('currentGraph is required for update mode');
    }
    return graph;
}

function requiredNewMember(vertex?: VertexId): VertexId {
    if (vertex === undefined) {
        throw new Error('newMember is required for update mode');
    }
    return vertex;
}

function union<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
    return new Set([...a, ...b]);
}
