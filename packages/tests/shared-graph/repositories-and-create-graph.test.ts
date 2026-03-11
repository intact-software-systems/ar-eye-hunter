import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { DEFAULT_GRAPH_PROP } from '@shared-graph/algo-props.ts';
import {
    computeIfAbsent,
    findGraphById,
    getAllGraphs,
    readableGraphCache,
    setGraphById,
    setGraphs,
} from '@shared-graph/repository/graphs-repository.ts';
import { toGraph } from '@shared-graph/graph/create-graph.ts';
import type { GraphInfoSnapshot } from '@shared-graph/shared-graph-types.ts';
import { VertexState, VertexType } from '@shared-graph/graph/graph-props.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

describe('shared-graph repositories and graph creation', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        readableGraphCache().clearAll();
    });

    it('creates an undirected measured graph from RTT samples without duplicating reverse edges', () => {
        const rttById = new LatestRepository<string, RttMeasurementInfo>();
        rttById.set(
            'ab',
            createRtt('peer-a', 'peer-b', 10, 1),
        );
        rttById.set(
            'ba',
            createRtt('peer-b', 'peer-a', 11, 2),
        );
        rttById.set(
            'bc',
            createRtt('peer-b', 'peer-c', 15, 1),
        );

        const graph = toGraph(rttById, DEFAULT_GRAPH_PROP);

        expect(graph.getAttributes()).toEqual(DEFAULT_GRAPH_PROP);
        expect(graph.order).toBe(3);
        expect(graph.size).toBe(2);
        expect(graph.hasEdge('peer-a', 'peer-b')).toBe(true);
        expect(graph.hasEdge('peer-b', 'peer-c')).toBe(true);
        expect(graph.getNodeAttributes('peer-a')).toEqual({
            id: 'peer-a',
            type: VertexType.CLIENT,
            state: VertexState.MEMBER,
            degreeLimit: DEFAULT_GRAPH_PROP.degreeLimitMember,
        });
        expect(graph.getNodeAttributes('peer-c')).toEqual({
            id: 'peer-c',
            type: VertexType.CLIENT,
            state: VertexState.MEMBER,
            degreeLimit: DEFAULT_GRAPH_PROP.degreeLimitMember,
        });

        const abEdge = graph.edge('peer-a', 'peer-b');
        expect(abEdge).toBeDefined();
        expect(graph.getEdgeAttributes(abEdge!)).toEqual({
            from: 'peer-a',
            to: 'peer-b',
            weight: 10,
        });
    });

    it('keeps the newest graph snapshots and only computes absent entries once', () => {
        const creator = vi.fn(() =>
            createGraphSnapshot('graph-1', 1, 100),
        );

        const first = computeIfAbsent('graph-1', creator);
        const second = computeIfAbsent('graph-1', creator);

        expect(first).toBe(second);
        expect(creator).toHaveBeenCalledTimes(1);
        expect(findGraphById('graph-1')?.version).toBe(1);

        expect(
            setGraphById('graph-1', createGraphSnapshot('graph-1', 0, 50)),
        ).toBe(false);
        expect(findGraphById('graph-1')?.version).toBe(1);

        expect(
            setGraphById('graph-1', createGraphSnapshot('graph-1', 2, 200)),
        ).toBe(true);
        expect(findGraphById('graph-1')?.createdAtEpochMs).toBe(200);

        expect(
            setGraphs([
                createGraphSnapshot('graph-1', 2, 200),
                createGraphSnapshot('graph-2', 1, 300),
            ]),
        ).toBe(true);

        const allGraphs = getAllGraphs().sort((left, right) =>
            left.graphId.localeCompare(right.graphId),
        );
        expect(allGraphs.map(graph => [graph.graphId, graph.version])).toEqual([
            ['graph-1', 2],
            ['graph-2', 1],
        ]);
    });
});

function createRtt(
    sessionIdFrom: string,
    sessionIdTo: string,
    rttMs: number,
    version: number,
): RttMeasurementInfo {
    return {
        sessionIdFrom,
        sessionIdTo,
        rttMs,
        createdAtEpochMs: version,
        version,
    };
}

function createGraphSnapshot(
    graphId: string,
    version: number,
    createdAtEpochMs: number,
): GraphInfoSnapshot {
    const graph = toGraph(new LatestRepository<string, RttMeasurementInfo>(), DEFAULT_GRAPH_PROP);

    return {
        graphId,
        predicted: {
            graphId,
            graph,
            groupGraph: graph,
            coreNodes: [],
        },
        createdAtEpochMs,
        version,
    };
}
