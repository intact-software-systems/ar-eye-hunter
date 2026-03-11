import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { runRemoveAlgorithm } from '@shared-graph/remove/remove-dynamics-service.ts';
import { createGraph } from './helpers.ts';

const mockState = vi.hoisted(() => ({
    registry: {} as Record<string, ReturnType<typeof vi.fn>>,
    defaultRemoveAlgorithm: vi.fn(),
    cleanupRemoveResult: vi.fn(),
}));

vi.mock('@shared-graph/remove/remove-dynamics-registry.ts', () => ({
    removeAlgorithmRegistry: mockState.registry,
    defaultRemoveAlgorithm: mockState.defaultRemoveAlgorithm,
    cleanupRemoveResult: mockState.cleanupRemoveResult,
}));

describe('shared-graph remove dynamics service', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockState.registry)) {
            delete mockState.registry[key];
        }
        mockState.defaultRemoveAlgorithm.mockReset();
        mockState.cleanupRemoveResult.mockReset();
    });

    it('runs the registered algorithm and cleans up the resulting graph by default', () => {
        const initialGraph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
            ],
            [['peer-a', 'peer-b', 1]],
        );
        const resultGraph = createGraph(
            [['peer-a', VertexState.MEMBER, 4]],
            [],
        );
        const cleanedGraph = createGraph(
            [['peer-a', VertexState.MEMBER, 4]],
            [],
        );

        mockState.registry.REMOVE_MINIMUM_COST_EDGE = vi.fn(() => ({
            graph: resultGraph,
            changed: true,
        }));
        mockState.cleanupRemoveResult.mockReturnValue({
            graph: cleanedGraph,
            changed: false,
        });

        const result = runRemoveAlgorithm(
            {
                globalGraph: initialGraph,
                groupGraph: initialGraph,
                actionVertexId: 'peer-b',
                treeAlgo: 'REMOVE_MINIMUM_COST_EDGE',
                steinerCandidates: new Set<string>(),
            },
            {},
            {},
        );

        expect(mockState.registry.REMOVE_MINIMUM_COST_EDGE).toHaveBeenCalledOnce();
        expect(mockState.cleanupRemoveResult).toHaveBeenCalledWith(
            expect.objectContaining({
                actionVertexId: 'peer-b',
                groupGraph: resultGraph,
            }),
        );
        expect(result.graph).toBe(cleanedGraph);
        expect(result.usedFallback).toBe(false);
        expect(result.attemptedAlgo).toBe('REMOVE_MINIMUM_COST_EDGE');
    });

    it('falls back to the configured algorithm when the primary one throws', () => {
        const graph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 4],
                ['peer-b', VertexState.MEMBER, 4],
            ],
            [['peer-a', 'peer-b', 1]],
        );
        const fallbackGraph = createGraph(
            [['peer-a', VertexState.MEMBER, 4]],
            [],
        );

        mockState.registry.REMOVE_SEARCH_MINIMUM_COST_EDGE = vi.fn(() => {
            throw new Error('boom');
        });
        mockState.registry.REMOVE_TRY_REPLACE_MDDL_NAIVE = vi.fn(() => ({
            graph: fallbackGraph,
            changed: true,
        }));

        const result = runRemoveAlgorithm(
            {
                globalGraph: graph,
                groupGraph: graph,
                actionVertexId: 'peer-b',
                treeAlgo: 'REMOVE_SEARCH_MINIMUM_COST_EDGE',
                steinerCandidates: new Set<string>(),
            },
            {},
            {
                cleanupUnusedSteiner: false,
                fallbackAlgo: 'REMOVE_TRY_REPLACE_MDDL_NAIVE',
            },
        );

        expect(mockState.registry.REMOVE_SEARCH_MINIMUM_COST_EDGE).toHaveBeenCalledOnce();
        expect(mockState.registry.REMOVE_TRY_REPLACE_MDDL_NAIVE).toHaveBeenCalledOnce();
        expect(mockState.cleanupRemoveResult).not.toHaveBeenCalled();
        expect(result.graph).toBe(fallbackGraph);
        expect(result.usedFallback).toBe(true);
    });
});
