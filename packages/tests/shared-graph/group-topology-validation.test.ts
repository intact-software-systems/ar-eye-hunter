import { describe, expect, it } from 'vitest';
import { validateGroupTopology } from '@shared-graph/group-topology-validation.ts';
import { VertexState } from '@shared-graph/graph/graph-props.ts';
import { createGraph } from './helpers.ts';

describe('group topology validation', () => {
    it('accepts connected member-only graphs within the degree limit', () => {
        const graph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 5],
                ['peer-b', VertexState.MEMBER, 5],
                ['peer-c', VertexState.MEMBER, 5],
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-b', 'peer-c', 1],
            ],
        );

        const result = validateGroupTopology({
            graph,
            activeSessionIds: new Set(['peer-a', 'peer-b', 'peer-c']),
            maxDegree: 5,
        });

        expect(result.valid).toBe(true);
        expect(result.issues).toEqual([]);
    });

    it('reports missing, inactive, disconnected, and over-degree issues', () => {
        const graph = createGraph(
            [
                ['peer-a', VertexState.MEMBER, 1],
                ['peer-b', VertexState.MEMBER, 1],
                ['peer-c', VertexState.MEMBER, 1],
                ['peer-extra', VertexState.MEMBER, 1],
            ],
            [
                ['peer-a', 'peer-b', 1],
                ['peer-a', 'peer-extra', 1],
            ],
        );

        const result = validateGroupTopology({
            graph,
            activeSessionIds: new Set(['peer-a', 'peer-b', 'peer-c', 'peer-d']),
            maxDegree: 1,
        });

        expect(result.valid).toBe(false);
        expect(result.missingSessionIds).toEqual(['peer-d']);
        expect(result.inactiveSessionIds).toEqual(['peer-extra']);
        expect(result.overDegreeSessionIds).toEqual(['peer-a']);
        expect(result.issues.map((issue) => issue.code)).toEqual([
            'missing-active-session',
            'degree-limit-exceeded',
            'inactive-session-present',
            'disconnected',
        ]);
    });
});
