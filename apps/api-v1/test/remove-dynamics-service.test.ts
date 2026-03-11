import { UndirectedGraph } from 'graphology';
import {
    type EdgeProp,
    type GraphProp,
    TreeGraph,
    VertexId,
    type VertexProp,
    VertexState,
    VertexType,
} from '@shared-graph/graph/graph-props.ts';
import { runRemoveAlgorithm } from '@shared-graph/remove/remove-dynamics-service.ts';
import type { RemoveDynamicsContext } from '@shared-graph/remove/remove-dynamics-types.ts';
import { CoreSelectionAlgo, findWCNodes } from '@shared-graph/graph/steiner-core-algorithms.ts';

function makeGraph(id = 'g1'): TreeGraph {
    const g = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    g.replaceAttributes({
        id,
        version: 1,
        degreeLimitMember: 4,
        degreeLimitSteiner: 8,
    });
    return g;
}

function addMemberNode(g: TreeGraph, id: string, degreeLimit?: number): void {
    if (g.hasNode(id)) return;

    g.addNode(id, {
        id,
        type: VertexType.CLIENT,
        state: VertexState.MEMBER,
        degreeLimit: degreeLimit ?? g.getAttributes().degreeLimitMember,
    });
}

function addSteinerNode(g: TreeGraph, id: string, degreeLimit?: number): void {
    if (g.hasNode(id)) return;

    g.addNode(id, {
        id,
        type: VertexType.CORE,
        state: VertexState.STEINER,
        degreeLimit: degreeLimit ?? g.getAttributes().degreeLimitSteiner,
    });
}

function connect(g: TreeGraph, a: string, b: string, weight: number): void {
    if (!g.hasNode(a)) addMemberNode(g, a);
    if (!g.hasNode(b)) addMemberNode(g, b);

    if (!g.hasEdge(a, b)) {
        g.addEdge(a, b, {
            from: a,
            to: b,
            weight,
        });
    }
}

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(message);
    }
}

function runTest(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (error) {
        console.error(`FAIL ${name}`);
        throw error;
    }
}

function makeSelectSteinerCandidate() {
    return (
        ctx: RemoveDynamicsContext,
        adjacent: ReadonlySet<VertexId>,
    ): VertexId | undefined => {
        if (ctx.steinerCandidates.size === 0) {
            return undefined;
        }

        const exclude = new Set<string>(ctx.groupGraph.nodes() as string[]);
        const candidates = findWCNodes(
            ctx.globalGraph,
            ctx.steinerCandidates,
            adjacent,
            exclude,
            1,
            CoreSelectionAlgo.CENTER_SELECTION,
        );

        return candidates[0];
    };
}

function testLeafRemoval(): void {
    const globalGraph = makeGraph('global');
    connect(globalGraph, 'A', 'B', 1);

    const groupGraph = makeGraph('group');
    connect(groupGraph, 'A', 'B', 1);

    const result = runRemoveAlgorithm({
        globalGraph,
        groupGraph,
        actionVertexId: 'B',
        treeAlgo: 'NO_DYNAMIC_TREE_ALGO',
        steinerCandidates: new Set<string>(),
    });

    assert(!result.graph.hasNode('B'), 'expected leaf B to be removed');
    assert(!result.usedFallback, 'did not expect fallback');
}

function testDegreeTwoRemovalReconnectsNeighbors(): void {
    const globalGraph = makeGraph('global');
    connect(globalGraph, 'A', 'B', 1);
    connect(globalGraph, 'B', 'C', 1);
    connect(globalGraph, 'A', 'C', 2);

    const groupGraph = makeGraph('group');
    connect(groupGraph, 'A', 'B', 1);
    connect(groupGraph, 'B', 'C', 1);

    const result = runRemoveAlgorithm({
        globalGraph,
        groupGraph,
        actionVertexId: 'B',
        treeAlgo: 'NO_DYNAMIC_TREE_ALGO',
        steinerCandidates: new Set<string>(),
    });

    assert(!result.graph.hasNode('B'), 'expected B to be removed');
    assert(result.graph.hasEdge('A', 'C'), 'expected A-C reconnection');
    assert(!result.usedFallback, 'did not expect fallback');
}

function testMddlNaiveKeepsActionAsSteinerWhenBest(): void {
    const globalGraph = makeGraph('global');
    connect(globalGraph, 'A', 'X', 1);
    connect(globalGraph, 'B', 'X', 1);
    connect(globalGraph, 'C', 'X', 1);
    connect(globalGraph, 'A', 'B', 5);
    connect(globalGraph, 'A', 'C', 5);
    connect(globalGraph, 'B', 'C', 5);

    const groupGraph = makeGraph('group');
    addMemberNode(groupGraph, 'A');
    addMemberNode(groupGraph, 'B');
    addMemberNode(groupGraph, 'C');
    addMemberNode(groupGraph, 'X');
    connect(groupGraph, 'X', 'A', 1);
    connect(groupGraph, 'X', 'B', 1);
    connect(groupGraph, 'X', 'C', 1);

    const result = runRemoveAlgorithm({
        globalGraph,
        groupGraph,
        actionVertexId: 'X',
        treeAlgo: 'REMOVE_TRY_REPLACE_MDDL_NAIVE',
        steinerCandidates: new Set<string>(),
    });

    assert(result.graph.hasNode('X'), 'expected X to remain as Steiner');
    const attrs = result.graph.getNodeAttributes('X');
    assert(attrs.state === VertexState.STEINER, 'expected X to be STEINER');
    assert(!result.usedFallback, 'did not expect fallback');
}

function testTryReplacePruneWithExternalSteinerCandidate(): void {
    const globalGraph = makeGraph('global');
    addSteinerNode(globalGraph, 'S1');
    addMemberNode(globalGraph, 'X');
    addMemberNode(globalGraph, 'A');
    addMemberNode(globalGraph, 'B');
    addMemberNode(globalGraph, 'C');

    connect(globalGraph, 'X', 'A', 1);
    connect(globalGraph, 'X', 'B', 1);
    connect(globalGraph, 'X', 'C', 1);
    connect(globalGraph, 'S1', 'A', 1);
    connect(globalGraph, 'S1', 'B', 1);
    connect(globalGraph, 'S1', 'C', 1);
    connect(globalGraph, 'A', 'B', 4);
    connect(globalGraph, 'A', 'C', 4);
    connect(globalGraph, 'B', 'C', 4);

    const groupGraph = makeGraph('group');
    addMemberNode(groupGraph, 'X');
    addMemberNode(groupGraph, 'A');
    addMemberNode(groupGraph, 'B');
    addMemberNode(groupGraph, 'C');
    connect(groupGraph, 'X', 'A', 1);
    connect(groupGraph, 'X', 'B', 1);
    connect(groupGraph, 'X', 'C', 1);

    const result = runRemoveAlgorithm(
        {
            globalGraph,
            groupGraph,
            actionVertexId: 'X',
            treeAlgo: 'REMOVE_TRY_REPLACE_PRUNE_MDDL',
            steinerCandidates: new Set<string>(['S1']),
        },
        {
            selectSteinerCandidate: makeSelectSteinerCandidate(),
            coreSelectionAlgo: CoreSelectionAlgo.CENTER_SELECTION,
        },
    );

    assert(!result.graph.hasNode('X'), 'expected X to be removed in prune/replace');
    assert(result.graph.nodes().length >= 3, 'expected graph to remain connected-ish');
}

function testMinimumCostFallbackToMddlNaive(): void {
    const globalGraph = makeGraph('global');
    addMemberNode(globalGraph, 'A', 1);
    addMemberNode(globalGraph, 'B', 1);
    addMemberNode(globalGraph, 'C', 1);
    addMemberNode(globalGraph, 'X', 1);

    connect(globalGraph, 'X', 'A', 1);
    connect(globalGraph, 'X', 'B', 1);
    connect(globalGraph, 'X', 'C', 1);
    connect(globalGraph, 'A', 'B', 10);
    connect(globalGraph, 'A', 'C', 10);
    connect(globalGraph, 'B', 'C', 10);

    const groupGraph = makeGraph('group');
    addMemberNode(groupGraph, 'A', 1);
    addMemberNode(groupGraph, 'B', 1);
    addMemberNode(groupGraph, 'C', 1);
    addMemberNode(groupGraph, 'X', 1);
    connect(groupGraph, 'X', 'A', 1);
    connect(groupGraph, 'X', 'B', 1);
    connect(groupGraph, 'X', 'C', 1);

    const result = runRemoveAlgorithm(
        {
            globalGraph,
            groupGraph,
            actionVertexId: 'X',
            treeAlgo: 'REMOVE_MINIMUM_COST_EDGE',
            steinerCandidates: new Set<string>(),
        },
        {},
        {
            fallbackAlgo: 'REMOVE_TRY_REPLACE_MDDL_NAIVE',
            cleanupUnusedSteiner: true,
        },
    );

    assert(result.usedFallback, 'expected fallback to be used');
}

function testMinimumDiameterFallbackToMddlNaive(): void {
    const globalGraph = makeGraph('global');
    addMemberNode(globalGraph, 'A', 1);
    addMemberNode(globalGraph, 'B', 1);
    addMemberNode(globalGraph, 'C', 1);
    addMemberNode(globalGraph, 'X', 1);

    connect(globalGraph, 'X', 'A', 1);
    connect(globalGraph, 'X', 'B', 1);
    connect(globalGraph, 'X', 'C', 1);
    connect(globalGraph, 'A', 'B', 10);
    connect(globalGraph, 'A', 'C', 10);
    connect(globalGraph, 'B', 'C', 10);

    const groupGraph = makeGraph('group');
    addMemberNode(groupGraph, 'A', 1);
    addMemberNode(groupGraph, 'B', 1);
    addMemberNode(groupGraph, 'C', 1);
    addMemberNode(groupGraph, 'X', 1);
    connect(groupGraph, 'X', 'A', 1);
    connect(groupGraph, 'X', 'B', 1);
    connect(groupGraph, 'X', 'C', 1);

    const result = runRemoveAlgorithm(
        {
            globalGraph,
            groupGraph,
            actionVertexId: 'X',
            treeAlgo: 'REMOVE_MINIMUM_DIAMETER_EDGE',
            steinerCandidates: new Set<string>(),
        },
        {},
        {
            fallbackAlgo: 'REMOVE_TRY_REPLACE_MDDL_NAIVE',
            cleanupUnusedSteiner: true,
        },
    );

    assert(result.usedFallback, 'expected fallback to be used');
}

function testCleanupRemovesUnusedSteinerLeaf(): void {
    const globalGraph = makeGraph('global');
    addMemberNode(globalGraph, 'A');
    addMemberNode(globalGraph, 'B');
    addMemberNode(globalGraph, 'X');
    addSteinerNode(globalGraph, 'S1');
    connect(globalGraph, 'X', 'A', 1);
    connect(globalGraph, 'X', 'B', 1);
    connect(globalGraph, 'S1', 'A', 1);
    connect(globalGraph, 'S1', 'B', 1);

    const groupGraph = makeGraph('group');
    addMemberNode(groupGraph, 'A');
    addMemberNode(groupGraph, 'B');
    addMemberNode(groupGraph, 'X');
    addSteinerNode(groupGraph, 'S1');
    connect(groupGraph, 'X', 'A', 1);
    connect(groupGraph, 'X', 'B', 1);
    connect(groupGraph, 'S1', 'A', 1);

    const result = runRemoveAlgorithm(
        {
            globalGraph,
            groupGraph,
            actionVertexId: 'X',
            treeAlgo: 'REMOVE_TRY_REPLACE_MDDL_NAIVE',
            steinerCandidates: new Set<string>(),
        },
        {},
        {
            cleanupUnusedSteiner: true,
        },
    );

    if (result.graph.hasNode('S1')) {
        assert(
            result.graph.degree('S1') > 1 || result.graph.getNodeAttributes('S1').state === VertexState.MEMBER,
            'expected unused Steiner leaf to be pruned',
        );
    }
}

export function main(): void {
    runTest('leaf removal removes the leaf', testLeafRemoval);
    runTest('degree-2 removal reconnects neighbors', testDegreeTwoRemovalReconnectsNeighbors);
    runTest('MDDL naive can keep action vertex as Steiner', testMddlNaiveKeepsActionAsSteinerWhenBest);
    runTest('try-replace prune can use external Steiner candidate', testTryReplacePruneWithExternalSteinerCandidate);
    runTest('minimum-cost remove can fall back to MDDL naive', testMinimumCostFallbackToMddlNaive);
    runTest('minimum-diameter remove can fall back to MDDL naive', testMinimumDiameterFallbackToMddlNaive);
    runTest('cleanup prunes unused Steiner leaf', testCleanupRemovesUnusedSteinerLeaf);
    console.log('All remove-dynamics service tests passed.');
}

if (import.meta.main) {
    main();
}
