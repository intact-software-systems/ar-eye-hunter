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
        vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));

        await refreshStateSnapshots(scope);

        expect(clientSnapshots.findClientStateSnapshotByRef(client.principal)).toBeUndefined();
        expect(groupSnapshots.findGroupStateSnapshotByRef(group.group)).toBeUndefined();
    });

    it('hydrates only the guest room and own client on transport startup and reopen', async () => {
        const room = { ...scope, groupId: 'room-1' };
        const guest = { guestRoom: room, clientId: 'guest', sessionId: 'session', username: 'Pickle',
            accessToken: 'guest-token', expiresAtEpochMs: 99_000 };
        const group = createGroupSnapshotFixture({ ...room, sessionIds: [] });
        const client = createClientSnapshotFixture({ ...scope, principalId: guest.clientId });
        vi.stubGlobal('fetch', async (url: string) => {
            const headers = { 'cache-control': 'no-store', 'rallar-state-source': 'durable', 'rallar-state-revision': '1',
                'rallar-group-revision': String(group.causalRevision.groupRevision),
                'rallar-presence-revision': String(group.causalRevision.presenceRevision) };
            if (url.endsWith('/groups/room-1')) return Response.json(group, { headers });
            if (url.endsWith('/clients/guest')) return Response.json(client, { headers });
            return new Response('', { status: 403 });
        });
        await expect(refreshStateSnapshots(scope, {}, guest)).resolves.toEqual({ clients: [client], groups: [group] });
    });

    it.each([
        ['failed', () => new Response('unavailable', { status: 503 })],
        ['malformed', () => Response.json({ partial: true })]
    ])('does not reconcile after a %s group collection', async (_label, groupResponse) => {
        const client = createClientSnapshotFixture({ ...scope, principalId: 'alice' });
        const group = createGroupSnapshotFixture({ ...scope, groupId: 'room-1', sessionIds: [] });
        clientSnapshots.setClientStateSnapshots([client]);
        groupSnapshots.setGroupStateSnapshots([group]);
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).endsWith('/clients') ? Response.json([]) : groupResponse()));

        await expect(refreshStateSnapshots(scope)).rejects.toThrow();

        expect(clientSnapshots.findClientStateSnapshotByRef(client.principal)).toBe(client);
        expect(groupSnapshots.findGroupStateSnapshotByRef(group.group)).toBe(group);
    });
});
