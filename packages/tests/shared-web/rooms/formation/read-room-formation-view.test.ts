import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';

import { resetRoomWorkflowTestRuntime, seedRoomSnapshots } from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot } from './room-formation-test-fixtures.ts';

describe('room formation view read', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('reads and validates the formation view for the bound room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        const view = {
            groupRef: planned.group,
            lifecycleState: 'planned',
            formationEpoch: 1,
            formationAttemptCount: 0,
            lastFormationOutcome: null,
            establishmentStartedAtEpochMs: null,
            readiness: { plannedEdgeCount: 1, observedEdgeCount: 0, observedRate: 0 },
            managerPrincipalIds: ['principal-1'],
            layoutStale: false,
            pending: null,
            maxFormationAttempts: 2,
            condition: 'inactive',
            remediation: 'none',
            coverageBasisLayoutIdentity: null
        };
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(createRallarFacade().rooms.formation(planned.group).readView()).resolves.toEqual(view);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/formation'
        );
    });

    it('rejects a view that names another group', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response(JSON.stringify({ groupRef: { ...planned.group, groupId: 'other' } }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                })
            )
        );

        await expect(createRallarFacade().rooms.formation(planned.group).readView()).rejects.toThrow(TypeError);
    });
});
