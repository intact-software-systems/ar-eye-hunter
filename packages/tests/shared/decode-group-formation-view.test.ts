import { describe, expect, it } from 'vitest';

import { decodeGroupFormationView } from '@shared/api/group-lifecycle/decode-group-formation-view.ts';

import { createFormationView } from '../shared-web/rooms/formation/room-formation-test-fixtures.ts';

const groupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

/** The body the HTTP layer hands over is whatever the server sent, decoded as JSON. */
function issuePaths(body: string): readonly string[] {
    return (decodeGroupFormationView(JSON.parse(body), groupRef).left ?? []).map((issue) => issue.path).sort();
}

describe('group formation view decoding', () => {
    it('accepts a complete view for the requested group', () => {
        const view = createFormationView(groupRef);

        expect(decodeGroupFormationView(JSON.parse(JSON.stringify(view)), groupRef).right).toEqual(view);
    });

    it('reports every issue at once', () => {
        const broken = {
            ...createFormationView(groupRef),
            lifecycleState: 'establishing',
            condition: 'green',
            groupRef: { ...groupRef, groupId: 'other' }
        };

        expect(issuePaths(JSON.stringify(broken))).toEqual(['condition', 'groupRef', 'lifecycleState']);
    });

    it('reports a missing field once and refuses a body that is not an object', () => {
        const { readiness: _readiness, ...withoutReadiness } = createFormationView(groupRef);

        expect(decodeGroupFormationView(JSON.parse(JSON.stringify(withoutReadiness)), groupRef).left).toEqual([
            { path: 'readiness', code: 'missing-field', message: 'Formation view is missing readiness' }
        ]);
        expect(decodeGroupFormationView(JSON.parse('"planned"'), groupRef).left).toEqual([
            { path: '$', code: 'invalid-value', message: 'Formation view must be an object' }
        ]);
        expect(issuePaths('[]')).toEqual(['$']);
    });

    it('checks the values the schema pins rather than only the key set', () => {
        const broken = {
            ...createFormationView(groupRef),
            lastFormationOutcome: 'banana',
            establishmentStartedAtEpochMs: -1,
            readiness: { plannedEdgeCount: 1, observedEdgeCount: 0, observedRate: 1.5 },
            pending: {},
            maxFormationAttempts: 0,
            coverageBasisLayoutIdentity: { groupRevision: 1, presenceRevision: 1, version: 1, state: 'active', extra: 1 }
        };

        expect(issuePaths(JSON.stringify(broken))).toEqual([
            'coverageBasisLayoutIdentity',
            'establishmentStartedAtEpochMs',
            'lastFormationOutcome',
            'maxFormationAttempts',
            'pending',
            'readiness'
        ]);
        expect(
            decodeGroupFormationView(
                JSON.parse(JSON.stringify(createFormationView(groupRef, {
                    lastFormationOutcome: { outcome: 'activated', observedRate: 1, atEpochMs: 5, formationEpoch: 1 },
                    pending: { reconfigureQueued: true, dueAtEpochMs: 9, generation: 2 },
                    coverageBasisLayoutIdentity: { groupRevision: 1, presenceRevision: 1, version: 1, state: 'active' }
                }))),
                groupRef
            ).left
        ).toBeUndefined();
    });
});
