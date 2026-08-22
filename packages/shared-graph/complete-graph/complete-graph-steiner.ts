import { TreeGraph, VertexId, VertexState } from '../graph-props.ts';
import { cloneGraph } from '../graph/graph-algs.ts';
import {
    addMemberVertex,
    addSteinerVertex,
    insertEdgeFromGlobal,
    makeMember,
    makeSteinerAvailable
} from './complete-graph-helpers.ts';

export function createCMGraphSteinerSet(
    globalGraph: TreeGraph,
    groupMembers: ReadonlySet<VertexId>,
    steinerSet: ReadonlySet<VertexId>
): TreeGraph {
    const inputT = cloneGraphEmpty(globalGraph);
    const totalV = new Set<VertexId>([...groupMembers, ...steinerSet]);

    for (const v of totalV) {
        if (groupMembers.has(v)) {
            addMemberVertex(inputT, globalGraph, v);
        }
        else {
            addSteinerVertex(inputT, globalGraph, v);
        }
    }

    const all = [...totalV];
    for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
            insertEdgeFromGlobal(inputT, globalGraph, all[i], all[j]);
        }
    }

    for (const sp of steinerSet) {
        makeSteinerAvailable(inputT, sp);
    }

    return inputT;
}

export function updateCMGraphSteinerSet(
    currentGraph: TreeGraph,
    globalGraph: TreeGraph,
    groupMembers: ReadonlySet<VertexId>,
    inputSteinerSet: ReadonlySet<VertexId>,
    newVertex: VertexId
): TreeGraph {
    const inputT = cloneGraph(currentGraph);

    const steinerSet = new Set([...inputSteinerSet]
        .filter((v) => v !== newVertex && !groupMembers.has(v)));

    if (groupMembers.has(newVertex)) {
        if (inputT.hasNode(newVertex)) {
            makeMember(inputT, newVertex);
        }
        else {
            addMemberVertex(inputT, globalGraph, newVertex);
        }

        for (const member of groupMembers) {
            if (member !== newVertex) {
                insertEdgeFromGlobal(inputT, globalGraph, member, newVertex);
            }
        }
    }
    else if (inputT.hasNode(newVertex)) {
        inputT.dropNode(newVertex);
    }

    for (const node of [...inputT.nodes()] as VertexId[]) {
        const attrs = inputT.getNodeAttributes(node);
        const isSteiner = attrs.state === VertexState.STEINER;
        if (isSteiner && !steinerSet.has(node)) {
            inputT.dropNode(node);
        }
    }

    for (const sp of steinerSet) {
        if (!inputT.hasNode(sp)) {
            addSteinerVertex(inputT, globalGraph, sp);
        }
    }

    const connectV = new Set<VertexId>([...groupMembers, ...steinerSet]);

    for (const sp of steinerSet) {
        makeSteinerAvailable(inputT, sp);

        for (const other of connectV) {
            if (other !== sp) {
                insertEdgeFromGlobal(inputT, globalGraph, sp, other);
            }
        }
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
