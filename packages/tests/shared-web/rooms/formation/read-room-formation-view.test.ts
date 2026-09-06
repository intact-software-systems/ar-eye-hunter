import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';

import { resetRoomWorkflowTestRuntime, seedRoomSnapshots } from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot, createFormationView } from './room-formation-test-fixtures.ts';

function stubView(view: GroupFormationView) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('room formation view read', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('reads and decodes the formation view for the bound room', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        const view = createFormationView(planned.group);
        const fetchMock = stubView(view);

        await expect(createRallarFacade().rooms.formation(planned.group).readView()).resolves.toEqual(view);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            'https://api.example.test/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/formation'
        );
    });

    it('rejects a complete view that names another group', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        stubView(createFormationView({ ...planned.group, groupId: 'other' }));

        await expect(createRallarFacade().rooms.formation(planned.group).readView()).rejects.toThrow(
            'Formation view for room-1 is invalid: groupRef: Formation view names a different group'
        );
    });
});
