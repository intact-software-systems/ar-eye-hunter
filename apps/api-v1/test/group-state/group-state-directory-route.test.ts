import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import type { GroupDirectoryPage } from '@shared/api/group-directory/group-directory-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupStateRouteAuthorization } from '../../src/group-state/group-state-route-authorization.ts';
import { registerGroupStateReadRoutes } from '../../src/group-state/register-group-state-read-routes.ts';

import {
    createDeletedGroupStateRouteSnapshot,
    createGroupStateRouteAuthSession,
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestDependencies
} from './group-state-route-test-runtime.ts';

const DIRECTORY_PATH = '/api/state/apps/app-1/workspaces/workspace-1/group-directory';

function openSnapshot(
    groupId: string,
    activePrincipalIds: readonly string[],
    onlineMemberCount = activePrincipalIds.length
): GroupSnapshot {
    const snapshot = createGroupStateRouteSnapshot(groupId, activePrincipalIds);
    return { ...snapshot, onlineMemberCount, group: { ...snapshot.group, joinMode: 'open' } };
}

function readDirectory(
    snapshots: readonly GroupSnapshot[],
    options: { readonly path?: string; readonly headers?: HeadersInit; readonly strict?: boolean; } = {}
): Promise<Response> | Response {
    const app = new Hono();
    const strict = options.strict ?? true;
    const dependencies = createGroupStateRouteTestDependencies({
        strictReadAuthorization: strict,
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
    return app.request(options.path ?? DIRECTORY_PATH, { headers: options.headers });
}

async function readPage(response: Response): Promise<GroupDirectoryPage> {
    return await response.json() as GroupDirectoryPage;
}

Deno.test('group directory lists open groups the caller is not a member of as entries', async () => {
    const response = await readDirectory([openSnapshot('bobs-arena', ['bob'])]);

    assert.equal(response.status, 200);
    const page = await readPage(response);
    assert.equal(page.nextCursor, null);
    assert.equal(page.entries.length, 1);
    assert.deepEqual(page.entries[0].groupRef, {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'bobs-arena'
    });
    assert.equal(page.entries[0].displayName, 'bobs-arena');
    assert.equal(page.entries[0].joinMode, 'open');
    assert.equal(page.entries[0].memberCount, 1);
    assert.equal(page.entries[0].isFull, false);
    assert.deepEqual(Object.keys(page.entries[0]).toSorted(), [
        'displayName',
        'groupRef',
        'isFull',
        'joinMode',
        'kind',
        'lifecycleState',
        'maxMembers',
        'memberCount',
        'onlineMemberCount'
    ]);
});

Deno.test('group directory omits groups the caller already reads in full', async () => {
    const response = await readDirectory([openSnapshot('alices-arena', ['alice'])]);

    assert.deepEqual((await readPage(response)).entries, []);
});

Deno.test('group directory omits invite-only and deleted groups', async () => {
    const deleted = createDeletedGroupStateRouteSnapshot('deleted', 'bob');
    const inviteOnly = createGroupStateRouteSnapshot('private', ['bob']);
    const response = await readDirectory([
        { ...inviteOnly, group: { ...inviteOnly.group, joinMode: 'invite-only' } },
        { ...deleted, group: { ...deleted.group, joinMode: 'open' } }
    ]);

    assert.deepEqual((await readPage(response)).entries, []);
});

Deno.test('group directory hides rooms with nobody online unless includeEmpty is set', async () => {
    const snapshots = [openSnapshot('empty', ['bob'], 0), openSnapshot('busy', ['bob'], 1)];

    const hidden = await readPage(await readDirectory(snapshots));
    const included = await readPage(await readDirectory(snapshots, { path: `${DIRECTORY_PATH}?includeEmpty=true` }));

    assert.deepEqual(hidden.entries.map((entry) => entry.groupRef.groupId), ['busy']);
    assert.deepEqual(included.entries.map((entry) => entry.groupRef.groupId), ['busy', 'empty']);
});

Deno.test('group directory filters by name and orders by online count then id', async () => {
    const snapshots = [
        { ...openSnapshot('b', ['bob'], 2), group: { ...openSnapshot('b', ['bob']).group, displayName: 'Eye Hunter B' } },
        { ...openSnapshot('a', ['bob'], 2), group: { ...openSnapshot('a', ['bob']).group, displayName: 'Eye Hunter A' } },
        { ...openSnapshot('c', ['bob'], 5), group: { ...openSnapshot('c', ['bob']).group, displayName: 'Eye Hunter C' } },
        { ...openSnapshot('x', ['bob'], 9), group: { ...openSnapshot('x', ['bob']).group, displayName: 'Other' } }
    ];

    const page = await readPage(await readDirectory(snapshots, { path: `${DIRECTORY_PATH}?q=eye%20hunter` }));

    assert.deepEqual(page.entries.map((entry) => entry.groupRef.groupId), ['c', 'a', 'b']);
});

Deno.test('group directory pages with a keyset cursor and a limit', async () => {
    const snapshots = ['a', 'b', 'c'].map((groupId) => openSnapshot(groupId, ['bob']));

    const first = await readPage(await readDirectory(snapshots, { path: `${DIRECTORY_PATH}?limit=2` }));
    const second = await readPage(
        await readDirectory(snapshots, { path: `${DIRECTORY_PATH}?limit=2&cursor=${first.nextCursor}` })
    );

    assert.deepEqual(first.entries.map((entry) => entry.groupRef.groupId), ['a', 'b']);
    assert.notEqual(first.nextCursor, null);
    assert.deepEqual(second.entries.map((entry) => entry.groupRef.groupId), ['c']);
    assert.equal(second.nextCursor, null);
});

Deno.test('group directory rejects malformed query parameters', async () => {
    for (const query of ['limit=0', 'limit=201', 'limit=x', 'kind=lobby', 'includeEmpty=1', 'cursor=!!!']) {
        const response = await readDirectory([], { path: `${DIRECTORY_PATH}?${query}` });
        const body = await response.json() as { code: string; };

        assert.equal(response.status, 400, query);
        assert.equal(body.code, 'invalid-group-directory-query', query);
    }
});

Deno.test('group directory revalidates with an ETag and answers 304 when nothing changed', async () => {
    const snapshots = [openSnapshot('bobs-arena', ['bob'])];

    const first = await readDirectory(snapshots);
    const etag = first.headers.get('etag');
    const revalidated = await readDirectory(snapshots, { headers: { 'if-none-match': etag ?? '' } });
    const changed = await readDirectory([...snapshots, openSnapshot('new', ['bob'])], {
        headers: { 'if-none-match': etag ?? '' }
    });

    assert.ok(etag);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    assert.equal(revalidated.status, 304);
    assert.equal(changed.status, 200);
});

Deno.test('group directory without strict authorization lists open groups to an unauthenticated caller', async () => {
    const response = await readDirectory([openSnapshot('bobs-arena', ['bob'])], { strict: false });

    assert.equal(response.status, 200);
    assert.equal((await readPage(response)).entries.length, 1);
});
