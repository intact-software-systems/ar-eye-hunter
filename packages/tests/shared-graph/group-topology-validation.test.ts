import { describe, expect, it } from 'vitest';
import {
    validateGroupTopology,
    validateGroupTopologyNextHops,
} from '@shared-graph/group-topology-validation.ts';
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

    it('validates next-hop topology maps without graphology callers', () => {
        const connected = validateGroupTopologyNextHops({
            activeSessionIds: new Set(['peer-a', 'peer-b', 'peer-c']),
            nextHopsBySessionId: {
                'peer-a': ['peer-b'],
                'peer-b': ['peer-a', 'peer-c'],
                'peer-c': ['peer-b'],
            },
            maxDegree: 2,
        });

        expect(connected.valid).toBe(true);
        expect(connected.issues).toEqual([]);

        const invalid = validateGroupTopologyNextHops({
            activeSessionIds: new Set(['peer-a', 'peer-b', 'peer-c']),
            nextHopsBySessionId: {
                'peer-a': ['peer-b', 'peer-x'],
                'peer-b': ['peer-a'],
                'peer-x': ['peer-a'],
            },
            maxDegree: 1,
        });

        expect(invalid.valid).toBe(false);
        expect(invalid.missingSessionIds).toEqual(['peer-c']);
        expect(invalid.inactiveSessionIds).toEqual(['peer-x']);
        expect(invalid.overDegreeSessionIds).toEqual(['peer-a']);
        expect(invalid.issues.map((issue) => issue.code)).toEqual([
            'missing-active-session',
            'inactive-session-present',
            'degree-limit-exceeded',
            'disconnected',
        ]);
    });
});
