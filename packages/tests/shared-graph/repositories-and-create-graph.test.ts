import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { DEFAULT_GRAPH_PROP } from '@shared-graph/algo-props.ts';
import {
    computeIfAbsent,
    findGraphByRef,
    getAllGraphs,
    readableGraphCache,
    setGraph,
    setGraphs,
} from '@shared-graph/repository/graphs-repository.ts';
import { toGraph } from '@shared-graph/graph/create-graph.ts';
import type { GraphInfoSnapshot } from '@shared-graph/shared-graph-types.ts';
import { VertexState, VertexType } from '@shared-graph/graph/graph-props.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

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
        const graph1 = groupRef('graph-1');

        const first = computeIfAbsent(graph1, creator);
        const second = computeIfAbsent(graph1, creator);

        expect(first).toBe(second);
        expect(creator).toHaveBeenCalledTimes(1);
        expect(findGraphByRef(graph1)?.version).toBe(1);

        expect(
            setGraph(createGraphSnapshot('graph-1', 0, 50)),
        ).toBe(false);
        expect(findGraphByRef(graph1)?.version).toBe(1);

        expect(
            setGraph(createGraphSnapshot('graph-1', 2, 200)),
        ).toBe(true);
        expect(findGraphByRef(graph1)?.createdAtEpochMs).toBe(200);

        expect(
            setGraphs([
                createGraphSnapshot('graph-1', 2, 200),
                createGraphSnapshot('graph-2', 1, 300),
            ]),
        ).toBe(true);

        const allGraphs = getAllGraphs().sort((left, right) =>
            left.groupRef.groupId.localeCompare(right.groupRef.groupId),
        );
        expect(allGraphs.map(graph => [graph.groupRef.groupId, graph.version])).toEqual([
            ['graph-1', 2],
            ['graph-2', 1],
        ]);
    });

    it('keys graph snapshots by full group ref, not only group id', () => {
        const workspaceA = createGraphSnapshot('shared-room', 1, 100, {
            workspaceId: 'workspace-a',
        });
        const workspaceB = createGraphSnapshot('shared-room', 1, 200, {
            workspaceId: 'workspace-b',
        });

        expect(setGraphs([workspaceA, workspaceB])).toBe(true);

        expect(findGraphByRef(workspaceA.groupRef)).toBe(workspaceA);
        expect(findGraphByRef(workspaceB.groupRef)).toBe(workspaceB);
        expect(getAllGraphs()).toHaveLength(2);
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
    groupId: string,
    version: number,
    createdAtEpochMs: number,
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {},
): GraphInfoSnapshot {
    const graph = toGraph(new LatestRepository<string, RttMeasurementInfo>(), DEFAULT_GRAPH_PROP);
    const ref = groupRef(groupId, scope);

    return {
        groupRef: ref,
        predicted: {
            groupRef: ref,
            graph,
            groupGraph: graph,
            coreNodes: [],
        },
        createdAtEpochMs,
        version,
    };
}

function groupRef(
    groupId: string,
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {},
): GroupRef {
    return {
        applicationId: scope.applicationId ?? 'app-1',
        workspaceId: scope.workspaceId ?? 'workspace-1',
        groupId,
    };
}
