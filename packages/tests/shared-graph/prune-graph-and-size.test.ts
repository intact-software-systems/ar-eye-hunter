import { GraphAlgo } from '@shared-graph/complete-graph/complete-graph-types.ts';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { generateRemainingSizeOfSteinerSet, generateSizeNonSteiner, generateSizeOfSteinerSet } from '@shared-graph/graph/graph-size-algorithms.ts';
import { pruneGraph, PruneGraphAlgo } from '@shared-graph/graph/prune-graph.ts';
import { CoreSelectionAlgo } from '@shared-graph/graph/steiner-core-algorithms.ts';
import { describe, expect, it, vi } from 'vitest';
import { createGraph } from './helpers.ts';

describe('shared-graph prune and sizing algorithms', () => {
    it('computes steiner sizing for explicit, ratio, and remaining-size cases', () => {
        expect(
            generateSizeOfSteinerSet({
                members: 10,
                steinerMemberSize: 5,
                steinerMemberRatio: 0,
                degreeConstraint: 3,
                degreeConstraintSP: 2,
                simPruneAlgo: PruneGraphAlgo.ADD_CORE_LINKS,
                simGraphAlgo: GraphAlgo.COMPLETE_MEMBER_GRAPH_KEEP_STEINER,
                isSteinerAlgo: true
            })
        ).toBe(5);

        expect(
            generateSizeOfSteinerSet({
                members: 10,
                steinerMemberSize: 0,
                steinerMemberRatio: 0.3,
                degreeConstraint: 3,
                degreeConstraintSP: 2,
                simPruneAlgo: PruneGraphAlgo.ADD_CORE_LINKS,
                simGraphAlgo: GraphAlgo.COMPLETE_MEMBER_GRAPH_KEEP_STEINER,
                isSteinerAlgo: true
            })
        ).toBe(3);

        expect(
            generateSizeOfSteinerSet({
                members: 5,
                steinerMemberSize: 0,
                steinerMemberRatio: 0,
                degreeConstraint: 3,
                degreeConstraintSP: 2,
                simPruneAlgo: PruneGraphAlgo.ADD_CORE_LINKS_OPTIMIZED,
                simGraphAlgo: GraphAlgo.COMPLETE_MEMBER_GRAPH,
                isSteinerAlgo: false
            })
        ).toBe(4);

        expect(
            generateRemainingSizeOfSteinerSet({
                members: 10,
                steiner: 4,
                steinerMemberSize: 0,
                steinerMemberRatio: 0,
                degreeConstraint: 3,
                degreeConstraintSP: 2,
                simPruneAlgo: PruneGraphAlgo.ADD_CORE_LINKS,
                simGraphAlgo: GraphAlgo.COMPLETE_MEMBER_GRAPH_KEEP_STEINER,
                isSteinerAlgo: true
            })
        ).toBe(5);

        expect(
            generateSizeNonSteiner({
                members: 5,
                steinerMemberSize: 0,
                degreeConstraint: 3
            })
        ).toBe(4);
    });

    it('clones or reduces graphs depending on prune strategy', () => {
        const inputT = createGraph(
            [
                ['member-a', VertexState.MEMBER, 4],
                ['member-b', VertexState.MEMBER, 4],
                ['member-c', VertexState.MEMBER, 4]
            ],
            [
                ['member-a', 'member-b', 1],
                ['member-b', 'member-c', 2],
                ['member-a', 'member-c', 5]
            ]
        );

        const cloned = pruneGraph({
            inputT,
            k: 1,
            pruneAlgo: PruneGraphAlgo.NO_GRAPH_ALGO,
            wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
            degreeConstraint: 4,
            degreeConstraintSP: 8,
            steinerMemberSize: 0,
            deps: {
                findWCNodes: vi.fn(),
                generateSizeOfSteinerSet: vi.fn(() => 0),
                generateSizeNonSteiner: vi.fn(() => 0)
            }
        });

        expect(cloned.coreSet).toEqual(new Set());
        expect(cloned.graph).not.toBe(inputT);
        expect(cloned.graph.hasEdge('member-a', 'member-c')).toBe(true);

        const kBest = pruneGraph({
            inputT,
            k: 1,
            pruneAlgo: PruneGraphAlgo.K_BEST_LINKS,
            wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
            degreeConstraint: 4,
            degreeConstraintSP: 8,
            steinerMemberSize: 0,
            deps: {
                findWCNodes: vi.fn(),
                generateSizeOfSteinerSet: vi.fn(() => 0),
                generateSizeNonSteiner: vi.fn(() => 0)
            }
        });

        expect(kBest.graph.hasEdge('member-a', 'member-b')).toBe(true);
        expect(kBest.graph.hasEdge('member-b', 'member-c')).toBe(true);
    });

    it('selects core members when pruning graphs without steiner vertices', () => {
        const inputT = createGraph(
            [
                ['member-a', VertexState.MEMBER, 4],
                ['member-b', VertexState.MEMBER, 4],
                ['member-c', VertexState.MEMBER, 4],
                ['member-d', VertexState.MEMBER, 4]
            ],
            [
                ['member-a', 'member-b', 1],
                ['member-a', 'member-c', 3],
                ['member-a', 'member-d', 2],
                ['member-b', 'member-c', 4],
                ['member-b', 'member-d', 5],
                ['member-c', 'member-d', 1]
            ]
        );
        const findWCNodes = vi.fn(() => ['member-a']);

        const result = pruneGraph({
            inputT,
            k: 1,
            pruneAlgo: PruneGraphAlgo.ADD_CORE_LINKS,
            wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
            degreeConstraint: 4,
            degreeConstraintSP: 8,
            steinerMemberSize: 0,
            deps: {
                findWCNodes,
                generateSizeOfSteinerSet: vi.fn(() => 1),
                generateSizeNonSteiner: vi.fn(() => 0)
            }
        });

        expect(result.coreSet).toEqual(new Set(['member-a']));
        expect(findWCNodes).toHaveBeenCalledOnce();
        expect(result.graph.hasEdge('member-a', 'member-b')).toBe(true);
        expect(result.graph.hasEdge('member-a', 'member-c')).toBe(true);
        expect(result.graph.hasEdge('member-a', 'member-d')).toBe(true);
    });

    it('expands the core set when pruning graphs with existing steiner vertices', () => {
        const inputT = createGraph(
            [
                ['member-a', VertexState.MEMBER, 4],
                ['member-b', VertexState.MEMBER, 4],
                ['member-c', VertexState.MEMBER, 4],
                ['steiner-1', VertexState.STEINER, 8]
            ],
            [
                ['member-a', 'member-b', 2],
                ['member-a', 'member-c', 3],
                ['member-b', 'member-c', 1],
                ['member-a', 'steiner-1', 1],
                ['member-b', 'steiner-1', 1],
                ['member-c', 'steiner-1', 1]
            ]
        );
        const findWCNodes = vi.fn(() => ['member-b']);

        const result = pruneGraph({
            inputT,
            k: 1,
            pruneAlgo: PruneGraphAlgo.ADD_CORE_LINKS_OPTIMIZED,
            wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
            degreeConstraint: 4,
            degreeConstraintSP: 2,
            steinerMemberSize: 2,
            deps: {
                findWCNodes,
                generateSizeOfSteinerSet: vi.fn(() => 1),
                generateSizeNonSteiner: vi.fn(() => 1)
            }
        });

        expect(result.coreSet).toEqual(new Set(['member-b', 'steiner-1']));
        expect(findWCNodes).toHaveBeenCalledWith(
            inputT,
            new Set(['member-a', 'member-b', 'member-c', 'steiner-1']),
            new Set(['member-a', 'member-b', 'member-c', 'steiner-1']),
            new Set(['steiner-1']),
            1,
            CoreSelectionAlgo.CENTER_SELECTION
        );
        expect(result.graph.hasNode('steiner-1')).toBe(true);
        expect(result.graph.hasEdge('member-b', 'steiner-1')).toBe(true);
    });
});
