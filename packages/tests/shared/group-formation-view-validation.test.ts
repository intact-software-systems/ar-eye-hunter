import { describe, expect, it } from 'vitest';

import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import { validateGroupFormationView } from '@shared/api/group-lifecycle/validate-group-formation-view.ts';

const groupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

function createView(): GroupFormationView {
    return {
        groupRef,
        lifecycleState: 'planned',
        formationEpoch: 1,
        formationAttemptCount: 0,
        lastFormationOutcome: null,
        establishmentStartedAtEpochMs: null,
        readiness: { plannedEdgeCount: 1, observedEdgeCount: 0, observedRate: 0 },
        managerPrincipalIds: ['alice'],
        layoutStale: false,
        pending: null,
        maxFormationAttempts: 2,
        condition: 'inactive',
        remediation: 'none',
        coverageBasisLayoutIdentity: null
    };
}

/** The body the HTTP layer hands over is whatever the server sent, decoded as JSON. */
function decodeViewBody(body: string): GroupFormationView {
    return JSON.parse(body) as GroupFormationView;
}

describe('group formation view validation', () => {
    it('accepts a complete view for the requested group', () => {
        expect(validateGroupFormationView(createView(), groupRef)).toEqual([]);
    });

    it('reports every issue at once', () => {
        const broken = decodeViewBody(JSON.stringify({
            ...createView(),
            lifecycleState: 'establishing',
            condition: 'green',
            groupRef: { ...groupRef, groupId: 'other' }
        }));

        expect(validateGroupFormationView(broken, groupRef).map((issue) => issue.path).sort()).toEqual([
            'condition',
            'groupRef',
            'lifecycleState'
        ]);
    });

    it('reports a missing field once and refuses a non-object body', () => {
        const { readiness: _readiness, ...withoutReadiness } = createView();

        expect(validateGroupFormationView(decodeViewBody(JSON.stringify(withoutReadiness)), groupRef)).toEqual([
            { path: 'readiness', code: 'missing-field', message: 'Formation view is missing readiness' }
        ]);
        expect(validateGroupFormationView(decodeViewBody('"planned"'), groupRef)).toEqual([
            { path: '$', code: 'invalid-value', message: 'Formation view must be an object' }
        ]);
    });
});
