import { VertexState } from '@shared-graph/graph/graph-props.ts';
import type { ConnectContext } from '@shared-graph/remove/tree-dynamics-connect-types.ts';
import { connectMCE, connectMDE, connectSearchMCE, connectSearchMDE } from '@shared-graph/remove/tree-dynamics-connect.ts';
import {
    canAcceptAnotherEdge,
    dijkstraDistances,
    findMCEdge,
    findMDEdge,
    hasRequiredGlobalEdge,
    withInsertedEdge,
    worstCaseDist
} from '@shared-graph/remove/tree-dynamics-search.ts';
import { describe, expect, it } from 'vitest';
import { createGraph } from './helpers.ts';

describe('shared-graph tree dynamics search and connect', () => {
    it('searches components for minimum-cost and minimum-diameter reconnection points', () => {
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['u', VertexState.MEMBER, 4],
                ['v', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 5],
                ['a', 'u', 1],
                ['a', 'v', 3],
                ['b', 'u', 1],
                ['u', 'v', 1]
            ]
        );
        const treeGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 1],
                ['b', VertexState.MEMBER, 4],
                ['u', VertexState.MEMBER, 4],
                ['v', VertexState.MEMBER, 4]
            ],
            [
                ['b', 'u', 1],
                ['u', 'v', 1]
            ]
        );

        expect(findMCEdge(globalGraph, treeGraph, 'a', 'b')).toEqual({
            from: 'a',
            to: 'u',
            weight: 1
        });
        expect(findMDEdge(globalGraph, treeGraph, 'a', 'b', 0)).toEqual({
            from: 'a',
            to: 'u',
            diameter: 2
        });
    });

    it('computes shortest-path helpers and inserts edges from the global graph', () => {
        const globalGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 1],
                ['b', VertexState.MEMBER, 2],
                ['u', VertexState.MEMBER, 4],
                ['v', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 5],
                ['a', 'u', 1],
                ['b', 'u', 1],
                ['u', 'v', 1]
            ]
        );
        const treeGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 1],
                ['b', VertexState.MEMBER, 2],
                ['u', VertexState.MEMBER, 4],
                ['v', VertexState.MEMBER, 4]
            ],
            [
                ['b', 'u', 1],
                ['u', 'v', 1]
            ]
        );

        expect(dijkstraDistances(treeGraph, 'b')).toEqual(
            new Map([
                ['a', Number.POSITIVE_INFINITY],
                ['b', 0],
                ['u', 1],
                ['v', 2]
            ])
        );
        expect(worstCaseDist(treeGraph, 'b')).toBe(2);
        expect(canAcceptAnotherEdge(treeGraph, globalGraph, 'a')).toBe(true);

        const inserted = withInsertedEdge(treeGraph, globalGraph, 'a', 'u');
        expect(inserted.hasEdge('a', 'u')).toBe(true);
        expect(hasRequiredGlobalEdge(globalGraph, 'a', 'u')).toBe(true);
        expect(hasRequiredGlobalEdge(globalGraph, 'a', 'v')).toBe(false);
    });

    it('connects components by cost, by diameter, and through subtree search', () => {
        const directGlobal = createGraph(
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
        const isolated = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['c', VertexState.MEMBER, 4]
            ],
            []
        );

        const byCost = connectMCE(
            {
                globalGraph: directGlobal,
                groupGraph: isolated
            },
            new Set(['b', 'c']),
            new Set(['a'])
        );
        expect(byCost.graph.hasEdge('a', 'b')).toBe(true);
        expect(byCost.graph.hasEdge('b', 'c')).toBe(true);
        expect(byCost.remainingVertices.size).toBe(0);

        const byDiameter = connectMDE(
            {
                globalGraph: directGlobal,
                groupGraph: isolated
            },
            new Set(['a', 'b', 'c']),
            new Set<string>()
        );
        expect(byDiameter.graph.hasEdge('a', 'b')).toBe(true);
        expect(byDiameter.graph.hasEdge('a', 'c')).toBe(true);
        expect(byDiameter.graph.hasEdge('b', 'c')).toBe(false);

        const searchGlobal = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['u', VertexState.MEMBER, 4]
            ],
            [
                ['a', 'b', 5],
                ['a', 'u', 1],
                ['b', 'u', 1]
            ]
        );
        const searchGraph = createGraph(
            [
                ['a', VertexState.MEMBER, 4],
                ['b', VertexState.MEMBER, 4],
                ['u', VertexState.MEMBER, 4]
            ],
            [['b', 'u', 1]]
        );

        const searchCost = connectSearchMCE(
            {
                globalGraph: searchGlobal,
                groupGraph: searchGraph
            },
            new Set(['b']),
            new Set(['a'])
        );
        expect(searchCost.graph.hasEdge('a', 'u')).toBe(true);
        expect(searchCost.graph.hasEdge('b', 'u')).toBe(true);

        const searchDiameter = connectSearchMDE(
            {
                globalGraph: searchGlobal,
                groupGraph: searchGraph
            },
            new Set(['a', 'b']),
            new Set<string>()
        );
        expect(searchDiameter.graph.hasEdge('a', 'u')).toBe(true);
        expect(searchDiameter.graph.hasEdge('b', 'u')).toBe(true);
    });
});

describe('an already-linked pair counts as connected', () => {
    it('connectMCE adds no second link between a linked pair', () => {
        // The cheapest pair from a is a-b, already linked, so b counts as connected and nothing is added; c then
        // joins by b-c (2), cheaper than a-c (5). Skipping linked pairs when choosing would pick a-c first and end
        // with three links.
        const result = connectMCE(createLinkedPairContext(), new Set(['b', 'c']), new Set(['a']));

        expect(result.graph.size).toBe(2);
        expect(result.graph.hasEdge('a', 'b')).toBe(true);
        expect(result.graph.hasEdge('b', 'c')).toBe(true);
        expect(result.graph.hasEdge('a', 'c')).toBe(false);
        expect(result.connectedVertices).toEqual(new Set(['a', 'b', 'c']));
        expect(result.remainingVertices).toEqual(new Set<string>());
    });

    it('connectSearchMCE adds no second link between a linked pair', () => {
        const result = connectSearchMCE(createLinkedPairContext(), new Set(['b', 'c']), new Set(['a']));

        expect(result.graph.size).toBe(2);
        expect(result.graph.hasEdge('a', 'b')).toBe(true);
        expect(result.graph.hasEdge('b', 'c')).toBe(true);
        expect(result.remainingVertices).toEqual(new Set<string>());
    });

    it('connectMDE adds no second link between a linked pair', () => {
        // The first pick is a-b (diameter 2), already linked; the second is a-c. Skipping linked pairs would pick b-c.
        const result = connectMDE(createLinkedPairContext(), new Set(['a', 'b', 'c']), new Set<string>());

        expect(result.graph.size).toBe(2);
        expect(result.graph.hasEdge('a', 'b')).toBe(true);
        expect(result.graph.hasEdge('a', 'c')).toBe(true);
        expect(result.remainingVertices).toEqual(new Set(['a']));
        expect(result.connectedVertices).toEqual(new Set(['b', 'c']));
    });

    it('connectSearchMDE adds no second link between a linked pair', () => {
        const result = connectSearchMDE(createLinkedPairContext(), new Set(['a', 'b', 'c']), new Set<string>());

        expect(result.graph.size).toBe(2);
        expect(result.graph.hasEdge('a', 'b')).toBe(true);
        expect(result.graph.hasEdge('b', 'c')).toBe(true);
        expect(result.remainingVertices).toEqual(new Set(['c']));
    });
});

function createLinkedPairContext(): ConnectContext {
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
            ['c', VertexState.MEMBER, 4]
        ],
        [['a', 'b', 1]]
    );

    return { globalGraph, groupGraph };
}
