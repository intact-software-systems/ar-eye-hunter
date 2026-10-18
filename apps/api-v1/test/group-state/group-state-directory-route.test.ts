import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { SpaStatisticsSafeGroupSummary } from '@shared/api/spa-statistics-types.ts';

import { createGroupStateRouteAuthorization } from '../../src/group-state/group-state-route-authorization.ts';
import { registerGroupStateReadRoutes } from '../../src/group-state/register-group-state-read-routes.ts';

import {
    createDeletedGroupStateRouteSnapshot,
    createGroupStateRouteAuthSession,
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestDependencies
} from './group-state-route-test-runtime.ts';

const DIRECTORY_PATH = '/api/state/apps/app-1/workspaces/workspace-1/group-directory';

function openSnapshot(groupId: string, activePrincipalIds: readonly string[]): GroupSnapshot {
    const snapshot = createGroupStateRouteSnapshot(groupId, activePrincipalIds);
    return { ...snapshot, group: { ...snapshot.group, joinMode: 'open' } };
}

async function readDirectory(snapshots: readonly GroupSnapshot[]): Promise<Response> {
    const app = new Hono();
    const dependencies = createGroupStateRouteTestDependencies({
        strictReadAuthorization: true,
        groupService: {
            listSnapshots: () => Promise.resolve(snapshots),
            readSnapshot: () => Promise.resolve(undefined),
            readCurrentSnapshot: () => Promise.resolve(undefined),
            listEvents: () => Promise.resolve([]),
            listEventPage: () => Promise.resolve({ events: [], hasMore: false })
        },
        requireApiAuthSession: () => Promise.resolve(createGroupStateRouteAuthSession('alice'))
    });
    registerGroupStateReadRoutes(app, dependencies, createGroupStateRouteAuthorization(dependencies));
    return await app.request(DIRECTORY_PATH);
}

Deno.test('group directory lists open groups the caller is not a member of as safe summaries', async () => {
    const response = await readDirectory([openSnapshot('bobs-arena', ['bob'])]);

    assert.equal(response.status, 200);
    const entries = await response.json() as SpaStatisticsSafeGroupSummary[];
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].groupRef, {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'bobs-arena'
    });
    assert.equal(entries[0].displayName, 'bobs-arena');
    assert.equal(entries[0].joinMode, 'open');
    assert.equal(entries[0].memberCount, 1);
    assert.equal('members' in entries[0], false);
    assert.equal('activeSessions' in entries[0], false);
    assert.equal('metadata' in entries[0], false);
});

Deno.test('group directory omits groups the caller already reads in full', async () => {
    const response = await readDirectory([openSnapshot('alices-arena', ['alice'])]);

    assert.deepEqual(await response.json(), []);
});

Deno.test('group directory omits invite-only and deleted groups', async () => {
    const deleted = createDeletedGroupStateRouteSnapshot('deleted', 'bob');
    const inviteOnly = createGroupStateRouteSnapshot('private', ['bob']);
    const response = await readDirectory([
        { ...inviteOnly, group: { ...inviteOnly.group, joinMode: 'invite-only' } },
        { ...deleted, group: { ...deleted.group, joinMode: 'open' } }
    ]);

    assert.deepEqual(await response.json(), []);
});
