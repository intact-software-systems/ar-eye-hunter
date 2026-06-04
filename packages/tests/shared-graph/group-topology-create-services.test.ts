import { describe, expect, it } from 'vitest';
import { ReconfigAlgo } from '@shared-graph/algo-props.ts';
import { createGroupMesh } from '@shared-graph/graphs-mesh-service.ts';
import { createGroupTree } from '@shared-graph/graphs-tree-service.ts';
import { VertexState, type WeightedGraph } from '@shared-graph/graph/graph-props.ts';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { insertToMesh } from '@shared-graph/mesh/insert-mesh-algs.ts';
import { createGraph, createGroupSnapshot } from './helpers.ts';

describe('group topology create services', () => {
    it.each([5, 10, 15])(
        'creates a member-only tree for %s members with degree <= 5',
        (memberCount) => {
            const memberSessionIds = createMemberIds(memberCount);
            const graph = createCompleteMemberGraph(memberSessionIds, 5);

            const result = createGroupTree({
                group: createGroupSnapshot('tree-room', memberSessionIds),
                globalGraph: graph,
                maxDegree: 5,
            });

            expect(result.success).toBe(true);
            expect(result.validation.valid).toBe(true);
            expect(new Set(result.tree.nodes() as string[])).toEqual(
                new Set(memberSessionIds),
            );
            expect(result.tree.edges()).toHaveLength(memberCount - 1);

            for (const sessionId of memberSessionIds) {
                expect(result.tree.degree(sessionId)).toBeLessThanOrEqual(5);
            }
        },
    );

    it('creates a tree from an average-located source on a sparse connected graph', () => {
        const memberSessionIds = createMemberIds(5);
        const graph = createGraph(
            memberSessionIds.map((sessionId) =>
                [sessionId, VertexState.MEMBER, 5] as const
            ),
            [
                ['peer-1', 'peer-2', 1],
                ['peer-2', 'peer-3', 10],
                ['peer-3', 'peer-4', 10],
                ['peer-4', 'peer-5', 10],
            ],
        );

        const result = createGroupTree({
            group: createGroupSnapshot('sparse-tree-room', memberSessionIds),
            globalGraph: graph,
            maxDegree: 5,
        });

        expect(result.success).toBe(true);
        expect(result.source).toBe('peer-1');
        expect(result.validation.valid).toBe(true);
        expect(new Set(result.tree.nodes() as string[])).toEqual(
            new Set(memberSessionIds),
        );
        expect(result.tree.edges()).toHaveLength(memberSessionIds.length - 1);
    });

    it('creates a member-only mesh for 16 members with degree <= 5', () => {
        const memberSessionIds = createMemberIds(16);
        const graph = createCompleteMemberGraph(memberSessionIds, 5);

        const result = createGroupMesh({
            group: createGroupSnapshot('mesh-room', memberSessionIds),
            globalGraph: graph,
            maxDegree: 5,
            globalArgs: {
                meshParamK: 2,
                insertAlgo: DynamicMeshAlgo.K_INSERT_MC,
                removeAlgo: DynamicMeshAlgo.K_REMOVE_MC,
                diameterBound: 10,
                reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO,
            },
            deps: {
                insertMeshAlgorithmTimed: insertToMesh,
            },
        });

        expect(result.success).toBe(true);
        expect(result.validation.valid).toBe(true);
        expect(new Set(result.mesh.nodes() as string[])).toEqual(
            new Set(memberSessionIds),
        );

        for (const sessionId of memberSessionIds) {
            expect(result.mesh.degree(sessionId)).toBeLessThanOrEqual(5);
        }
    });
});

function createMemberIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `peer-${index + 1}`);
}

function createCompleteMemberGraph(
    memberSessionIds: readonly string[],
    degreeLimit: number,
): WeightedGraph {
    const nodes = memberSessionIds.map((sessionId) =>
        [sessionId, VertexState.MEMBER, degreeLimit] as const
    );
    const edges: Array<readonly [string, string, number]> = [];

    for (let i = 0; i < memberSessionIds.length; i++) {
        for (let j = i + 1; j < memberSessionIds.length; j++) {
            edges.push([
                memberSessionIds[i],
                memberSessionIds[j],
                Math.abs(i - j) + 1,
            ]);
        }
    }

    return createGraph(nodes, edges);
}
