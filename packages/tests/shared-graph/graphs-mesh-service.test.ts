import { MessageType, ReconfigAlgo } from '@shared-graph/algo-props.ts';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { doReconfigMesh, updateGroupMesh } from '@shared-graph/graphs-mesh-service.ts';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraph, createGroupSnapshot } from './helpers.ts';

const mockState = vi.hoisted(() => ({
    removeVertexFromTree: vi.fn(),
    compGraph: vi.fn(),
    findWCNodes: vi.fn(),
    kMDDLOTTCTree: vi.fn(),
    diameterDistance: vi.fn()
}));

vi.mock('@shared-graph/remove/remove-dynamics-facade.ts', () => ({
    removeVertexFromTree: mockState.removeVertexFromTree
}));

vi.mock('@shared-graph/complete-graph/complete-graph-service.ts', () => ({
    compGraph: mockState.compGraph
}));

vi.mock('@shared-graph/graph/steiner-core-algorithms.ts', () => ({
    CoreSelectionAlgo: {
        CENTER_SELECTION: 'CENTER_SELECTION'
    },
    findWCNodes: mockState.findWCNodes
}));

vi.mock('@shared-graph/mesh/k-mddl-ottc.ts', () => ({
    kMDDLOTTCTree: mockState.kMDDLOTTCTree
}));

vi.mock('@shared-graph/graph/graph-algs.ts', () => ({
    diameterDistance: mockState.diameterDistance
}));

describe('shared-graph mesh service orchestration', () => {
    beforeEach(() => {
        mockState.removeVertexFromTree.mockReset();
        mockState.compGraph.mockReset();
        mockState.findWCNodes.mockReset();
        mockState.kMDDLOTTCTree.mockReset();
        mockState.diameterDistance.mockReset();
    });

    it('uses the injected insert algorithm for join events and skips reconfig for small groups', () => {
        const globalGraph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4]
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-b', 'peer-c', 1],
                ['peer-a', 'peer-c', 2]
            ]
        );
        const insertedMesh = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4]
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-b', 'peer-c', 1]
            ]
        );
        const insertMeshAlgorithmTimed = vi.fn((input) => ({
            input,
            elapsedMs: 1,
            validMesh: true,
            groupGraph: insertedMesh
        }));

        const result = updateGroupMesh({
            type: MessageType.TO_SERVER_ENTER,
            fromNode: 'peer-c',
            group: createGroupSnapshot('group-1', ['peer-a', 'peer-b', 'peer-c']),
            groupGraph: insertedMesh,
            globalGraph,
            fifoSteiner: new Set<string>(),
            globalArgs: {
                meshParamK: 2,
                insertAlgo: DynamicMeshAlgo.K_INSERT_MC,
                removeAlgo: DynamicMeshAlgo.K_REMOVE_MC,
                diameterBound: 2,
                reconfigAlgo: ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE
            },
            deps: {
                insertMeshAlgorithmTimed
            }
        });

        expect(insertMeshAlgorithmTimed).toHaveBeenCalledWith({
            globalGraph,
            groupGraph: insertedMesh,
            actionVertexId: 'peer-c',
            numberOfMembers: 3,
            k: 2,
            algo: DynamicMeshAlgo.K_INSERT_MC
        });
        expect(mockState.removeVertexFromTree).not.toHaveBeenCalled();
        expect(result.reconfigured).toBe(false);
        expect(result.mesh).toBe(insertedMesh);
    });

    it('uses the remove facade for leave events and returns the rebuilt mesh when reconfig succeeds', () => {
        const globalGraph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4],
                ['peer-d', VertexState.MEMBER, 4],
                ['peer-e', VertexState.MEMBER, 4]
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-b', 'peer-c', 1],
                ['peer-c', 'peer-d', 1],
                ['peer-d', 'peer-e', 1],
                ['peer-a', 'peer-e', 1]
            ]
        );
        const completeGraph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4],
                ['peer-d', VertexState.MEMBER, 4],
                ['peer-e', VertexState.MEMBER, 4]
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-a', 'peer-c', 1],
                ['peer-a', 'peer-d', 1],
                ['peer-a', 'peer-e', 1],
                ['peer-b', 'peer-c', 1]
            ]
        );
        const rebuiltMesh = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4],
                ['peer-d', VertexState.MEMBER, 4],
                ['peer-e', VertexState.MEMBER, 4]
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-a', 'peer-c', 1],
                ['peer-a', 'peer-d', 1],
                ['peer-a', 'peer-e', 1]
            ]
        );

        const removedMesh = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-d', VertexState.MEMBER, 4],
                ['peer-e', VertexState.MEMBER, 4]
            ],
            [
                ['peer-a', 'peer-b', 3],
                ['peer-b', 'peer-d', 3],
                ['peer-d', 'peer-e', 3]
            ]
        );

        mockState.removeVertexFromTree.mockReturnValue({
            graph: removedMesh,
            changed: true,
            attemptedAlgo: 'REMOVE_MINIMUM_DIAMETER_EDGE',
            usedFallback: false
        });
        mockState.diameterDistance.mockReturnValue(100);
        mockState.compGraph.mockReturnValue({
            graph: completeGraph
        });
        mockState.findWCNodes.mockReturnValue(['peer-a']);
        mockState.kMDDLOTTCTree.mockReturnValue(rebuiltMesh);

        const result = updateGroupMesh({
            type: MessageType.TO_SERVER_LEAVE,
            fromNode: 'peer-c',
            group: createGroupSnapshot('group-1', [
                'peer-a',
                'peer-b',
                'peer-c',
                'peer-d',
                'peer-e'
            ]),
            groupGraph: globalGraph,
            globalGraph,
            fifoSteiner: new Set(['steiner-1']),
            globalArgs: {
                meshParamK: 2,
                insertAlgo: DynamicMeshAlgo.K_INSERT_MDDL,
                removeAlgo: DynamicMeshAlgo.K_REMOVE_MDDL,
                diameterBound: 2,
                reconfigAlgo: ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE
            },
            deps: {
                insertMeshAlgorithmTimed: vi.fn()
            }
        });

        expect(mockState.removeVertexFromTree).toHaveBeenCalledWith(
            expect.objectContaining({
                actionVertexId: 'peer-c',
                treeAlgo: 'REMOVE_MINIMUM_DIAMETER_EDGE'
            })
        );
        expect(mockState.diameterDistance).toHaveBeenCalledWith(removedMesh);
        expect(mockState.compGraph).toHaveBeenCalledOnce();
        expect(mockState.kMDDLOTTCTree).toHaveBeenCalledWith(completeGraph, 2, 'peer-a');
        expect(result.reconfigured).toBe(true);
        expect(result.mesh).toBe(rebuiltMesh);
        expect(result.removeAttemptedAlgo).toBe('REMOVE_MINIMUM_DIAMETER_EDGE');
        expect(result.removeUsedFallback).toBe(false);
    });

    it('returns a left value when mesh reconfig cannot select a source node', () => {
        const globalGraph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
                ['peer-c', VertexState.MEMBER, 4],
                ['peer-d', VertexState.MEMBER, 4],
                ['peer-e', VertexState.MEMBER, 4]
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-b', 'peer-c', 1],
                ['peer-c', 'peer-d', 1],
                ['peer-d', 'peer-e', 1]
            ]
        );

        mockState.diameterDistance.mockReturnValue(50);
        mockState.compGraph.mockReturnValue({ graph: globalGraph });
        mockState.findWCNodes.mockReturnValue([]);

        const result = doReconfigMesh({
            type: MessageType.TO_SERVER_ENTER,
            fromNode: 'peer-e',
            group: createGroupSnapshot('group-1', [
                'peer-a',
                'peer-b',
                'peer-c',
                'peer-d',
                'peer-e'
            ]),
            groupGraph: globalGraph,
            globalGraph,
            fifoSteiner: new Set<string>(),
            globalArgs: {
                meshParamK: 2,
                insertAlgo: DynamicMeshAlgo.K_INSERT_MC,
                removeAlgo: DynamicMeshAlgo.K_REMOVE_MC,
                diameterBound: 2,
                reconfigAlgo: ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE
            },
            deps: {
                insertMeshAlgorithmTimed: vi.fn()
            }
        });

        expect(result.left).toBe(false);
        expect(result.right).toBeUndefined();
    });
});
