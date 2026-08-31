import {
    deriveGraphologyFromRallarGraphCrdt,
    rallarGraphCrdtAddEdgeOperation,
    rallarGraphCrdtAddNodeOperation,
    rallarGraphCrdtRemoveNodeOperation,
    rallarGraphCrdtSetNodePropertyOperation
} from '@shared-graph/crdt/graph-crdt.ts';
import { findGraphByRef, readableGraphCache, setGraph } from '@shared-graph/repository/graphs-repository.ts';
import type { GraphInfoSnapshot } from '@shared-graph/shared-graph-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { createRallarCrdtDocument, rallarCrdtBatch, type RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { configureTestCacheRepositories } from '../configure-test-cache-repositories.ts';

const roomRef: GroupRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1'
};

const documentRef: RallarCrdtDocumentRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    scope: 'room',
    documentType: 'graph-authoring',
    documentId: 'room-1',
    roomRef
};

describe('Rallar graph CRDT spike', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        readableGraphCache().clearAll();
    });

    it('derives deterministic graphology input from concurrent CRDT node and edge edits', () => {
        const first = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('a')
        });
        const second = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-b',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('b')
        });

        const addA = first.applyLocal(
            rallarCrdtBatch([
                rallarGraphCrdtAddNodeOperation({
                    id: 'a'
                })
            ])
        );
        const addBAndEdge = second.applyLocal(
            rallarCrdtBatch([
                rallarGraphCrdtAddNodeOperation({
                    id: 'b'
                }),
                rallarGraphCrdtAddEdgeOperation({
                    id: 'ab',
                    source: 'a',
                    target: 'b',
                    weight: 2
                })
            ])
        );

        first.apply(addBAndEdge);
        second.apply(addA);

        const alpha = first.applyLocal(
            rallarCrdtBatch([
                rallarGraphCrdtSetNodePropertyOperation(
                    'a',
                    'label',
                    'Alpha',
                    'multi'
                )
            ])
        );
        const aardvark = second.applyLocal(
            rallarCrdtBatch([
                rallarGraphCrdtSetNodePropertyOperation(
                    'a',
                    'label',
                    'Aardvark',
                    'multi'
                )
            ])
        );

        first.apply(aardvark);
        second.apply(alpha);

        const firstDerived = deriveGraphologyFromRallarGraphCrdt(first.read(), {
            groupRef: roomRef
        });
        const secondDerived = deriveGraphologyFromRallarGraphCrdt(
            second.read(),
            {
                groupRef: roomRef
            }
        );

        expect(first.read()).toEqual(second.read());
        expect(firstDerived.graph.nodes()).toEqual(['a', 'b']);
        expect(secondDerived.graph.nodes()).toEqual(['a', 'b']);
        expect(firstDerived.graph.hasEdge('a', 'b')).toBe(true);
        expect(
            firstDerived.graph.getEdgeAttributes(
                firstDerived.graph.edge('a', 'b')!
            )
        ).toMatchObject({
            from: 'a',
            to: 'b',
            weight: 2
        });
        expect(firstDerived.nodeLabels).toEqual({
            a: 'Aardvark'
        });
        expect(firstDerived.labelConflicts).toEqual([
            {
                kind: 'node-label',
                id: 'a',
                values: ['Aardvark', 'Alpha']
            }
        ]);
    });

    it('keeps graph repositories as latest-snapshot caches derived from CRDT state', () => {
        const derived = deriveGraphologyFromRallarGraphCrdt(
            {
                nodes: {
                    a: {
                        id: 'a',
                        label: 'Alpha'
                    }
                }
            },
            {
                groupRef: roomRef
            }
        );
        const older = toSnapshot(derived, 1, 1_000);
        const newer = toSnapshot(derived, 2, 2_000);

        expect(setGraph(newer)).toBe(true);
        expect(setGraph(older)).toBe(false);
        expect(findGraphByRef(roomRef)?.version).toBe(2);
    });

    it('uses observed-remove helpers for graph node deletion', () => {
        const document = createRallarCrdtDocument({
            ref: documentRef,
            replicaId: 'replica-a',
            now: fixedNow(1_000),
            createUpdateId: sequenceIds('a')
        });

        document.applyLocal(
            rallarCrdtBatch([
                rallarGraphCrdtAddNodeOperation({
                    id: 'a'
                }),
                rallarGraphCrdtAddNodeOperation({
                    id: 'b'
                }),
                rallarGraphCrdtAddEdgeOperation({
                    id: 'ab',
                    source: 'a',
                    target: 'b'
                })
            ])
        );
        document.applyLocal(
            rallarCrdtBatch([
                rallarGraphCrdtRemoveNodeOperation(document, 'a')
            ])
        );

        const derived = deriveGraphologyFromRallarGraphCrdt(document.read(), {
            groupRef: roomRef
        });

        expect(derived.graph.nodes()).toEqual(['b']);
        expect(derived.graph.edges()).toEqual([]);
    });
});

function toSnapshot(
    derived: ReturnType<typeof deriveGraphologyFromRallarGraphCrdt>,
    version: number,
    createdAtEpochMs: number
): GraphInfoSnapshot {
    return {
        groupRef: derived.groupRef,
        predicted: {
            groupRef: derived.groupRef,
            graph: derived.graph,
            groupGraph: derived.graph,
            coreNodes: derived.graph.nodes()
        },
        createdAtEpochMs,
        version
    };
}

function fixedNow(value: number): () => number {
    return () => value;
}

function sequenceIds(prefix: string): () => string {
    let next = 0;
    return () => `${prefix}-${++next}`;
}
