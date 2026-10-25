import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';

import type { GroupDirectoryPage } from '@shared/api/group-directory/group-directory-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { FakeRuntimeStateRepository } from '../../../../packages/tests/shared-server/runtime-state/test-support/fake-runtime-state-repository.ts';

import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { createGroupStateRouteAuthorization } from '../../src/group-state/group-state-route-authorization.ts';
import type { GroupStateRouteDependencies } from '../../src/group-state/group-state-route-contracts.ts';
import { registerGroupStateReadRoutes } from '../../src/group-state/register-group-state-read-routes.ts';
import { installApiHttpMiddleware } from '../../src/services/install-api-http-middleware.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';

import {
    createDeletedGroupStateRouteSnapshot,
    createGroupStateRouteAuthSession,
    createGroupStateRouteSnapshot,
    createGroupStateRouteSnapshotWithMember,
    createGroupStateRouteTestDependencies
} from './group-state-route-test-runtime.ts';

const DIRECTORY_PATH = '/api/state/apps/app-1/workspaces/workspace-1/group-directory';
const ALLOWED_ORIGIN = 'http://localhost:5176';

interface ReadDirectoryOptions {
    readonly path?: string;
    readonly headers?: HeadersInit;
    readonly strict?: boolean;
    readonly authenticated?: boolean;
    readonly principalId?: string;
    readonly groupDefaultMaxMembers?: number | null;
    readonly rtcRttRepository?: GroupStateRouteDependencies['rtcRttRepository'];
    readonly nowEpochMs?: number;
}

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
    options: ReadDirectoryOptions = {}
): Promise<Response> | Response {
    const app = new Hono();
    const configuration = decodeApiV1Configuration(validDecodeApiV1ConfigurationInput());
    installApiHttpMiddleware(app, {
        http: configuration.http,
        stateApi: configuration.stateApi,
        timing: () => {}
    });
    const strict = options.strict ?? true;
    const nowEpochMs = options.nowEpochMs;
    const dependencies = createGroupStateRouteTestDependencies({
        strictReadAuthorization: strict,
        groupService: {
            listSnapshots: (scope) =>
                Promise.resolve(snapshots.filter((snapshot) =>
                    snapshot.group.applicationId === scope?.applicationId &&
                    snapshot.group.workspaceId === scope?.workspaceId
                )),
            readSnapshot: () => Promise.resolve(undefined),
            readCurrentSnapshot: () => Promise.resolve(undefined),
            listEvents: () => Promise.resolve([]),
            listEventPage: () => Promise.resolve({ events: [], hasMore: false })
        },
        groupDefaultMaxMembers: options.groupDefaultMaxMembers ?? null,
        rtcRttRepository: options.rtcRttRepository,
        nowEpochMs: nowEpochMs === undefined ? undefined : () => nowEpochMs,
        requireApiAuthSession: () =>
            options.authenticated === false
                ? Promise.reject(authenticationRequired('Unauthorized: Missing bearer token'))
                : Promise.resolve(createGroupStateRouteAuthSession(options.principalId ?? 'alice'))
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
        'onlineMemberCount',
        'peerRttMs'
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
        { ...inviteOnly, group: { ...inviteOnly.group, joinMode: 'code' } },
        { ...deleted, group: { ...deleted.group, joinMode: 'open' } }
    ]);

    assert.deepEqual((await readPage(response)).entries, []);
});

Deno.test('group directory keeps forming rooms discoverable and searches both game names generically', async () => {
    const arena = openSnapshot('arena', ['bob']);
    const expedition = openSnapshot('expedition', ['bob']);
    const snapshots: readonly GroupSnapshot[] = [
        { ...arena, group: { ...arena.group, displayName: 'AR Eye Hunter Arena', lifecycleState: 'forming' } },
        { ...expedition, group: { ...expedition.group, displayName: 'Inventory Team Expedition' } }
    ];
    for (const [query, groupId] of [['%20AR%20EYE%20%20', 'arena'], ['INVENTORY%20TEAM', 'expedition']]) {
        const page = await readPage(await readDirectory(snapshots, { path: `${DIRECTORY_PATH}?kind=room&q=${query}` }));
        assert.deepEqual(page.entries.map((entry) => entry.groupRef.groupId), [groupId]);
    }
    const page = await readPage(await readDirectory(snapshots));
    assert.equal(page.entries[0].lifecycleState, 'forming');
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
    for (const query of ['limit=0', 'limit=201', 'limit=x', 'kind=lobby', 'includeEmpty=1', 'cursor=!!!', 'order=nearest']) {
        const response = await readDirectory([], { path: `${DIRECTORY_PATH}?${query}` });
        const body = await response.json() as { code: string; };

        assert.equal(response.status, 400, query);
        assert.equal(body.code, 'invalid-group-directory-query', query);
    }
});

Deno.test('group directory reads RTT only for the authenticated session when opted in', async () => {
    const reads: (readonly string[])[] = [];
    const rtcRttRepository: GroupStateRouteDependencies['rtcRttRepository'] = {
        listMeasurementEntriesForEndpoints: (sessionIds) => {
            reads.push(sessionIds);
            return Promise.resolve([]);
        }
    };
    const snapshots = [openSnapshot('bobs-arena', ['bob'])];
    await readDirectory(snapshots, { rtcRttRepository });
    await readDirectory(snapshots, { rtcRttRepository, strict: false, path: `${DIRECTORY_PATH}?order=peer-rtt` });
    assert.deepEqual(reads, []);

    const page = await readPage(
        await readDirectory(snapshots, {
            rtcRttRepository,
            path: `${DIRECTORY_PATH}?order=peer-rtt&sessionId=bob-session`
        })
    );
    assert.deepEqual(reads, [['alice-session']]);
    assert.equal(page.entries[0].peerRttMs, null);
});

Deno.test('group directory returns measured peer RTT and revalidates on changed or expired evidence', async () => {
    const nowEpochMs = 100_000;
    let repositoryNow = nowEpochMs;
    const runtime = new FakeRuntimeStateRepository();
    const rtcRttRepository = new RtcRttRepository(runtime, { now: () => repositoryNow });
    const snapshot = onlinePeerRoom('measured', 'bob');
    const measurement = {
        sessionIdFrom: 'alice-session',
        sessionIdTo: 'bob-session',
        rttMs: 20,
        createdAtEpochMs: nowEpochMs - 1_000,
        version: 1
    };
    assert.equal(await rtcRttRepository.putMeasurementIfNewer(measurement, nowEpochMs + 10_000), true);
    const options = { rtcRttRepository, nowEpochMs, path: `${DIRECTORY_PATH}?order=peer-rtt` };
    const first = await readDirectory([snapshot], options);
    const validator = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.equal((await readPage(first)).entries[0].peerRttMs, 20);
    assert.ok(validator);

    const unchanged = await readDirectory([snapshot], { ...options, headers: { 'if-none-match': validator } });
    assert.equal(unchanged.status, 304);
    assert.equal(await rtcRttRepository.putMeasurementIfNewer({ ...measurement, rttMs: 40, version: 2 }, nowEpochMs + 10_000), true);
    const changed = await readDirectory([snapshot], { ...options, headers: { 'if-none-match': validator } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), validator);
    assert.equal((await readPage(changed)).entries[0].peerRttMs, 40);

    const otherSession = await readDirectory([snapshot], { ...options, principalId: 'carol' });
    assert.equal((await readPage(otherSession)).entries[0].peerRttMs, null);
    const hidden = await readDirectory([{ ...snapshot, group: { ...snapshot.group, joinMode: 'invite-only' } }], options);
    assert.deepEqual((await readPage(hidden)).entries, []);

    repositoryNow += 10_000;
    const expired = await readDirectory([snapshot], { ...options, nowEpochMs: repositoryNow });
    assert.equal((await readPage(expired)).entries[0].peerRttMs, null);
});

Deno.test('group directory reports an RTT storage outage as an uncached server error', async () => {
    const response = await readDirectory([openSnapshot('bobs-arena', ['bob'])], {
        path: `${DIRECTORY_PATH}?order=peer-rtt`,
        headers: { 'if-none-match': '*' },
        rtcRttRepository: {
            listMeasurementEntriesForEndpoints: () => Promise.reject(new Error('database connection details'))
        }
    });

    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), null);
    assert.deepEqual(await response.json(), {
        error: 'Directory latency evidence is unavailable',
        code: 'directory-latency-unavailable'
    });
});
Deno.test('group directory fails closed on corrupt persisted RTT instead of reporting unknown', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const rtcRttRepository = new RtcRttRepository(runtime, { now: () => 100_000 });
    await rtcRttRepository.putMeasurementIfNewer({
        sessionIdFrom: 'alice-session',
        sessionIdTo: 'bob-session',
        rttMs: 20,
        createdAtEpochMs: 99_000,
        version: 1
    }, 110_000);
    for (const [key, entry] of runtime.data) {
        runtime.data.set(key, { ...entry, value: '{"invalid":"measurement"}' });
    }
    const response = await readDirectory([onlinePeerRoom('measured', 'bob')], {
        rtcRttRepository,
        nowEpochMs: 100_000,
        path: `${DIRECTORY_PATH}?order=peer-rtt`
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), null);
    assert.deepEqual(await response.json(), {
        error: 'Directory latency evidence is unavailable',
        code: 'rtc-topology-repository-invariant-corruption'
    });
});

function onlinePeerRoom(groupId: string, principalId: string): GroupSnapshot {
    const snapshot = openSnapshot(groupId, [principalId]);
    return {
        ...snapshot,
        activeSessions: [{
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            principalId,
            sessionId: `${principalId}-session`,
            generationId: 'generation-1',
            generationVersion: 1,
            connectionGenerationId: 'connection-1',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 99_000,
            expiresAtEpochMs: 200_000,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        }]
    };
}

Deno.test('group directory revalidates with an ETag and answers 304 when nothing changed', async () => {
    const snapshots = [openSnapshot('bobs-arena', ['bob'])];

    const first = await readDirectory(snapshots, { headers: { origin: ALLOWED_ORIGIN } });
    const etag = first.headers.get('etag');
    const revalidated = await readDirectory(snapshots, {
        headers: { origin: ALLOWED_ORIGIN, 'if-none-match': etag ?? '' }
    });
    const changed = await readDirectory([...snapshots, openSnapshot('new', ['bob'])], {
        headers: { 'if-none-match': etag ?? '' }
    });

    assert.ok(etag);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    assert.equal(revalidated.status, 304);
    assert.equal(await revalidated.text(), '');
    for (const response of [first, revalidated]) {
        assert.equal(response.headers.get('cache-control'), 'private, no-cache');
        assert.equal(response.headers.get('etag'), etag);
        assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
        assert.ok(response.headers.get('access-control-expose-headers')?.toLowerCase().split(',').includes('etag'));
        const vary = response.headers.get('vary')?.toLowerCase().split(',').map((value) => value.trim());
        assert.deepEqual(vary?.toSorted(), ['authorization', 'origin', 'x-client-id']);
    }
    assert.equal(changed.status, 200);
});

Deno.test('group directory never conditionally caches authentication or query errors', async () => {
    const snapshots = [openSnapshot('bobs-arena', ['bob'])];
    const validator = (await readDirectory(snapshots)).headers.get('etag') ?? '';
    for (
        const options of [
            { authenticated: false, expectedStatus: 401, path: DIRECTORY_PATH },
            { authenticated: true, expectedStatus: 400, path: `${DIRECTORY_PATH}?limit=0` }
        ]
    ) {
        const first = await readDirectory(snapshots, {
            ...options,
            headers: { 'if-none-match': validator }
        });
        const repeated = await readDirectory(snapshots, {
            ...options,
            headers: { 'if-none-match': first.headers.get('etag') ?? '*' }
        });
        for (const response of [first, repeated]) {
            assert.equal(response.status, options.expectedStatus);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(response.headers.get('etag'), null);
            assert.ok((await response.json()).error);
        }
    }
});

Deno.test('group directory rechecks caller visibility despite a previous callers validator', async () => {
    const snapshots = [openSnapshot('bobs-arena', ['bob'])];
    const validator = (await readDirectory(snapshots)).headers.get('etag') ?? '';
    const response = await readDirectory(snapshots, {
        principalId: 'bob',
        headers: { 'if-none-match': validator }
    });

    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get('etag'), validator);
    assert.deepEqual((await readPage(response)).entries, []);
});

Deno.test('group directory invalidates a validator when count capacity visibility or scope changes', async () => {
    const snapshot = openSnapshot('bobs-arena', ['bob']);
    const validator = (await readDirectory([snapshot])).headers.get('etag') ?? '';
    const changes: readonly GroupSnapshot[] = [
        { ...snapshot, onlineMemberCount: 2 },
        { ...snapshot, group: { ...snapshot.group, maxMembers: 1, activeMemberCount: 1 } },
        { ...snapshot, group: { ...snapshot.group, joinMode: 'code' } }
    ];
    for (const changed of changes) {
        const response = await readDirectory([changed], { headers: { 'if-none-match': validator } });
        assert.equal(response.status, 200);
        assert.notEqual(response.headers.get('etag'), validator);
        const page = await readPage(response);
        if (changed.group.joinMode === 'code') {
            assert.deepEqual(page.entries, []);
        }
        else {
            assert.equal(page.entries[0].onlineMemberCount, changed.onlineMemberCount);
            assert.equal(page.entries[0].maxMembers, changed.group.maxMembers);
            assert.equal(page.entries[0].isFull, changed.group.maxMembers === 1);
        }
    }
    for (const path of [DIRECTORY_PATH.replace('app-1', 'other-app'), DIRECTORY_PATH.replace('workspace-1', 'other-workspace')]) {
        const response = await readDirectory([snapshot], { path, headers: { 'if-none-match': validator } });
        assert.equal(response.status, 200);
        assert.deepEqual((await readPage(response)).entries, []);
    }
});

Deno.test('unlisting removes a room despite an old ETag and relisting makes it discoverable again', async () => {
    const snapshot = openSnapshot('shared-link-room', ['bob']);
    const first = await readDirectory([snapshot]);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const hidden = { ...snapshot, group: { ...snapshot.group, metadata: { rallarDirectoryListing: 'unlisted' } } };

    const response = await readDirectory([hidden], { headers: { 'if-none-match': etag } });
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get('etag'), etag);
    assert.deepEqual((await readPage(response)).entries, []);
    const hiddenEtag = response.headers.get('etag');
    assert.ok(hiddenEtag);
    const relisted = { ...snapshot, group: { ...snapshot.group, metadata: { rallarDirectoryListing: 'listed' } } };
    const restored = await readDirectory([relisted], { headers: { 'if-none-match': hiddenEtag } });
    assert.equal(restored.status, 200);
    assert.deepEqual((await readPage(restored)).entries.map((entry) => entry.groupRef.groupId), ['shared-link-room']);
});

Deno.test('unlisted and corrupt rooms expose neither directory data nor latency evidence reads', async () => {
    const snapshot = openSnapshot('hidden', ['bob']);
    let rttReads = 0;
    const snapshots = ['unlisted', 'future-mode'].map((listing) => ({
        ...snapshot,
        group: { ...snapshot.group, metadata: { rallarDirectoryListing: listing } }
    }));
    const response = await readDirectory(snapshots, {
        path: `${DIRECTORY_PATH}?includeEmpty=true&order=peer-rtt`,
        rtcRttRepository: {
            listMeasurementEntriesForEndpoints: async () => {
                rttReads += 1;
                return [];
            }
        }
    });

    assert.equal(response.status, 200);
    assert.deepEqual((await readPage(response)).entries, []);
    assert.equal(rttReads, 0);
});

Deno.test('group directory denies cross-origin access to its response and validator for an untrusted origin', async () => {
    const response = await readDirectory([], { headers: { origin: 'https://untrusted.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
});

Deno.test('group directory without strict authorization lists open groups to an unauthenticated caller', async () => {
    const response = await readDirectory([openSnapshot('bobs-arena', ['bob'])], { strict: false });

    assert.equal(response.status, 200);
    assert.equal((await readPage(response)).entries.length, 1);
});

Deno.test('group directory cursors survive group ids outside Latin-1', async () => {
    const snapshots = ['arena-\u623f\u95f4', 'arena-\u{1f3af}', 'arena-z'].map((groupId) => openSnapshot(groupId, ['bob']));

    const first = await readPage(await readDirectory(snapshots, { path: `${DIRECTORY_PATH}?limit=1` }));
    const second = await readPage(
        await readDirectory(snapshots, { path: `${DIRECTORY_PATH}?limit=2&cursor=${first.nextCursor}` })
    );

    assert.equal(first.entries.length, 1);
    assert.equal(second.entries.length, 2);
    assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.groupRef.groupId)).size, 3);
});

Deno.test('group directory applies the server default member cap when a group sets none', async () => {
    const snapshot = openSnapshot('crowded', ['bob', 'carol']);
    const crowded = { ...snapshot, group: { ...snapshot.group, maxMembers: null, activeMemberCount: 2 } };

    const page = await readPage(await readDirectory([crowded], { groupDefaultMaxMembers: 2 }));

    assert.equal(page.entries[0].maxMembers, 2);
    assert.equal(page.entries[0].isFull, true);
});

Deno.test('group directory authenticates before it validates the query', async () => {
    const response = await readDirectory([], { path: `${DIRECTORY_PATH}?limit=0`, authenticated: false });

    assert.equal(response.status, 401);
});

Deno.test('group directory lists an open group to a principal whose invitation expired', async () => {
    const invited = createGroupStateRouteSnapshotWithMember('invited-arena', 'alice', 'invited');
    const expired = {
        ...invited,
        onlineMemberCount: 1,
        group: { ...invited.group, joinMode: 'open' as const },
        members: invited.members.map((member) => ({ ...member, invitationExpiresAtEpochMs: 1 }))
    };

    const page = await readPage(await readDirectory([expired]));

    assert.deepEqual(page.entries.map((entry) => entry.groupRef.groupId), ['invited-arena']);
});

Deno.test('group directory answers 304 to weak and listed If-None-Match validators', async () => {
    const snapshots = [openSnapshot('bobs-arena', ['bob'])];
    const etag = (await readDirectory(snapshots)).headers.get('etag') ?? '';

    const weak = await readDirectory(snapshots, { headers: { 'if-none-match': `W/${etag}` } });
    const listed = await readDirectory(snapshots, { headers: { 'if-none-match': `"other", ${etag}` } });

    assert.equal(weak.status, 304);
    assert.equal(listed.status, 304);
});
