import { compGraph, createCGraph, updateCTree } from '@shared-graph/complete-graph/complete-graph-service.ts';
import { GraphAlgo } from '@shared-graph/complete-graph/complete-graph-types.ts';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { CoreSelectionAlgo } from '@shared-graph/graph/steiner-core-algorithms.ts';
import { describe, expect, it, vi } from 'vitest';
import { createGraph } from './helpers.ts';

describe('shared-graph complete graph service', () => {
    it('creates and updates complete member graphs', () => {
        const globalGraph = createGlobalGraph();

        const created = compGraph({
            globalGraph,
            groupMembers: new Set(['member-a', 'member-b']),
            algo: GraphAlgo.COMPLETE_MEMBER_GRAPH,
            update: false,
            wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
            deps: {
                findWCNodes: vi.fn(),
                generateSizeOfSteinerSet: vi.fn(() => 0)
            }
        });

        expect(created.steinerSet).toEqual(new Set());
        expect(created.graph.nodes().sort()).toEqual(['member-a', 'member-b']);
        expect(created.graph.hasEdge('member-a', 'member-b')).toBe(true);
        expect(created.graph.hasNode('steiner-1')).toBe(false);

        const updated = compGraph({
            globalGraph,
            currentGraph: created.graph,
            groupMembers: new Set(['member-a', 'member-b', 'member-c']),
            newMember: 'member-c',
            algo: GraphAlgo.COMPLETE_MEMBER_GRAPH,
            update: true,
            wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
            deps: {
                findWCNodes: vi.fn(),
                generateSizeOfSteinerSet: vi.fn(() => 0)
            }
        });

        expect(updated.graph.nodes().sort()).toEqual([
            'member-a',
            'member-b',
            'member-c'
        ]);
        expect(updated.graph.hasEdge('member-a', 'member-c')).toBe(true);
        expect(updated.graph.hasEdge('member-b', 'member-c')).toBe(true);
    });

    it('selects and retains steiner vertices for steiner-aware member graphs', () => {
        const globalGraph = createGlobalGraph();
        const findWCNodes = vi.fn(() => ['steiner-2']);

        const created = compGraph({
            globalGraph,
            groupMembers: new Set(['member-a', 'member-b']),
            fifoSteinerSet: new Set(['steiner-1', 'steiner-2']),
            algo: GraphAlgo.COMPLETE_MEMBER_GRAPH_NEW_STEINER,
            update: false,
            wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
            deps: {
                findWCNodes,
                generateSizeOfSteinerSet: vi.fn(() => 1)
            }
        });

        expect(created.steinerSet).toEqual(new Set(['steiner-2']));
        expect(findWCNodes).toHaveBeenCalledWith(
            globalGraph,
            new Set(['steiner-1', 'steiner-2']),
            new Set(['member-a', 'member-b']),
            new Set(['member-a', 'member-b']),
            1,
            CoreSelectionAlgo.CENTER_SELECTION
        );
        expect(created.graph.getNodeAttribute('steiner-2', 'state')).toBe(VertexState.STEINER);
        expect(created.graph.hasEdge('member-a', 'steiner-2')).toBe(true);

        const kept = compGraph({
            globalGraph,
            currentGraph: created.graph,
            groupMembers: new Set(['member-a', 'member-b', 'member-c']),
            newMember: 'member-c',
            existingSteiner: new Set(['steiner-1']),
            fifoSteinerSet: new Set(['steiner-1', 'steiner-2']),
            algo: GraphAlgo.COMPLETE_MEMBER_GRAPH_KEEP_STEINER,
            update: true,
            wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
            deps: {
                findWCNodes: vi.fn(() => ['steiner-2']),
                generateSizeOfSteinerSet: vi.fn(() => 2)
            }
        });

        expect(kept.steinerSet).toEqual(new Set(['steiner-1', 'steiner-2']));
        expect(kept.graph.hasNode('steiner-1')).toBe(true);
        expect(kept.graph.hasNode('steiner-2')).toBe(true);
        expect(kept.graph.hasEdge('member-c', 'steiner-1')).toBe(true);
        expect(kept.graph.hasEdge('member-c', 'steiner-2')).toBe(true);
    });

    it('clones complete graphs and toggles node state on update', () => {
        const globalGraph = createGlobalGraph();
        const cloned = createCGraph(globalGraph, new Set(['member-a', 'member-b']));

        expect(cloned).not.toBe(globalGraph);
        expect(cloned.nodes().sort()).toEqual(globalGraph.nodes().sort());

        const steinerToMember = updateCTree(
            globalGraph,
            globalGraph,
            new Set(['member-a', 'member-b', 'steiner-1']),
            'steiner-1'
        );
        expect(steinerToMember.getNodeAttribute('steiner-1', 'state')).toBe(VertexState.MEMBER);

        const memberToSteiner = updateCTree(
            globalGraph,
            globalGraph,
            new Set(['member-a', 'member-b']),
            'member-c'
        );
        expect(memberToSteiner.getNodeAttribute('member-c', 'state')).toBe(VertexState.STEINER);
    });

    it('requires currentGraph and newMember in update mode', () => {
        const globalGraph = createGlobalGraph();

        expect(() =>
            compGraph({
                globalGraph,
                groupMembers: new Set(['member-a']),
                algo: GraphAlgo.COMPLETE_MEMBER_GRAPH,
                update: true,
                wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
                deps: {
                    findWCNodes: vi.fn(),
                    generateSizeOfSteinerSet: vi.fn(() => 0)
                }
            })
        ).toThrow('currentGraph is required for update mode');

        expect(() =>
            compGraph({
                globalGraph,
                currentGraph: globalGraph,
                groupMembers: new Set(['member-a']),
                algo: GraphAlgo.COMPLETE_GRAPH,
                update: true,
                wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
                deps: {
                    findWCNodes: vi.fn(),
                    generateSizeOfSteinerSet: vi.fn(() => 0)
                }
            })
        ).toThrow('newMember is required for update mode');
    });
});

function createGlobalGraph() {
    return createGraph(
        [
            ['member-a', VertexState.MEMBER, 4],
            ['member-b', VertexState.MEMBER, 4],
            ['member-c', VertexState.MEMBER, 4],
            ['steiner-1', VertexState.STEINER, 8],
            ['steiner-2', VertexState.STEINER, 8]
        ],
        [
            ['member-a', 'member-b', 1],
            ['member-a', 'member-c', 2],
            ['member-b', 'member-c', 3],
            ['member-a', 'steiner-1', 2],
            ['member-b', 'steiner-1', 2],
            ['member-c', 'steiner-1', 1],
            ['member-a', 'steiner-2', 3],
            ['member-b', 'steiner-2', 1],
            ['member-c', 'steiner-2', 2],
            ['steiner-1', 'steiner-2', 1]
        ]
    );
}
