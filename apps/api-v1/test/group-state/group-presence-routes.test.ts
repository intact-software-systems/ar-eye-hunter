import { decodeApiMutationFailure } from '@shared/api/mutation/api-mutation-failure.ts';
import assert from 'node:assert/strict';

import type { GroupMutationReceipt } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { InactiveGroupPresenceResult } from '@shared-server/rallar-system/group-state/presence/group-presence-service.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import type { ProcessGroupAppInbox } from '../../src/group-state/group-state-route-contracts.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import { toGroupStateResponse } from '../../src/group-state/to-group-state-response.ts';

import {
    createGroupStateRouteAuthSession,
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestRuntime,
    createLiveGroupStateRouteAuthSession,
    createOwnerGroupStateRouteSnapshot,
    createRejectingGroupStateRouteTestRuntime,
    TEST_GROUP_SCOPE
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/sessions/alice-session';
const AUTHENTICATED_HEADERS = {
    authorization: 'Bearer token',
    'content-type': 'application/json'
} as const;
const PRESENCE_CONNECT_ROUTE = { path: API_BASE, method: 'PUT' } as const;
const PRESENCE_HEARTBEAT_ROUTE = { path: `${API_BASE}/heartbeat`, method: 'POST' } as const;
const PRESENCE_DISCONNECT_ROUTE = { path: `${API_BASE}/disconnect`, method: 'POST' } as const;
const EXPECTED_PRESENCE_COMMANDS = [
    {
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        topicId: AppInboxType.GROUP_PRESENCE_CONNECT,
        resourceId: 'group-route-connect-request',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-1',
            sessionId: 'alice-session',
            request: {
                generationId: 'generation-connect',
                principalId: 'alice',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: 2,
                requestId: 'group-route-connect-request'
            }
        }
    },
    {
        type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
        topicId: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
        resourceId: 'group-route-heartbeat-request',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-1',
            sessionId: 'alice-session',
            request: {
                generationId: 'generation-heartbeat',
                principalId: 'alice',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                lastHeartbeatAtEpochMs: 2,
                expiresAtEpochMs: 3,
                requestId: 'group-route-heartbeat-request'
            }
        }
    },
    {
        type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
        topicId: AppInboxType.GROUP_PRESENCE_DISCONNECT,
        resourceId: 'group-route-disconnect-request',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-1',
            sessionId: 'alice-session',
            request: {
                generationId: 'generation-disconnect',
                principalId: 'alice',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                lastHeartbeatAtEpochMs: 3,
                disconnectedAtEpochMs: 4,
                expiresAtEpochMs: 5,
                requestId: 'group-route-disconnect-request'
            }
        }
    }
] satisfies readonly AuthenticatedGroupMutationEnqueue[];

Deno.test('group presence commands retain validation and authenticated envelopes', () => {
    const authSession = createGroupStateRouteAuthSession('alice');
    const commandBase = {
        authSession,
        scope: TEST_GROUP_SCOPE,
        groupId: 'room-1',
        sessionId: 'alice-session'
    } as const;
    const forgedActor = {
        principalId: 'forged-principal',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session'
    };
    const commands = [
        toGroupStateCommand({
            operation: 'connect-group-presence',
            ...commandBase,
            request: {
                generationId: 'generation-connect',
                ...forgedActor,
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: 2,
                requestId: 'group-route-connect-request'
            }
        }),
        toGroupStateCommand({
            operation: 'heartbeat-group-presence',
            ...commandBase,
            request: {
                generationId: 'generation-heartbeat',
                ...forgedActor,
                lastHeartbeatAtEpochMs: 2,
                expiresAtEpochMs: 3,
                requestId: 'group-route-heartbeat-request'
            }
        }),
        toGroupStateCommand({
            operation: 'disconnect-group-presence',
            ...commandBase,
            request: {
                generationId: 'generation-disconnect',
                ...forgedActor,
                lastHeartbeatAtEpochMs: 3,
                disconnectedAtEpochMs: 4,
                expiresAtEpochMs: 5,
                requestId: 'group-route-disconnect-request'
            }
        })
    ];

    assert.deepEqual(commands, EXPECTED_PRESENCE_COMMANDS);
});

Deno.test('group presence response retains the current snapshot', async () => {
    const snapshot = createGroupStateRouteSnapshot('room-1');
    let currentSnapshotReads = 0;
    const service = createPresenceResponseService(snapshot, () => {
        currentSnapshotReads += 1;
    });
    const ref = { ...TEST_GROUP_SCOPE, groupId: 'room-1' };
    const accepted = await toGroupStateResponse({
        kind: 'presence',
        receipt: {
            commandId: 'presence-command',
            requestId: 'presence-request',
            commandHash: 'presence-hash',
            aggregateRef: ref,
            outcome: 'applied',
            attemptCount: 1,
            acceptedStorageRevision: 1,
            snapshotVersion: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
            eventId: null,
            outboxIds: [],
            joinCode: null,
            joinCodeExpiresAtEpochMs: null,
            rejection: null
        },
        ref,
        service
    });

    assert.strictEqual(accepted, snapshot);
    assert.deepEqual(accepted, snapshot);
    assert.equal(currentSnapshotReads, 1);
});

Deno.test('group presence response rejects before reading its current snapshot', async () => {
    const snapshot = createGroupStateRouteSnapshot('room-1');
    let currentSnapshotReads = 0;
    const service = createPresenceResponseService(snapshot, () => {
        currentSnapshotReads += 1;
    });
    const ref = { ...TEST_GROUP_SCOPE, groupId: 'room-1' };

    await assert.rejects(
        () =>
            toGroupStateResponse({
                kind: 'presence',
                receipt: {
                    commandId: 'rejected-command',
                    requestId: 'rejected-request',
                    commandHash: 'rejected-hash',
                    aggregateRef: ref,
                    outcome: 'rejected',
                    attemptCount: 1,
                    acceptedStorageRevision: null,
                    snapshotVersion: 1,
                    causalRevision: { groupRevision: 1, presenceRevision: 1 },
                    eventId: null,
                    outboxIds: [],
                    joinCode: null,
                    joinCodeExpiresAtEpochMs: null,
                    rejection: 'Presence rejected by current authority'
                },
                ref,
                service
            }),
        { message: 'Presence rejected by current authority' }
    );
    assert.equal(currentSnapshotReads, 0);
});

Deno.test(
    'group presence routes retain every AppInbox envelope and post-receipt snapshot read',
    async () => {
        const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
        let currentSnapshotReads = 0;
        const snapshot = createGroupStateRouteSnapshot('room-1');
        const runtime = createGroupStateRouteTestRuntime({
            groupService: {
                readCurrentSnapshot: () => {
                    currentSnapshotReads += 1;
                    return Promise.resolve(snapshot);
                }
            },
            processGroupAppInbox: capturePresenceReceipt(enqueued)
        });

        const responses = [
            await requestPresenceMutation(runtime.app, PRESENCE_CONNECT_ROUTE, {
                generationId: 'generation-connect',
                principalId: 'forged-principal',
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: 2,
                requestId: 'group-route-connect-request'
            }),
            await requestPresenceMutation(runtime.app, PRESENCE_HEARTBEAT_ROUTE, {
                generationId: 'generation-heartbeat',
                principalId: 'forged-principal',
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                lastHeartbeatAtEpochMs: 2,
                expiresAtEpochMs: 3,
                requestId: 'group-route-heartbeat-request'
            }),
            await requestPresenceMutation(runtime.app, PRESENCE_DISCONNECT_ROUTE, {
                generationId: 'generation-disconnect',
                principalId: 'forged-principal',
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                lastHeartbeatAtEpochMs: 3,
                disconnectedAtEpochMs: 4,
                expiresAtEpochMs: 5,
                requestId: 'group-route-disconnect-request'
            })
        ];

        for (const response of responses) {
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), snapshot);
        }
        assert.equal(currentSnapshotReads, 3);
        assert.deepEqual(enqueued, EXPECTED_PRESENCE_COMMANDS);
    }
);

Deno.test('inactive group presence returns the current snapshot as a no-op', async () => {
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const inactiveResult: InactiveGroupPresenceResult = {
        status: 'inactive',
        sessionId: 'alice-session',
        generationId: 'generation-closed'
    };
    let currentSnapshotReads = 0;
    const runtime = createGroupStateRouteTestRuntime({
        groupService: {
            readCurrentSnapshot: () => {
                currentSnapshotReads += 1;
                return Promise.resolve(snapshot);
            }
        },
        processGroupAppInbox: () => Promise.resolve(inactiveResult)
    });

    const response = await requestPresenceMutation(runtime.app, PRESENCE_CONNECT_ROUTE, {
        generationId: inactiveResult.generationId,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 2,
        requestId: 'closed-generation-request'
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    assert.equal(currentSnapshotReads, 1);
});

Deno.test('group presence route rejects a receipt before its cleanup read', async () => {
    let currentSnapshotReads = 0;
    const runtime = createGroupStateRouteTestRuntime({
        groupService: {
            readCurrentSnapshot: () => {
                currentSnapshotReads += 1;
                return Promise.resolve(createGroupStateRouteSnapshot('room-1'));
            }
        },
        processGroupAppInbox: () =>
            Promise.resolve(
                createGroupPresenceReceipt({
                    outcome: 'rejected',
                    rejection: 'Presence rejected by current authority'
                })
            )
    });

    const response = await requestPresenceMutation(runtime.app, PRESENCE_CONNECT_ROUTE, {
        generationId: 'generation-1',
        actorPrincipalId: 'forged-actor',
        actorSessionId: 'forged-session',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 2
    });

    assert.equal(response.status, 400);
    assert.deepEqual(decodeApiMutationFailure(await response.json()), {
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code: 'group-mutation-rejected',
        status: 400,
        message: 'Presence rejected by current authority',
        issues: [
            {
                code: 'group-mutation-rejected',
                path: null,
                message: 'Presence rejected by current authority',
                details: null
            }
        ],
        denial: null,
        retry: null
    });
    assert.equal(currentSnapshotReads, 0);
});

function createPresenceResponseService(
    snapshot: ReturnType<typeof createGroupStateRouteSnapshot>,
    onCurrentSnapshotRead: () => void
) {
    return {
        listSnapshots: () => Promise.resolve([]),
        readSnapshot: () => Promise.resolve(undefined),
        readCurrentSnapshot: () => {
            onCurrentSnapshotRead();
            return Promise.resolve(snapshot);
        },
        listEvents: () => Promise.resolve([]),
        listRecentEvents: () => Promise.resolve([]),
        listEventPage: () => Promise.resolve({ events: [], hasMore: false })
    };
}

function capturePresenceReceipt(
    enqueued: AuthenticatedGroupMutationEnqueue[]
): ProcessGroupAppInbox {
    return (_authority, entry) => {
        enqueued.push(entry);
        return Promise.resolve(
            createGroupPresenceReceipt({ outcome: 'applied', rejection: null })
        );
    };
}

interface CreateGroupPresenceReceiptInput {
    readonly outcome: GroupMutationReceipt['outcome'];
    readonly rejection: string | null;
}

function createGroupPresenceReceipt(
    input: CreateGroupPresenceReceiptInput
): GroupMutationReceipt {
    return {
        commandId: 'presence-command',
        requestId: 'presence-request',
        commandHash: 'presence-hash',
        aggregateRef: { ...TEST_GROUP_SCOPE, groupId: 'room-1' },
        outcome: input.outcome,
        attemptCount: 1,
        acceptedStorageRevision: input.outcome === 'rejected' ? null : 1,
        snapshotVersion: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        eventId: null,
        outboxIds: [],
        joinCode: null,
        joinCodeExpiresAtEpochMs: null,
        rejection: input.rejection
    };
}

interface PresenceMutationRoute {
    readonly path: string;
    readonly method: 'POST' | 'PUT';
}

async function requestPresenceMutation(
    app: ReturnType<typeof createGroupStateRouteTestRuntime>['app'],
    route: PresenceMutationRoute,
    body: Record<string, unknown>
): Promise<Response> {
    const { requestId: candidate, ...requestBody } = body;
    const requestId = typeof candidate === 'string' ? candidate : 'group-route-presence-default';
    return await app.request(`${route.path}/requests/${encodeURIComponent(requestId)}`, {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody)
    });
}

Deno.test('group REST presence lifecycle requires a valid generation before enqueue', async () => {
    const processCalls: AuthenticatedGroupMutationEnqueue[] = [];
    const { app, sessionPath } = createPresenceValidationRuntime(processCalls);

    await verifyMalformedPresenceRequests(app, sessionPath);
    assert.equal(processCalls.length, 0);
    await verifyValidPresenceRequests(app, sessionPath);
    assert.equal(processCalls.length, 3);
});

function createPresenceValidationRuntime(
    processCalls: AuthenticatedGroupMutationEnqueue[]
): {
    readonly app: ReturnType<typeof createRejectingGroupStateRouteTestRuntime>['app'];
    readonly sessionPath: string;
} {
    const snapshot = createOwnerGroupStateRouteSnapshot('room-1', ['alice']);
    const { app } = createRejectingGroupStateRouteTestRuntime({
        session: createLiveGroupStateRouteAuthSession('alice'),
        groupService: {
            readCurrentSnapshot: () => Promise.resolve(snapshot)
        },
        processGroupAppInbox: (_authority, enqueue) => {
            processCalls.push(enqueue);
            return Promise.resolve(
                createGroupPresenceReceipt({ outcome: 'applied', rejection: null })
            );
        }
    });
    return {
        app,
        sessionPath: API_BASE
    };
}

async function verifyMalformedPresenceRequests(
    app: ReturnType<typeof createRejectingGroupStateRouteTestRuntime>['app'],
    sessionPath: string
): Promise<void> {
    const malformed = [
        { method: 'PUT', path: sessionPath, body: {} },
        {
            method: 'POST',
            path: `${sessionPath}/heartbeat`,
            body: { generationId: { forged: true } }
        },
        {
            method: 'POST',
            path: `${sessionPath}/heartbeat`,
            body: { generationId: 'generation-1', lastHeartbeatAtEpochMs: -1 }
        },
        {
            method: 'POST',
            path: `${sessionPath}/disconnect`,
            body: {
                generationId: 'generation-1',
                lastHeartbeatAtEpochMs: 2,
                disconnectedAtEpochMs: 1
            }
        }
    ] as const;
    for (const [index, testCase] of malformed.entries()) {
        const response = await app.request(
            `${testCase.path}/requests/group-route-malformed-presence-${index}`,
            {
                method: testCase.method,
                headers: AUTHENTICATED_HEADERS,
                body: JSON.stringify(testCase.body)
            }
        );
        assert.equal(response.status, 400, testCase.path);
        assert.equal((await response.json()).type, 'api-mutation-failure');
    }
}

async function verifyValidPresenceRequests(
    app: ReturnType<typeof createRejectingGroupStateRouteTestRuntime>['app'],
    sessionPath: string
): Promise<void> {
    for (
        const testCase of [
            { method: 'PUT', path: sessionPath },
            { method: 'POST', path: `${sessionPath}/heartbeat` },
            { method: 'POST', path: `${sessionPath}/disconnect` }
        ] as const
    ) {
        const response = await app.request(
            `${testCase.path}/requests/group-route-valid-presence-${testCase.method.toLowerCase()}`,
            {
                method: testCase.method,
                headers: AUTHENTICATED_HEADERS,
                body: JSON.stringify({
                    generationId: 'generation-1',
                    lastHeartbeatAtEpochMs: 1,
                    expiresAtEpochMs: 1,
                    ...(testCase.path.endsWith('/disconnect') ? { disconnectedAtEpochMs: 1 } : {})
                })
            }
        );
        assert.equal(response.status, 200, testCase.path);
    }
}
