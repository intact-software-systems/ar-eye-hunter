import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { insertMeshAlgorithm, insertToMesh } from '@shared-graph/mesh/insert-mesh-algs.ts';
import { describe, expect, it } from 'vitest';
import { createGraph } from './helpers.ts';

describe('shared-graph insert mesh algorithms', () => {
    it('handles first insertions into an empty group graph', () => {
        const globalGraph = createGraph(
            [['member-a', VertexState.MEMBER, 2]],
            []
        );
        const emptyGroupGraph = createGraph([], []);

        const result = insertToMesh({
            globalGraph,
            groupGraph: emptyGroupGraph,
            actionVertexId: 'member-a',
            numberOfMembers: 1,
            k: 1,
            algo: DynamicMeshAlgo.K_INSERT_MC
        });

        expect(result.validMesh).toBe(true);
        expect(result.groupGraph.nodes()).toEqual(['member-a']);
        expect(result.groupGraph.edges()).toEqual([]);

        expect(() =>
            insertMeshAlgorithm({
                globalGraph,
                groupGraph: createGraph(
                    [['member-a', VertexState.MEMBER, 2]],
                    []
                ),
                actionVertexId: 'member-a',
                numberOfMembers: 1,
                k: 1,
                algo: DynamicMeshAlgo.K_INSERT_MC
            })
        ).toThrow('Expected empty group graph on first insert');
    });

    it('promotes existing steiner vertices to members', () => {
        const globalGraph = createGraph(
            [['member-a', VertexState.MEMBER, 3]],
            []
        );
        const groupGraph = createGraph(
            [['member-a', VertexState.STEINER, 8]],
            []
        );

        const result = insertMeshAlgorithm({
            globalGraph,
            groupGraph,
            actionVertexId: 'member-a',
            numberOfMembers: 2,
            k: 1,
            algo: DynamicMeshAlgo.K_INSERT_MC
        });

        expect(result.getNodeAttribute('member-a', 'state')).toBe(VertexState.MEMBER);
        expect(result.getNodeAttribute('member-a', 'degreeLimit')).toBe(
            result.getAttributes().degreeLimitMember
        );
    });

    it('chooses minimum-cost and diameter-limited targets based on the selected algorithm', () => {
        const globalGraph = createGraph(
            [
                ['member-a', VertexState.MEMBER, 2],
                ['member-b', VertexState.MEMBER, 1],
                ['member-c', VertexState.MEMBER, 2],
                ['member-d', VertexState.MEMBER, 2]
            ],
            [
                ['member-a', 'member-b', 1],
                ['member-a', 'member-c', 3],
                ['member-a', 'member-d', 4],
                ['member-b', 'member-c', 1],
                ['member-c', 'member-d', 10]
            ]
        );
        const groupGraphForMc = createGraph(
            [
                ['member-b', VertexState.MEMBER, 1],
                ['member-c', VertexState.MEMBER, 2],
                ['member-d', VertexState.MEMBER, 2]
            ],
            [
                ['member-b', 'member-c', 1]
            ]
        );
        const groupGraphForMddl = createGraph(
            [
                ['member-b', VertexState.MEMBER, 2],
                ['member-c', VertexState.MEMBER, 2],
                ['member-d', VertexState.MEMBER, 2]
            ],
            [
                ['member-b', 'member-c', 10]
            ]
        );

        const minimumCost = insertMeshAlgorithm({
            globalGraph,
            groupGraph: groupGraphForMc,
            actionVertexId: 'member-a',
            numberOfMembers: 4,
            k: 2,
            algo: DynamicMeshAlgo.K_INSERT_MC
        });

        expect(minimumCost.hasEdge('member-a', 'member-b')).toBe(false);
        expect(minimumCost.hasEdge('member-a', 'member-c')).toBe(true);
        expect(minimumCost.hasEdge('member-a', 'member-d')).toBe(true);

        const diameterLimited = insertMeshAlgorithm({
            globalGraph,
            groupGraph: groupGraphForMddl,
            actionVertexId: 'member-a',
            numberOfMembers: 4,
            k: 1,
            algo: DynamicMeshAlgo.K_INSERT_MDDL
        });

        expect(diameterLimited.hasEdge('member-a', 'member-d')).toBe(true);
        expect(diameterLimited.hasEdge('member-a', 'member-b')).toBe(false);
        expect(diameterLimited.hasEdge('member-a', 'member-c')).toBe(false);
    });
});
