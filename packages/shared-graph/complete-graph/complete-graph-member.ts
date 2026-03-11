import { addMemberVertex, insertEdgeFromGlobal, makeMember, } from './complete-graph-helpers.ts';
import { TreeGraph, VertexId } from '../graph-props.ts';
import { cloneGraph } from '../graph/graph-algs.ts';

export function createCMGraph(
    globalGraph: TreeGraph,
    groupMembers: ReadonlySet<VertexId>,
): TreeGraph {
    const inputT = cloneGraphEmpty(globalGraph);

    for (const v of groupMembers) {
        addMemberVertex(inputT, globalGraph, v);
    }

    const members = [...groupMembers];
    for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
            insertEdgeFromGlobal(inputT, globalGraph, members[i], members[j]);
        }
    }

    return inputT;
}

export function updateCMTree(
    currentGraph: TreeGraph,
    globalGraph: TreeGraph,
    groupMembers: ReadonlySet<VertexId>,
    newVertex: VertexId,
): TreeGraph {
    const inputT = cloneGraph(currentGraph);

    if (groupMembers.has(newVertex)) {
        if (inputT.hasNode(newVertex)) {
            makeMember(inputT, newVertex);
        } else {
            addMemberVertex(inputT, globalGraph, newVertex);
        }

        for (const member of groupMembers) {
            if (member !== newVertex) {
                insertEdgeFromGlobal(inputT, globalGraph, member, newVertex);
            }
        }
    } else if (inputT.hasNode(newVertex)) {
        inputT.dropNode(newVertex);
    }

    return inputT;
}

function cloneGraphEmpty(reference: TreeGraph): TreeGraph {
    const graph = cloneGraph(reference);
    for (const edge of [...graph.edges()] as string[]) {
        graph.dropEdge(edge);
    }
    for (const node of [...graph.nodes()] as string[]) {
        graph.dropNode(node);
    }
    return graph;
}