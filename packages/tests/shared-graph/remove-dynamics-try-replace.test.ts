import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { rvTryReplace } from '@shared-graph/remove/remove-dynamics-try-replace.ts';
import { createGraph } from './helpers.ts';

const mockState = vi.hoisted(() => ({
    connectMCE: vi.fn(),
    connectMDE: vi.fn(),
    connectSearchMCE: vi.fn(),
    connectSearchMDE: vi.fn(),
    findWCNodes: vi.fn(),
}));

vi.mock('@shared-graph/remove/tree-dynamics-connect.ts', () => ({
    connectMCE: mockState.connectMCE,
    connectMDE: mockState.connectMDE,
    connectSearchMCE: mockState.connectSearchMCE,
    connectSearchMDE: mockState.connectSearchMDE,
}));

vi.mock('@shared-graph/graph/steiner-core-algorithms.ts', () => ({
    CoreSelectionAlgo: {
        CENTER_SELECTION: 'CENTER_SELECTION',
    },
    findWCNodes: mockState.findWCNodes,
}));

describe('shared-graph high-degree try-replace', () => {
    beforeEach(() => {
        mockState.connectMCE.mockReset();
        mockState.connectMDE.mockReset();
        mockState.connectSearchMCE.mockReset();
        mockState.connectSearchMDE.mockReset();
        mockState.findWCNodes.mockReset();

        mockState.connectMCE.mockImplementation((ctx, remaining, connected) => ({
            graph: ctx.groupGraph,
            remainingVertices: new Set(remaining),
            connectedVertices: new Set(connected),
        }));
        mockState.connectMDE.mockImplementation((ctx, remaining, connected) => ({
            graph: ctx.groupGraph,
            remainingVertices: new Set(remaining),
            connectedVertices: new Set(connected),
        }));
        mockState.connectSearchMCE.mockImplementation((ctx, remaining, connected) => ({
            graph: ctx.groupGraph,
            remainingVertices: new Set(remaining),
            connectedVertices: new Set(connected),
        }));
        mockState.connectSearchMDE.mockImplementation((ctx, remaining, connected) => ({
            graph: ctx.groupGraph,
            remainingVertices: new Set(remaining),
            connectedVertices: new Set(connected),
        }));
        mockState.findWCNodes.mockImplementation((_graph, nodeSearchSet: ReadonlySet<string>) =>
            nodeSearchSet.has('sp-1') ? ['sp-1'] : []
        );
    });

    it('selects new steiner points from steinerCandidates for high-degree prune reconfiguration', () => {
        const globalGraph = createGraph(
            [
                ['action', VertexState.MEMBER, 4],
                ['member-a', VertexState.MEMBER, 1],
                ['member-b', VertexState.MEMBER, 1],
                ['member-c', VertexState.MEMBER, 1],
                ['sp-1', VertexState.STEINER, 8],
            ],
            [
                ['action', 'member-a', 1],
                ['action', 'member-b', 1],
                ['action', 'member-c', 1],
                ['sp-1', 'member-a', 1],
                ['sp-1', 'member-b', 1],
                ['sp-1', 'member-c', 1],
            ],
        );
        const groupGraph = createGraph(
            [
                ['action', VertexState.MEMBER, 4],
                ['member-a', VertexState.MEMBER, 1],
                ['member-b', VertexState.MEMBER, 1],
                ['member-c', VertexState.MEMBER, 1],
            ],
            [
                ['action', 'member-a', 1],
                ['action', 'member-b', 1],
                ['action', 'member-c', 1],
            ],
        );

        rvTryReplace({
            globalGraph,
            groupGraph,
            actionVertexId: 'action',
            treeAlgo: 'REMOVE_TRY_REPLACE_PRUNE_MC',
            steinerCandidates: new Set(['sp-1']),
        });

        expect(mockState.findWCNodes).toHaveBeenCalledWith(
            globalGraph,
            new Set(['sp-1']),
            new Set(['action', 'member-a', 'member-b', 'member-c']),
            new Set(['action', 'member-a', 'member-b', 'member-c']),
            1,
            'CENTER_SELECTION',
        );

        const connectInput = mockState.connectMCE.mock.calls[0]?.[0];
        expect(connectInput).toBeDefined();
        expect(connectInput.groupGraph.hasNode('sp-1')).toBe(true);
        expect(connectInput.groupGraph.getNodeAttribute('sp-1', 'state')).toBe(VertexState.STEINER);
    });
});
