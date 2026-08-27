import type { EffectiveGroupTopologyConfig, GraphDiagnosticReadResponse } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import * as graphTopologyRoutes from '../../src/routes/graph-topology-routes.ts';

const TEST_SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1'
};
const TOPOLOGY_MUTATION_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology';
const TOPOLOGY_MUTATION_CASES = [
    { method: 'PUT', path: 'config', body: { config: { topologyKind: 'tree' } } },
    { method: 'DELETE', path: 'config' },
    { method: 'PUT', path: 'override', body: { config: { degreeLimit: 4 } } },
    { method: 'DELETE', path: 'override' },
    { method: 'POST', path: 'reconfigure', body: { publish: false } }
] as const;

Deno.test('topology mutations expose only path-owned request identities', async () => {
    const calls: Parameters<graphTopologyRoutes.ProcessTopologyAppInbox>[1][] = [];
    const app = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        processTopologyAppInbox: (_authority, reservation) => {
            calls.push(reservation);
            return createTopologyAppInboxResult(reservation);
        }
    });

    for (const [index, mutation] of TOPOLOGY_MUTATION_CASES.entries()) {
        const requestId = `topology-request-${String(index).padStart(4, '0')}`;
        const response = await app.request(
            `${TOPOLOGY_MUTATION_BASE}/${mutation.path}/requests/${requestId}`,
            {
                method: mutation.method,
                headers: { authorization: 'Bearer token' },
                ...('body' in mutation ? { body: JSON.stringify(mutation.body) } : {})
            }
        );
        assert.equal(response.status, 200, `${mutation.method} ${mutation.path}`);
    }

    assert.deepEqual(calls.map((call) => call.requestId), [
        'topology-request-0000',
        'topology-request-0001',
        'topology-request-0002',
        'topology-request-0003',
        'topology-request-0004'
    ]);
    assert.deepEqual(calls.map((call) => call.operation), [
        'putConfig',
        'deleteConfig',
        'putOverride',
        'deleteOverride',
        'reconfigureTopology'
    ]);
    assert.ok(
        calls.every(
            (call) => call.callerId === 'owner' && call.groupRef.groupId === 'room-1'
        )
    );
});

Deno.test('scoped graph routes pass scope and group refs to diagnostics', async () => {
    const calls: object[] = [];
    const group = createGroupSnapshot('room-1', ['owner']);
    const app = createRouteApp({
        group,
        graphDiagnostics: {
            readScopedGlobalGraphDiagnostic: (scope, options) => {
                calls.push({ kind: 'global', scope, options });
                return Either.ofRight(createGraphResponse({
                    ...scope,
                    groupId: '__global__'
                }));
            },
            readGroupGraphDiagnostic: (groupRef, options) => {
                calls.push({ kind: 'group', groupRef, options });
                return Either.ofRight(createGraphResponse(groupRef));
            }
        }
    });

    const globalResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/graphs/global' +
            '?includeMeasured=true&refresh=always'
    );
    const groupResponse = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/graphs/latest'
    );

    assert.equal(globalResponse.status, 200);
    assert.equal(groupResponse.status, 200);
    assert.deepEqual((await globalResponse.json()).groupRef, {
        ...TEST_SCOPE,
        groupId: '__global__'
    });
    assert.deepEqual((await groupResponse.json()).groupRef, {
        ...TEST_SCOPE,
        groupId: 'room-1'
    });
    assert.deepEqual(calls, [
        {
            kind: 'global',
            scope: TEST_SCOPE,
            options: { includeMeasured: true, refresh: 'always' }
        },
        {
            kind: 'group',
            groupRef: { ...TEST_SCOPE, groupId: 'room-1' },
            options: { includeMeasured: false, refresh: 'if-missing' }
        }
    ]);
});

Deno.test('strict read auth allows active members and rejects non-members', async () => {
    const intruderApp = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        session: createIssuedSession('intruder', 'intruder-session'),
        strictReadAuthorization: true
    });

    const denied = await intruderApp.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology',
        { headers: { authorization: 'Bearer token' } }
    );

    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'group-policy-denied');

    const ownerApp = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        session: createIssuedSession('owner', 'owner-session'),
        strictReadAuthorization: true
    });

    const allowed = await ownerApp.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology',
        { headers: { authorization: 'Bearer token' } }
    );

    assert.equal(allowed.status, 200);
});

Deno.test('strict graph and topology policy uses one durable current snapshot', async () => {
    let durableReads = 0;
    const app = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        session: createIssuedSession('owner', 'owner-session'),
        strictReadAuthorization: true,
        onCurrentGroupRead: () => durableReads += 1
    });

    const response = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/graphs/latest',
        { headers: { authorization: 'Bearer token' } }
    );

    assert.equal(response.status, 200);
    assert.equal(durableReads, 1);
});

Deno.test('strict read auth rejects unauthenticated scoped global graph diagnostics', async () => {
    let authCalls = 0;
    const app = createRouteApp({
        strictReadAuthorization: true,
        requireApiAuthSession: () => {
            authCalls += 1;
            throw new Error('Unauthorized: missing auth session');
        }
    });

    const denied = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/graphs/global'
    );

    assert.equal(denied.status, 401);
    assert.equal(authCalls, 1);
});

Deno.test('topology writes require group manager or platform admin auth', async () => {
    const memberApp = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner', 'member']),
        session: createIssuedSession('member', 'member-session')
    });
    const memberDenied = await memberApp.request(
        toTopologyMutationRequestPath('config', 'topology-member-denied-0001'),
        {
            method: 'PUT',
            headers: { authorization: 'Bearer token' },
            body: JSON.stringify({ config: { topologyKind: 'tree' } })
        }
    );
    assert.equal(memberDenied.status, 403);

    const ownerCalls: Parameters<graphTopologyRoutes.ProcessTopologyAppInbox>[1][] = [];
    const ownerApp = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        session: createIssuedSession('owner', 'owner-session'),
        processTopologyAppInbox: (_authority, reservation) => {
            ownerCalls.push(reservation);
            return createTopologyAppInboxResult(reservation);
        }
    });
    const ownerAllowed = await ownerApp.request(
        toTopologyMutationRequestPath('config', 'topology-owner-allowed-0001'),
        {
            method: 'PUT',
            headers: { authorization: 'Bearer token' },
            body: JSON.stringify({ config: { topologyKind: 'tree' } })
        }
    );
    assert.equal(ownerAllowed.status, 200);
    assert.equal(
        ownerCalls[0]?.callerId,
        'owner'
    );
    assert.deepEqual((await ownerCalls[0]?.materialize())?.payload, {
        operation: 'putConfig',
        config: toCanonicalGroupTopologyConfigPatch({ topologyKind: 'tree' })
    });

    const adminCalls: Parameters<graphTopologyRoutes.ProcessTopologyAppInbox>[1][] = [];
    const adminApp = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        session: createIssuedSession('platform-admin', 'admin-session'),
        adminClientIds: ['platform-admin'],
        processTopologyAppInbox: (_authority, reservation) => {
            adminCalls.push(reservation);
            return createTopologyAppInboxResult(reservation);
        }
    });
    const adminAllowed = await adminApp.request(
        toTopologyMutationRequestPath('config', 'topology-admin-allowed-0001'),
        {
            method: 'PUT',
            headers: { authorization: 'Bearer token' },
            body: JSON.stringify({ config: { topologyKind: 'mesh' } })
        }
    );
    assert.equal(adminAllowed.status, 200);
    assert.equal(
        (await adminCalls[0]?.materialize())?.actor.principalId,
        'platform-admin'
    );
    assert.equal(
        adminCalls[0]?.callerId,
        'platform-admin'
    );
});

Deno.test('all topology mutation routes submit complete AppInbox commands', async () => {
    const appInboxCommands: Array<{
        authority: Parameters<graphTopologyRoutes.ProcessTopologyAppInbox>[0];
        enqueue: Parameters<graphTopologyRoutes.ProcessTopologyAppInbox>[1];
    }> = [];
    const app = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        session: createIssuedSession('owner', 'owner-session'),
        processTopologyAppInbox: (authority, enqueue) => {
            appInboxCommands.push({ authority, enqueue });
            return createTopologyAppInboxResult(enqueue);
        }
    });

    const mutations: readonly Readonly<{
        method: 'PUT' | 'DELETE' | 'POST';
        path: 'config' | 'override' | 'reconfigure';
        requestId: string;
        body?: object;
    }>[] = [
        {
            method: 'PUT',
            path: 'config',
            requestId: 'topology-config-put-0001',
            body: { config: { topologyKind: 'tree' } }
        },
        { method: 'DELETE', path: 'config', requestId: 'topology-config-delete-0001' },
        {
            method: 'PUT',
            path: 'override',
            requestId: 'topology-override-put-0001',
            body: { config: { degreeLimit: 4 }, ttlMs: 5_000 }
        },
        { method: 'DELETE', path: 'override', requestId: 'topology-override-delete-0001' },
        {
            method: 'POST',
            path: 'reconfigure',
            requestId: 'topology-reconfigure-0001',
            body: { options: { topologyKind: 'mesh' }, publish: false }
        }
    ];

    for (const mutation of mutations) {
        const response = await app.request(
            toTopologyMutationRequestPath(mutation.path, mutation.requestId),
            {
                method: mutation.method,
                headers: { authorization: 'Bearer token' },
                ...(mutation.body === undefined ? {} : { body: JSON.stringify(mutation.body) })
            }
        );
        assert.equal(response.status, 200);
    }

    assert.deepEqual(
        appInboxCommands.map((value) => value.enqueue.operation),
        [
            'putConfig',
            'deleteConfig',
            'putOverride',
            'deleteOverride',
            'reconfigureTopology'
        ]
    );
    for (const value of appInboxCommands) {
        const command = await value.enqueue.materialize();
        assert.equal(value.authority.accessToken, 'owner-token');
        assert.equal(value.enqueue.requestId, command.requestId);
        assert.equal(value.enqueue.callerId, 'owner');
        assert.deepEqual(command.actor, {
            principalId: 'owner',
            sessionId: 'owner-session'
        });
        assert.deepEqual(command.groupRef, {
            ...TEST_SCOPE,
            groupId: 'room-1'
        });
        assert.match(command.commandHash, /^sha256:[0-9a-f]{64}$/u);
        assert.equal(command.capturedAtEpochMs, 123_456);
        assert.equal(typeof command.operation, 'string');
        assert.equal(typeof command.payload, 'object');
    }
});

Deno.test('topology AppInbox reservations preserve scoped target components', async () => {
    const contexts: Array<Readonly<{ callerId: string; groupRef: GroupRef; }>> = [];
    const refs = [
        { applicationId: 'app:a', workspaceId: 'workspace', groupId: 'room' },
        { applicationId: 'app', workspaceId: 'a:workspace', groupId: 'room' }
    ] as const;

    for (const ref of refs) {
        const app = createRouteApp({
            group: createGroupSnapshot(ref.groupId, ['owner'], ref),
            session: createIssuedSession('owner', 'owner-session'),
            processTopologyAppInbox: (_authority, reservation) => {
                contexts.push({
                    callerId: reservation.callerId,
                    groupRef: reservation.groupRef
                });
                return createTopologyAppInboxResult(reservation);
            }
        });
        const response = await app.request(
            `/api/state/apps/${encodeURIComponent(ref.applicationId)}/workspaces/${encodeURIComponent(ref.workspaceId)}/groups/${
                encodeURIComponent(ref.groupId)
            }/topology/config/requests/topology-context-request-${contexts.length}`,
            {
                method: 'PUT',
                headers: { authorization: 'Bearer token' },
                body: JSON.stringify({ config: { topologyKind: 'tree' } })
            }
        );
        assert.equal(response.status, 200);
    }

    assert.deepEqual(contexts, [
        {
            callerId: 'owner',
            groupRef: { applicationId: 'app:a', workspaceId: 'workspace', groupId: 'room' }
        },
        {
            callerId: 'owner',
            groupRef: { applicationId: 'app', workspaceId: 'a:workspace', groupId: 'room' }
        }
    ]);
    assert.notDeepEqual(contexts[0], contexts[1]);
});

Deno.test(
    'topology mutations return after commit while explicit reconfigure forwards options',
    async () => {
        const calls: Parameters<graphTopologyRoutes.ProcessTopologyAppInbox>[1][] = [];
        const app = createRouteApp({
            group: createGroupSnapshot('room-1', ['owner']),
            session: createIssuedSession('owner', 'owner-session'),
            processTopologyAppInbox: (_authority, reservation) => {
                calls.push(reservation);
                return createTopologyAppInboxResult(reservation);
            }
        });

        assert.equal(
            (await app.request(
                toTopologyMutationRequestPath('override', 'topology-override-put-0002'),
                {
                    method: 'PUT',
                    headers: { authorization: 'Bearer token' },
                    body: JSON.stringify({ config: { degreeLimit: 4 }, ttlMs: 5_000 })
                }
            )).status,
            200
        );
        assert.equal(
            (await app.request(
                toTopologyMutationRequestPath('config', 'topology-config-delete-0002'),
                {
                    method: 'DELETE',
                    headers: { authorization: 'Bearer token' }
                }
            )).status,
            200
        );
        assert.equal(
            (await app.request(
                toTopologyMutationRequestPath('override', 'topology-override-delete-0002'),
                {
                    method: 'DELETE',
                    headers: { authorization: 'Bearer token' }
                }
            )).status,
            200
        );
        const reconfigureResponse = await app.request(
            toTopologyMutationRequestPath('reconfigure', 'topology-reconfigure-0002'),
            {
                method: 'POST',
                headers: { authorization: 'Bearer token' },
                body: JSON.stringify({ options: { topologyKind: 'tree' }, publish: false })
            }
        );

        assert.equal(reconfigureResponse.status, 200);
        assert.deepEqual(
            await Promise.all(calls.map(async (call) => (await call.materialize()).payload)),
            [
                {
                    operation: 'putOverride',
                    config: toCanonicalGroupTopologyConfigPatch({ degreeLimit: 4 }),
                    ttlMs: 5_000,
                    expiresAtEpochMs: null
                },
                { operation: 'deleteConfig', target: 'config' },
                { operation: 'deleteOverride', target: 'override' },
                {
                    operation: 'reconfigureTopology',
                    requestOptions: toCanonicalGroupTopologyConfigPatch({ topologyKind: 'tree' }),
                    publish: false
                }
            ]
        );
    }
);

Deno.test('all noncanonical topology mutation paths return 404 without enqueue', async () => {
    const calls: Parameters<graphTopologyRoutes.ProcessTopologyAppInbox>[1][] = [];
    const app = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        session: createIssuedSession('owner', 'owner-session'),
        processTopologyAppInbox: (_authority, reservation) => {
            calls.push(reservation);
            return createTopologyAppInboxResult(reservation);
        }
    });

    for (
        const mutation of [
            { method: 'PUT', path: 'config', body: { config: { topologyKind: 'tree' } } },
            { method: 'DELETE', path: 'config' },
            { method: 'PUT', path: 'override', body: { config: { degreeLimit: 4 } } },
            { method: 'DELETE', path: 'override' },
            { method: 'POST', path: 'reconfigure' }
        ] as const
    ) {
        const response = await app.request(
            `/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/${mutation.path}`,
            {
                method: mutation.method,
                headers: { authorization: 'Bearer token' },
                ...('body' in mutation ? { body: JSON.stringify(mutation.body) } : {})
            }
        );
        assert.equal(response.status, 404, `${mutation.method} ${mutation.path}`);
    }
    assert.deepEqual(calls, []);
});

Deno.test('all topology mutation routes reject header and body request identities', async () => {
    const calls: Parameters<graphTopologyRoutes.ProcessTopologyAppInbox>[1][] = [];
    const app = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        session: createIssuedSession('owner', 'owner-session'),
        processTopologyAppInbox: (_authority, reservation) => {
            calls.push(reservation);
            return createTopologyAppInboxResult(reservation);
        }
    });
    const mutations = [
        {
            method: 'PUT',
            path: 'config',
            body: { requestId: 'topology-body-config-0001', config: { topologyKind: 'tree' } }
        },
        { method: 'DELETE', path: 'config', body: { requestId: 'topology-body-delete-0001' } },
        {
            method: 'PUT',
            path: 'override',
            body: { requestId: 'topology-body-override-0001', config: { degreeLimit: 4 } }
        },
        { method: 'DELETE', path: 'override', body: { requestId: 'topology-body-delete-0002' } },
        {
            method: 'POST',
            path: 'reconfigure',
            body: { requestId: 'topology-body-reconfigure-0001', publish: false }
        }
    ] as const;

    for (const [index, mutation] of mutations.entries()) {
        for (const identity of ['header', 'body'] as const) {
            const response = await app.request(
                toTopologyMutationRequestPath(
                    mutation.path,
                    `topology-strict-identity-${index}`
                ),
                {
                    method: mutation.method,
                    headers: {
                        authorization: 'Bearer token',
                        ...(identity === 'header'
                            ? { 'Idempotency-Key': 'topology-header-identity-0001' }
                            : {})
                    },
                    ...(identity === 'body'
                        ? { body: JSON.stringify(mutation.body) }
                        : mutation.method === 'DELETE'
                        ? {}
                        : { body: JSON.stringify({ ...mutation.body, requestId: undefined }) })
                }
            );
            assert.equal(
                response.status,
                400,
                `${mutation.method} ${mutation.path} ${identity}`
            );
            assert.equal((await response.json()).type, 'api-mutation-failure');
        }
    }
    assert.deepEqual(calls, []);
});

Deno.test('graph topology routes map missing groups and validation errors', async () => {
    const missingApp = createRouteApp({ group: undefined });
    const missing = await missingApp.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/missing/topology'
    );
    assert.equal(missing.status, 404);

    const invalidApp = createRouteApp({
        group: createGroupSnapshot('room-1', ['owner']),
        session: createIssuedSession('owner', 'owner-session'),
        processTopologyAppInbox: () => {
            throw Object.assign(new Error('invalid config'), {
                status: 422,
                issues: [{
                    code: 'invalid-positive-integer',
                    path: ['degreeLimit'],
                    message: 'degreeLimit must be a positive integer',
                    details: { value: 0 }
                }]
            });
        }
    });
    const invalid = await invalidApp.request(
        toTopologyMutationRequestPath('config', 'topology-invalid-config-0001'),
        {
            method: 'PUT',
            headers: { authorization: 'Bearer token' },
            body: JSON.stringify({ config: { degreeLimit: 0 } })
        }
    );

    assert.equal(invalid.status, 422);
    assert.deepEqual((await invalid.json()).issues, [{
        code: 'invalid-positive-integer',
        path: ['degreeLimit'],
        message: 'degreeLimit must be a positive integer',
        details: { value: 0 }
    }]);
});

function createRouteApp(options: {
    readonly group?: GroupSnapshot;
    readonly session?: ReturnType<typeof createIssuedSession>;
    readonly adminClientIds?: readonly string[];
    readonly requireApiAuthSession?: GraphTopologyRouteRequireApiAuthSession;
    readonly graphDiagnostics?: Partial<graphTopologyRoutes.GraphTopologyRouteDependencies['graphDiagnostics']>;
    readonly topologyQuery?: Partial<graphTopologyRoutes.GraphTopologyRouteDependencies['topologyQuery']>;
    readonly topologyPlanning?: Partial<graphTopologyRoutes.GraphTopologyRouteDependencies['topologyPlanning']>;
    readonly processTopologyAppInbox?: graphTopologyRoutes.ProcessTopologyAppInbox;
    readonly onCurrentGroupRead?: () => void;
    readonly strictReadAuthorization?: boolean;
}): Hono {
    const app = new Hono();
    graphTopologyRoutes.registerGraphTopologyRoutes(app, {
        groupStateService: {
            readCurrentSnapshot: (ref: GroupRef) => {
                options.onCurrentGroupRead?.();
                return Promise.resolve(
                    options.group &&
                        options.group.group.applicationId === ref.applicationId &&
                        options.group.group.workspaceId === ref.workspaceId &&
                        options.group.group.groupId === ref.groupId
                        ? options.group
                        : undefined
                );
            }
        },
        requireApiAuthSession: options.requireApiAuthSession ??
            (() => Promise.resolve(options.session ?? createIssuedSession('owner', 'owner-session'))),
        adminClientIds: options.adminClientIds ?? [],
        strictReadAuthorization: options.strictReadAuthorization ?? false,
        readLifecyclePolicy: () => Promise.resolve({ status: 'absent' as const }),
        graphDiagnostics: {
            readScopedGlobalGraphDiagnostic: options.graphDiagnostics?.readScopedGlobalGraphDiagnostic ??
                ((scope) => Either.ofRight(createGraphResponse({ ...scope, groupId: '__global__' }))),
            readGroupGraphDiagnostic: options.graphDiagnostics?.readGroupGraphDiagnostic ??
                ((groupRef) => Either.ofRight(createGraphResponse(groupRef)))
        },
        topologyQuery: {
            readTopologyView: options.topologyQuery?.readTopologyView ??
                ((groupRef) =>
                    Promise.resolve({
                        groupRef,
                        overlayId: 'overlay',
                        snapshot: null,
                        acceptedSnapshot: null,
                        config: createTopologyConfigView(),
                        pending: null
                    })),
            readConfig: options.topologyQuery?.readConfig ??
                (() => Promise.resolve(createTopologyConfigView())),
            readOverride: options.topologyQuery?.readOverride ??
                (() => Promise.resolve(undefined))
        },
        topologyPlanning: {
            readTopologyPlanningAuthority: options.topologyPlanning?.readTopologyPlanningAuthority ??
                ((input) =>
                    Promise.resolve({
                        group: input.knownGroup ??
                            createGroupSnapshot(input.groupRef.groupId, ['alice'], {
                                applicationId: input.groupRef.applicationId,
                                workspaceId: input.groupRef.workspaceId
                            }),
                        rttMeasurements: [],
                        nowEpochMs: 123_456
                    }))
        },
        processTopologyAppInbox: options.processTopologyAppInbox ??
            ((_authority, reservation) => createTopologyAppInboxResult(reservation)),
        now: () => 123_456
    });
    return app;
}

function createTopologyConfigView() {
    const effective: EffectiveGroupTopologyConfig = {
        topologyKind: 'auto',
        degreeLimit: 5,
        treeMinSize: 5,
        meshMinSize: 16,
        meshParamK: 2
    };
    return {
        serverDefaults: effective,
        durable: null,
        temporary: null,
        requestOptions: null,
        effective
    };
}

async function createTopologyAppInboxResult(
    reservation: Parameters<graphTopologyRoutes.ProcessTopologyAppInbox>[1]
): ReturnType<graphTopologyRoutes.ProcessTopologyAppInbox> {
    const command = await reservation.materialize();
    if (command.operation === 'reconfigureTopology') {
        return {
            status: 'queued',
            groupRef: command.groupRef,
            requestId: command.requestId,
            outboxId: `${command.requestId}:outbox`
        };
    }
    return {
        receipt: {
            commandId: command.requestId,
            requestId: command.requestId,
            commandHash: command.commandHash,
            operation: command.operation,
            outcome: 'no-op',
            attemptCount: 1,
            groupRef: command.groupRef,
            target: command.operation === 'putOverride' ||
                    command.operation === 'deleteOverride'
                ? 'override'
                : 'config',
            acceptedVersion: 1,
            acceptedStorageRevision: null,
            acceptedCreatedAtEpochMs: null,
            acceptedUpdatedAtEpochMs: null,
            acceptedExpiresAtEpochMs: null,
            acceptedConfig: null,
            acceptedCausalRevision: null,
            eventId: null,
            outboxIds: []
        }
    };
}

function createIssuedSession(clientId: string, sessionId: string) {
    return {
        clientId,
        sessionId,
        accessToken: `${clientId}-token`,
        username: clientId,
        issuedAtEpochMs: 100,
        expiresAtEpochMs: 1_000_000
    };
}

type GraphTopologyRouteRequireApiAuthSession = graphTopologyRoutes.GraphTopologyRouteDependencies['requireApiAuthSession'];

function createGraphResponse(groupRef: GroupRef): GraphDiagnosticReadResponse {
    return {
        groupRef,
        snapshot: {
            groupRef,
            predicted: {
                groupRef,
                graph: { nodes: [], edges: [] },
                groupGraph: { nodes: [], edges: [] },
                coreNodes: []
            },
            createdAtEpochMs: 1,
            version: 1
        },
        cache: {
            hit: false,
            refreshed: true
        }
    };
}

function createGroupSnapshot(
    groupId: string,
    memberPrincipalIds: readonly string[],
    scope: StateScope = TEST_SCOPE
): GroupSnapshot {
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: createTestGroup({
            ...scope,
            groupId,
            displayName: groupId,
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            activeMemberCount: memberPrincipalIds.length,
            ownerPrincipalId: 'owner',
            created: createPrincipalAuditStamp(1, 'owner'),
            updated: createPrincipalAuditStamp(1, 'owner')
        }),
        members: memberPrincipalIds.map((principalId, index) => ({
            ...scope,
            groupId,
            principalId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: createPrincipalAuditStamp(1, 'owner'),
            updated: createPrincipalAuditStamp(1, 'owner'),
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        })),
        activeSessions: memberPrincipalIds.map((principalId) => ({
            ...scope,
            groupId,
            principalId,
            sessionId: `${principalId}-session`,
            generationId: `${principalId}-generation`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: memberPrincipalIds.length,
        onlineMemberCount: memberPrincipalIds.length
    };
}

function createPrincipalAuditStamp(atEpochMs: number, principalId: string) {
    return {
        atEpochMs,
        actor: { kind: 'principal' as const, principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}

function toTopologyMutationRequestPath(path: string, requestId: string): string {
    return '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/topology/' +
        `${path}/requests/${requestId}`;
}
