import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    createCachedGroupStateService,
    type CachedGroupStateService
} from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import type { StateSyncCacheHydrationInput } from '@shared-server/rallar-system/state-sync/state-sync-cache-hydration.ts';
import type { GroupMember, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { FakeRuntimeStateRepository } from '../../../../packages/tests/shared-server/runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createGroupStateRouteAuthorization,
    isGroupStateRouteSnapshotReadable
} from '../../src/group-state/group-state-route-authorization.ts';
import { registerGroupStateReadRoutes } from '../../src/group-state/register-group-state-read-routes.ts';

import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
import {
    createDeletedGroupStateRouteSnapshot,
    createGroupStateRouteAuthSession,
    createGroupStateRouteEvent,
    createGroupStateRouteSnapshot,
    createGroupStateRouteSnapshotWithMember,
    createGroupStateRouteTestDependencies,
    createGroupStateRouteTestRuntime,
    createLiveGroupStateRouteAuthSession,
    createOwnerGroupStateRouteSnapshot,
    createRejectingGroupStateRouteTestRuntime,
    TEST_GROUP_SCOPE
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';
const GROUPS_PATH = '/api/state/apps/app-1/workspaces/workspace-1/groups';
const OTHER_WORKSPACE_SCOPE: StateScope = { ...TEST_GROUP_SCOPE, workspaceId: 'workspace-2' };

interface SeededRouteGroup {
    readonly scope: StateScope;
    readonly groupId: string;
    readonly members: readonly (readonly [string, GroupMember['status']])[];
    readonly deleted?: boolean;
}

interface CountedGroupStateService {
    readonly service: CachedGroupStateService;
    readonly calls: { listSnapshots: number; listSnapshotsForPrincipal: number; };
}

async function createSeededGroupStateService(
    groups: readonly SeededRouteGroup[]
): Promise<CountedGroupStateService> {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new GroupStateRepository(runtimeRepository, runtimeRepository.groupStateEventStore);
    for (const seeded of groups) {
        await seedRouteGroup(repository, seeded);
    }
    const durable = createGroupStateService({
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        runtimeRepository,
        groupStateEventStore: runtimeRepository.groupStateEventStore,
        serviceId: 'group-list-route-test',
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null
    });
    const service = createCachedGroupStateService({
        durable,
        cache: { findOrLoadByRef: (ref) => durable.readSnapshot(ref), observe: () => 'inserted' },
        current: durable,
        principalGroups: repository
    });
    const calls = { listSnapshots: 0, listSnapshotsForPrincipal: 0 };
    return {
        calls,
        service: {
            ...service,
            listSnapshots: (scope) => {
                calls.listSnapshots += 1;
                return service.listSnapshots(scope);
            },
            listSnapshotsForPrincipal: (scope, principalId) => {
                calls.listSnapshotsForPrincipal += 1;
                return service.listSnapshotsForPrincipal(scope, principalId);
            }
        }
    };
}

async function seedRouteGroup(repository: GroupStateRepository, seeded: SeededRouteGroup): Promise<void> {
    const activePrincipalIds = seeded.members.flatMap(([principalId, status]) => status === 'active' ? [principalId] : []);
    const ownerPrincipalId = activePrincipalIds[0];
    const snapshot = seeded.deleted
        ? createDeletedGroupStateRouteSnapshot(seeded.groupId, ownerPrincipalId)
        : createGroupStateRouteSnapshot(seeded.groupId, activePrincipalIds);
    await repository.putGroup({ ...snapshot.group, ...seeded.scope, activeMemberCount: activePrincipalIds.length });
    for (const [principalId, status] of seeded.members) {
        const [member] = createGroupStateRouteSnapshotWithMember(seeded.groupId, principalId, status).members;
        const role = principalId === ownerPrincipalId ? 'owner' : 'member';
        await repository.putMember({ ...member, ...seeded.scope, role });
    }
}

const SEEDED_WORKSPACE: readonly SeededRouteGroup[] = [
    { scope: TEST_GROUP_SCOPE, groupId: 'room', members: [['alice', 'active'], ['bob', 'active']] },
    { scope: TEST_GROUP_SCOPE, groupId: 'room-2', members: [['alice', 'active']] },
    { scope: TEST_GROUP_SCOPE, groupId: 'room-bob', members: [['bob', 'active']] },
    { scope: TEST_GROUP_SCOPE, groupId: 'room-banned', members: [['alice', 'banned'], ['bob', 'active']] },
    { scope: TEST_GROUP_SCOPE, groupId: 'room-invited', members: [['alice', 'invited'], ['bob', 'active']] },
    { scope: TEST_GROUP_SCOPE, groupId: 'room-left', members: [['alice', 'left'], ['bob', 'active']] },
    { scope: TEST_GROUP_SCOPE, groupId: 'room-deleted', members: [['alice', 'active']], deleted: true },
    { scope: OTHER_WORKSPACE_SCOPE, groupId: 'room-elsewhere', members: [['alice', 'active']] }
];

function createGroupListRouteApp(
    service: CachedGroupStateService,
    input: Readonly<{
        strictReadAuthorization: boolean;
        findStateSyncGroupSnapshot?: (ref: GroupRef) => GroupSnapshot | undefined;
        hydrated?: StateSyncCacheHydrationInput[];
    }>
): Hono {
    const app = new Hono();
    const dependencies = createGroupStateRouteTestDependencies({
        strictReadAuthorization: input.strictReadAuthorization,
        groupService: service,
        requireApiAuthSession: () => Promise.resolve(createGroupStateRouteAuthSession('alice')),
        findStateSyncGroupSnapshot: input.findStateSyncGroupSnapshot,
        hydrateStateSyncSnapshotCaches: (hydration) => {
            input.hydrated?.push(hydration);
            return Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: hydration.groups?.length ?? 0 });
        }
    });
    registerGroupStateReadRoutes(app, dependencies, createGroupStateRouteAuthorization(dependencies));
    return app;
}

Deno.test('canonical group read registrar uses resolved route dependencies', async () => {
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const app = new Hono();
    const dependencies = createGroupStateRouteTestDependencies({
        groupService: {
            listSnapshots: () => Promise.resolve([snapshot]),
            readSnapshot: () => Promise.resolve(snapshot),
            readCurrentSnapshot: () => Promise.resolve(snapshot),
            listEvents: () => Promise.resolve([]),
            listEventPage: () => Promise.resolve({ events: [], hasMore: false })
        },
        hydrateStateSyncSnapshotCaches: () => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 1 })
    });
    registerGroupStateReadRoutes(
        app,
        dependencies,
        createGroupStateRouteAuthorization(dependencies)
    );

    const response = await app.request(API_BASE);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
});

Deno.test(
    'canonical group read authorization uses its resolved strict-read configuration',
    async () => {
        const app = new Hono();
        const dependencies = createGroupStateRouteTestDependencies({
            strictReadAuthorization: true,
            groupService: {
                listSnapshots: () => Promise.resolve([]),
                readSnapshot: () => Promise.resolve(undefined),
                readCurrentSnapshot: () => Promise.resolve(createGroupStateRouteSnapshot('room-1', ['bob'])),
                listEvents: () => Promise.resolve([]),
                listEventPage: () => Promise.resolve({ events: [], hasMore: false })
            },
            requireApiAuthSession: () => Promise.resolve(createGroupStateRouteAuthSession('alice'))
        });
        registerGroupStateReadRoutes(
            app,
            dependencies,
            createGroupStateRouteAuthorization(dependencies)
        );

        const response = await app.request(API_BASE);

        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, 'group-policy-denied');
    }
);

Deno.test(
    'canonical group list reads filter snapshots with strict-read authorization',
    async () => {
        const allowedSnapshot = createGroupStateRouteSnapshot('room-1', ['alice']);
        const deniedSnapshot = createGroupStateRouteSnapshot('room-2', ['bob']);
        const app = new Hono();
        const dependencies = createGroupStateRouteTestDependencies({
            strictReadAuthorization: true,
            groupService: {
                listSnapshots: () => Promise.reject(new Error('strict group lists must not scan the workspace')),
                listSnapshotsForPrincipal: () => Promise.resolve([allowedSnapshot, deniedSnapshot]),
                readSnapshot: () => Promise.resolve(undefined),
                readCurrentSnapshot: () => Promise.resolve(undefined),
                listEvents: () => Promise.resolve([]),
                listEventPage: () => Promise.resolve({ events: [], hasMore: false })
            },
            requireApiAuthSession: () => Promise.resolve(createGroupStateRouteAuthSession('alice')),
            hydrateStateSyncSnapshotCaches: () => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 1 })
        });
        registerGroupStateReadRoutes(
            app,
            dependencies,
            createGroupStateRouteAuthorization(dependencies)
        );

        const response = await app.request(API_BASE.replace('/room-1', ''));

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), [allowedSnapshot]);
    }
);

Deno.test(
    'group point reads retain normal, missing, and non-blocking cache cleanup exits',
    async () => {
        const snapshot = createGroupStateRouteSnapshot('room-1');
        let hydrationCalls = 0;
        const warnings: Parameters<typeof console.warn>[] = [];
        const runtime = createGroupStateRouteTestRuntime({
            groupService: { readCurrentSnapshot: () => Promise.resolve(snapshot) },
            hydrateStateSyncSnapshotCaches: () => {
                hydrationCalls += 1;
                return Promise.reject(new Error('cache observation failed'));
            }
        });

        const originalWarn = console.warn;
        console.warn = (...arguments_) => warnings.push(arguments_);
        try {
            const response = await runtime.app.request(API_BASE);
            await new Promise((resolve) => setTimeout(resolve, 0));

            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), snapshot);
            assert.equal(hydrationCalls, 1);
            assert.equal(warnings.length, 1);
            assert.equal(warnings[0]?.[0], 'Failed to hydrate group state sync snapshot caches');
            assert.ok(warnings[0]?.[1] instanceof Error);
            assert.equal(warnings[0][1].message, 'cache observation failed');
        }
        finally {
            console.warn = originalWarn;
        }

        const missing = createGroupStateRouteTestRuntime({
            groupService: { readCurrentSnapshot: () => Promise.resolve(undefined) }
        });
        const missingResponse = await missing.app.request(API_BASE);

        assert.equal(missingResponse.status, 404);
        assert.deepEqual(
            await missingResponse.json(),
            { error: 'Group not found: room-1' }
        );
    }
);

Deno.test(
    'group event routes use bounded recent listing and paged listing owners',
    async () => {
        const event = createGroupStateRouteEvent('event-1');
        let listRecentEventsCalls = 0;
        let listPageCalls = 0;
        const runtime = createGroupStateRouteTestRuntime({
            groupService: {
                listRecentEvents: () => {
                    listRecentEventsCalls += 1;
                    return Promise.resolve([event]);
                },
                listEventPage: () => {
                    listPageCalls += 1;
                    return Promise.resolve({ events: [event], hasMore: false });
                }
            }
        });

        const arrayResponse = await runtime.app.request(`${API_BASE}/events?limit=1`);
        const pageResponse = await runtime.app.request(`${API_BASE}/events/page?limit=1`);

        assert.equal(arrayResponse.status, 200);
        assert.deepEqual(await arrayResponse.json(), [event]);
        assert.equal(pageResponse.status, 200);
        assert.deepEqual(await pageResponse.json(), { events: [event], hasMore: false });
        assert.equal(listRecentEventsCalls, 1);
        assert.equal(listPageCalls, 1);
    }
);

Deno.test(
    'strict state read routes allow active group members and reject non-members',
    async () => {
        const memberSnapshot = createOwnerGroupStateRouteSnapshot('room-1', ['alice']);
        const nonMemberSnapshot = createOwnerGroupStateRouteSnapshot('room-2', ['bob']);
        const { app } = createRejectingGroupStateRouteTestRuntime({
            session: createLiveGroupStateRouteAuthSession('alice'),
            strictReadAuthorization: true,
            groupService: {
                readSnapshot: (ref: { groupId: string; }) =>
                    Promise.resolve(
                        ref.groupId === 'room-1' ? memberSnapshot : nonMemberSnapshot
                    )
            }
        });

        const allowed = await app.request(
            '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
            { headers: { authorization: 'Bearer token' } }
        );
        const denied = await app.request(
            '/api/state/apps/app-1/workspaces/workspace-1/groups/room-2',
            { headers: { authorization: 'Bearer token' } }
        );

        assert.equal(allowed.status, 200);
        assert.deepEqual(await allowed.json(), memberSnapshot);
        assert.equal(denied.status, 403);
        assert.equal((await denied.json()).code, 'group-policy-denied');
    }
);

Deno.test('group snapshot reads probe durable state instead of trusting a warm cache', async () => {
    const staleSnapshot = createOwnerGroupStateRouteSnapshot('room-1', ['alice']);
    const currentSnapshot = createOwnerGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
    let cachedReadCount = 0;
    let currentReadCount = 0;
    const groupService = {
        readSnapshot: () => {
            cachedReadCount += 1;
            return Promise.resolve(staleSnapshot);
        },
        readCurrentSnapshot: () => {
            currentReadCount += 1;
            return Promise.resolve(currentSnapshot);
        }
    };
    const { app } = createRejectingGroupStateRouteTestRuntime({
        session: createLiveGroupStateRouteAuthSession('alice'),
        groupService
    });

    const response = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
        { headers: { authorization: 'Bearer token' } }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), currentSnapshot);
    assert.equal(cachedReadCount, 0);
    assert.equal(currentReadCount, 1);
});

Deno.test('strict group reads reject banned members for snapshots and events', async () => {
    const bannedSnapshot = createGroupStateRouteSnapshotWithMember(
        'room-1',
        'alice',
        'banned'
    );
    const { app } = createRejectingGroupStateRouteTestRuntime({
        session: createLiveGroupStateRouteAuthSession('alice'),
        strictReadAuthorization: true,
        groupService: {
            readSnapshot: () => Promise.resolve(bannedSnapshot),
            listEvents: () => Promise.reject(new Error('banned member read leaked')),
            listEventPage: () => Promise.reject(new Error('banned member read leaked'))
        }
    });

    const snapshotResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1',
        { headers: { authorization: 'Bearer token' } }
    );
    const eventsResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/events/page',
        { headers: { authorization: 'Bearer token' } }
    );

    assert.equal(snapshotResponse.status, 403);
    assert.equal(eventsResponse.status, 403);
    assert.equal((await snapshotResponse.json()).code, 'member-banned');
});

Deno.test('strict group reads use shared full-state visibility policy', async () => {
    const invitedSnapshot = createGroupStateRouteSnapshotWithMember(
        'room-invited',
        'alice',
        'invited'
    );
    const deletedSnapshot = createDeletedGroupStateRouteSnapshot('room-deleted', 'alice');
    const { app } = createRejectingGroupStateRouteTestRuntime({
        session: createLiveGroupStateRouteAuthSession('alice'),
        strictReadAuthorization: true,
        groupService: {
            readSnapshot: (ref: { groupId: string; }) =>
                Promise.resolve(
                    ref.groupId === 'room-deleted' ? deletedSnapshot : invitedSnapshot
                ),
            listEventPage: () =>
                Promise.resolve({
                    events: [createGroupStateRouteEvent('event-1')],
                    hasMore: false
                })
        }
    });

    const invitedSnapshotResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-invited',
        { headers: { authorization: 'Bearer token' } }
    );
    const invitedEventsResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-invited/events/page',
        { headers: { authorization: 'Bearer token' } }
    );
    const deletedSnapshotResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-deleted',
        { headers: { authorization: 'Bearer token' } }
    );

    assert.equal(invitedSnapshotResponse.status, 403);
    assert.equal(invitedEventsResponse.status, 403);
    assert.equal(deletedSnapshotResponse.status, 403);
    assert.equal((await invitedSnapshotResponse.json()).code, 'group-policy-denied');
    assert.equal((await invitedEventsResponse.json()).code, 'group-policy-denied');
    assert.equal((await deletedSnapshotResponse.json()).code, 'group-deleted');
});

Deno.test('a strict group list serves the caller\'s groups exactly as the workspace scan and readability filter', async () => {
    const seeded = await createSeededGroupStateService(SEEDED_WORKSPACE);
    const scanned = (await seeded.service.listSnapshots(TEST_GROUP_SCOPE))
        .filter((snapshot) => isGroupStateRouteSnapshotReadable(snapshot, 'alice'));
    seeded.calls.listSnapshots = 0;

    const response = await createGroupListRouteApp(seeded.service, { strictReadAuthorization: true })
        .request(GROUPS_PATH);
    const listed: GroupSnapshot[] = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(listed.map((snapshot) => snapshot.group.groupId), ['room', 'room-2']);
    assert.deepEqual(listed, JSON.parse(JSON.stringify(scanned)));
    assert.equal(seeded.calls.listSnapshots, 0);
    assert.equal(seeded.calls.listSnapshotsForPrincipal, 1);
});

Deno.test('a non-strict group list keeps the workspace scan', async () => {
    const seeded = await createSeededGroupStateService(SEEDED_WORKSPACE);

    const response = await createGroupListRouteApp(seeded.service, { strictReadAuthorization: false })
        .request(GROUPS_PATH);
    const listed: GroupSnapshot[] = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(listed.map((snapshot) => snapshot.group.groupId), [
        'room',
        'room-2',
        'room-banned',
        'room-bob',
        'room-deleted',
        'room-invited',
        'room-left'
    ]);
    assert.equal(seeded.calls.listSnapshots, 1);
    assert.equal(seeded.calls.listSnapshotsForPrincipal, 0);
});

Deno.test('a group list hydrates only snapshots the state-sync cache does not already hold', async () => {
    const held = createGroupStateRouteSnapshot('room-held', ['alice']);
    const advanced = createGroupStateRouteSnapshot('room-advanced', ['alice']);
    const incomparable = createGroupStateRouteSnapshot('room-incomparable', ['alice']);
    const conflicting = createGroupStateRouteSnapshot('room-conflicting', ['alice']);
    const heldByGroupId = new Map<string, GroupSnapshot>([
        ['room-held', structuredClone(held)],
        ['room-advanced', { ...advanced, causalRevision: { groupRevision: 0, presenceRevision: 0 } }],
        ['room-incomparable', { ...incomparable, causalRevision: { groupRevision: 0, presenceRevision: 1 } }],
        ['room-conflicting', { ...conflicting, group: { ...conflicting.group, displayName: 'held at the same revision' } }]
    ]);
    const hydrated: StateSyncCacheHydrationInput[] = [];
    const service = (await createSeededGroupStateService([])).service;
    const app = createGroupListRouteApp(
        { ...service, listSnapshots: () => Promise.resolve([held, advanced, incomparable, conflicting]) },
        { strictReadAuthorization: false, hydrated, findStateSyncGroupSnapshot: (ref) => heldByGroupId.get(ref.groupId) }
    );

    const response = await app.request(GROUPS_PATH);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).length, 4);
    assert.deepEqual(
        hydrated.map((input) => input.groups?.map((snapshot) => snapshot.group.groupId)),
        [['room-advanced', 'room-incomparable', 'room-conflicting']]
    );
});

Deno.test('a group list whose revisions are all held does not hydrate', async () => {
    const held = createGroupStateRouteSnapshot('room-held', ['alice']);
    const hydrated: StateSyncCacheHydrationInput[] = [];
    const service = (await createSeededGroupStateService([])).service;
    const app = createGroupListRouteApp(
        { ...service, listSnapshots: () => Promise.resolve([held]) },
        { strictReadAuthorization: false, hydrated, findStateSyncGroupSnapshot: () => structuredClone(held) }
    );

    const response = await app.request(GROUPS_PATH);

    assert.equal(response.status, 200);
    assert.deepEqual(hydrated, []);
});
