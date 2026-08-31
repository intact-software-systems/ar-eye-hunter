import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { refreshStateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import * as clientSnapshots from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupSnapshots from '@shared/repository/group-state-snapshots-repository.ts';

import { configureTestCacheRepositories } from '../configure-test-cache-repositories.ts';
import { createClientSnapshotFixture, createGroupSnapshotFixture } from './authoritative-group-fixtures.ts';

vi.mock('@shared/api/auth.ts', () => ({ readSession: () => undefined }));

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };

describe('browser complete collection refresh', () => {
    beforeEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        configureTestCacheRepositories();
    });

    afterEach(() => vi.unstubAllGlobals());

    it('reconciles omissions only after both complete collections validate', async () => {
        const client = createClientSnapshotFixture({ ...scope, principalId: 'alice' });
        const group = createGroupSnapshotFixture({ ...scope, groupId: 'room-1', sessionIds: [] });
        clientSnapshots.setClientStateSnapshots([client]);
        groupSnapshots.setGroupStateSnapshots([group]);
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));

        await refreshStateSnapshots(scope);

        expect(clientSnapshots.findClientStateSnapshotByRef(client.principal)).toBeUndefined();
        expect(groupSnapshots.findGroupStateSnapshotByRef(group.group)).toBeUndefined();
    });

    it.each([
        ['failed', () => new Response('unavailable', { status: 503 })],
        ['malformed', () => jsonResponse({ partial: true })]
    ])('does not reconcile after a %s group collection', async (_label, groupResponse) => {
        const client = createClientSnapshotFixture({ ...scope, principalId: 'alice' });
        const group = createGroupSnapshotFixture({ ...scope, groupId: 'room-1', sessionIds: [] });
        clientSnapshots.setClientStateSnapshots([client]);
        groupSnapshots.setGroupStateSnapshots([group]);
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).endsWith('/clients') ? jsonResponse([]) : groupResponse()));

        await expect(refreshStateSnapshots(scope)).rejects.toThrow();

        expect(clientSnapshots.findClientStateSnapshotByRef(client.principal)).toBe(client);
        expect(groupSnapshots.findGroupStateSnapshotByRef(group.group)).toBe(group);
    });
});

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}
