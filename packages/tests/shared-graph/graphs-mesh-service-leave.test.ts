import { MessageType, ReconfigAlgo } from '@shared-graph/algo-props.ts';
import { VertexState, type WeightedGraph } from '@shared-graph/graph/graph-props.ts';
import { updateGroupMesh, type ProcessGroupUpdateMeshResult } from '@shared-graph/graphs-mesh-service.ts';
import { validateGroupTopology } from '@shared-graph/group-topology-validation.ts';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { insertToMesh } from '@shared-graph/mesh/insert-mesh-algs.ts';
import { describe, expect, it } from 'vitest';
import { createGraph, createGroupSnapshot } from './helpers.ts';

describe('a mesh leave through updateGroupMesh', () => {
    it('drops a leaver whose neighbours have no spare degree when the rest stays connected', () => {
        // Every neighbour is at its limit: spare 0 plus 3 neighbours is 3, below 2 × (3 − 1) = 4.
        const left = computeLeaveOfX(createTriangleGlobal(), createSaturatedMesh(), DynamicMeshAlgo.K_REMOVE_MC);

        expect(left.mesh.nodes().sort()).toEqual(['a', 'b', 'c']);
        expect(left.mesh.size).toBe(2);
        expect(left.mesh.hasEdge('a', 'b')).toBe(true);
        expect(left.mesh.hasEdge('b', 'c')).toBe(true);
        expect(left.removeUsedFallback).toBe(false);
        expect(left.removeAttemptedAlgo).toBe('REMOVE_MINIMUM_COST_EDGE');
        expect(validateGroupTopology({ graph: left.mesh, activeSessionIds: new Set(['a', 'b', 'c']) }).valid)
            .toBe(true);
    });

    it('keeps the remove service\'s fallback when dropping the leaver would cut the rest apart', () => {
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 1],
                ['b', VertexState.MEMBER, 1],
                ['c', VertexState.MEMBER, 1]
            ],
            [
                ['a', 'b', 1],
                ['a', 'c', 1],
                ['b', 'c', 1]
            ]
        );
        const groupGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 1],
                ['b', VertexState.MEMBER, 1],
                ['c', VertexState.MEMBER, 1],
                ['x', VertexState.MEMBER, 3]
            ],
            [
                ['x', 'a', 1],
                ['x', 'b', 1],
                ['x', 'c', 1]
            ]
        );

        const left = computeLeaveOfX(globalGraph, groupGraph, DynamicMeshAlgo.K_REMOVE_MC);

        expect(left.removeUsedFallback).toBe(true);
        expect(left.mesh.hasNode('x')).toBe(true);
        expect(left.mesh.getNodeAttribute('x', 'state')).toBe(VertexState.STEINER);
        expect(left.mesh.size).toBe(3);
    });

    it('reconnects the neighbours by cheapest links when they have spare degree', () => {
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 1],
                ['a', 'c', 5],
                ['b', 'c', 2]
            ]
        );
        const groupGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4],
                ['x', VertexState.MEMBER, 4]
            ],
            [
                ['x', 'a', 1],
                ['x', 'b', 1],
                ['x', 'c', 1]
            ]
        );

        const left = computeLeaveOfX(globalGraph, groupGraph, DynamicMeshAlgo.K_REMOVE_MC);

        expect(left.mesh.nodes().sort()).toEqual(['a', 'b', 'c']);
        expect(left.mesh.size).toBe(2);
        expect(left.mesh.hasEdge('a', 'b')).toBe(true);
        expect(left.mesh.hasEdge('b', 'c')).toBe(true);
        expect(left.removeUsedFallback).toBe(false);
    });

    it('reconnects by cheapest links, not by dropping, when the neighbours have spare degree and the rest stays connected', () => {
        // Without x the rest stays connected through d, and each of a, b, c has spare 2: 6 + 3 against 4.
        // rvMCEdge seeds a (a, b, c tie on degree 2; the lowest id wins), drops x, then links cheapest first:
        // a–b (1, beside a–c 5), then b–c (2, beside a–c 5). A plain drop would keep only d–a, d–b, d–c.
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4],
                ['d', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 1],
                ['a', 'c', 5],
                ['b', 'c', 2],
                ['d', 'a', 3],
                ['d', 'b', 3],
                ['d', 'c', 3]
            ]
        );
        const groupGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4],
                ['d', VertexState.MEMBER, 4],
                ['x', VertexState.MEMBER, 4]
            ],
            [
                ['x', 'a', 1],
                ['x', 'b', 1],
                ['x', 'c', 1],
                ['d', 'a', 3],
                ['d', 'b', 3],
                ['d', 'c', 3]
            ]
        );

        const left = computeLeaveOfX(globalGraph, groupGraph, DynamicMeshAlgo.K_REMOVE_MC);

        expect(left.mesh.nodes().sort()).toEqual(['a', 'b', 'c', 'd']);
        expect(left.mesh.size).toBe(5);
        expect(left.mesh.hasEdge('a', 'b')).toBe(true);
        expect(left.mesh.hasEdge('b', 'c')).toBe(true);
        expect(left.removeUsedFallback).toBe(false);
    });

    it('leaves the minimum-diameter remove\'s fallback as it is', () => {
        const left = computeLeaveOfX(createTriangleGlobal(), createSaturatedMesh(), DynamicMeshAlgo.K_REMOVE_MDDL);

        expect(left.removeUsedFallback).toBe(true);
        expect(left.mesh.hasNode('x')).toBe(true);
        expect(left.mesh.getNodeAttribute('x', 'state')).toBe(VertexState.STEINER);
    });
});

function computeLeaveOfX(
    globalGraph: WeightedGraph,
    groupGraph: WeightedGraph,
    removeAlgo: DynamicMeshAlgo
): ProcessGroupUpdateMeshResult {
    return updateGroupMesh({
        type: MessageType.TO_SERVER_LEAVE,
        fromNode: 'x',
        group: createGroupSnapshot('group-1', ['a', 'b', 'c']),
        groupGraph,
        globalGraph,
        fifoSteiner: new Set<string>(),
        globalArgs: {
            meshParamK: 2,
            insertAlgo: DynamicMeshAlgo.K_INSERT_MC,
            removeAlgo,
            diameterBound: Number.POSITIVE_INFINITY,
            reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO
        },
        deps: { insertMeshAlgorithmTimed: insertToMesh }
    });
}

function createTriangleGlobal(): WeightedGraph {
    return createGraph(
        [
            ['a', VertexState.MEMBER, 2],
            ['b', VertexState.MEMBER, 3],
            ['c', VertexState.MEMBER, 2]
        ],
        [
            ['a', 'b', 1],
            ['a', 'c', 1],
            ['b', 'c', 1]
        ]
    );
}

function createSaturatedMesh(): WeightedGraph {
    return createGraph(
        [
            ['a', VertexState.MEMBER, 2],
            ['b', VertexState.MEMBER, 3],
            ['c', VertexState.MEMBER, 2],
            ['x', VertexState.MEMBER, 3]
        ],
        [
            ['x', 'a', 1],
            ['x', 'b', 1],
            ['x', 'c', 1],
            ['a', 'b', 1],
            ['b', 'c', 1]
        ]
    );
}
