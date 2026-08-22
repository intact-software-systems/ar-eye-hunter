import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import type { GroupCreateAppInboxPayload, GroupUpdateAppInboxPayload } from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { decodeApiMutationFailure, type ApiMutationFailureJsonObject } from '@shared/api/mutation/api-mutation-failure.ts';
import { Either } from '@shared/resilience/Either.ts';
import assert from 'node:assert/strict';

import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';

import { readGroupStateRouteRequest } from '../../src/group-state/read-group-state-route-request.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';
import { toGroupStateResponse } from '../../src/group-state/to-group-state-response.ts';
import {
    captureGroupStateRouteWrite,
    createGroupStateRouteAuthSession,
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestRuntime,
    createPredecessorGroupStateRouteAuthSession,
    createPredecessorGroupStateRouteSnapshot,
    createPredecessorGroupStateRouteTestRuntime,
    postGroupStateMutation,
    putGroupStateMutation,
    TEST_GROUP_SCOPE,
    toGroupStateWritten
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups';
const GROUP_ROUTE = `${API_BASE}/room-1`;
const MALFORMED_NON_PRESENCE_ROUTE_CASES = [
    { method: 'POST', path: API_BASE, body: { displayName: 7, kind: 'room', groupId: 'room-2' } },
    { method: 'PUT', path: GROUP_ROUTE, body: { status: 'unknown' } },
    { method: 'POST', path: `${GROUP_ROUTE}/director/appoint`, body: { heartbeatTtlMs: 0 } },
    { method: 'POST', path: `${GROUP_ROUTE}/join`, body: { inviteToken: 7 } },
    { method: 'POST', path: `${GROUP_ROUTE}/invites/accept`, body: { reason: 7 } },
    {
        method: 'POST',
        path: `${GROUP_ROUTE}/join-code/rotate`,
        body: { joinCode: '', expiresAtEpochMs: 0 }
    },
    {
        method: 'POST',
        path: `${GROUP_ROUTE}/invites/bob`,
        body: { invitationExpiresAtEpochMs: -1 }
    },
    { method: 'POST', path: `${GROUP_ROUTE}/invites/bob/revoke`, body: { traceId: 7 } },
    { method: 'POST', path: `${GROUP_ROUTE}/members/bob/remove`, body: { reason: {} } },
    { method: 'POST', path: `${GROUP_ROUTE}/members/bob/ban`, body: { requestId: {} } },
    { method: 'POST', path: `${GROUP_ROUTE}/members/bob/unban`, body: { traceId: [] } },
    { method: 'PUT', path: `${GROUP_ROUTE}/members/bob/role`, body: { role: 'superuser' } },
    { method: 'POST', path: `${GROUP_ROUTE}/owner/transfer`, body: { newOwnerPrincipalId: '' } },
    {
        method: 'PUT',
        path: `${GROUP_ROUTE}/members/alice`,
        body: { status: 'active', invitationExpiresAtEpochMs: -1 }
    }
] as const;
const EXPECTED_CREATE_COMMAND = {
    type: AppInboxType.GROUP_CREATE,
    topicId: AppInboxType.GROUP_CREATE,
    resourceId: 'group-route-create-body',
    contextId: 'application=app-1:workspace=workspace-1:group=room%2F1:caller=alice',
    senderId: 'alice',
    data: {
        scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
        request: {
            groupId: 'room/1',
            displayName: 'Room',
            kind: 'room',
            createdByPrincipalId: 'alice',
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'group-route-create-body'
        }
    }
} satisfies AuthenticatedGroupMutationEnqueue;
const EXPECTED_AGGREGATE_COMMANDS = [
    {
        type: AppInboxType.GROUP_UPDATE,
        topicId: AppInboxType.GROUP_UPDATE,
        resourceId: 'group-route-update-body',
        contextId: 'application=app-1:workspace=workspace-1:group=room-2:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-2',
            request: {
                displayName: 'Renamed',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                requestId: 'group-route-update-body'
            }
        }
    },
    {
        type: AppInboxType.GROUP_DIRECTOR_APPOINT,
        topicId: AppInboxType.GROUP_DIRECTOR_APPOINT,
        resourceId: 'group-route-appoint-body',
        contextId: 'application=app-1:workspace=workspace-1:group=room-3:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-3',
            request: {
                heartbeatTtlMs: 20,
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                requestId: 'group-route-appoint-body'
            }
        }
    }
] satisfies readonly AuthenticatedGroupMutationEnqueue[];

Deno.test('canonical group request reader accepts only the path request ID', async () => {
    const request = await readGroupStateRouteRequest<{ requestId?: string; name: string; }>({
        req: {
            json: () => Promise.resolve({ name: 'Room' }),
            header: () => undefined,
            param: (name) => name === 'requestId' ? 'group-request-000001' : undefined
        }
    });
    assert.deepEqual(request, { requestId: 'group-request-000001', name: 'Room' });
});
Deno.test('canonical group request reader rejects header and body identities', async () => {
    const identities: readonly Readonly<{
        body: ApiMutationFailureJsonObject;
        header: string | undefined;
    }>[] = [
        {
            body: { name: 'Room', requestId: 'body-request-000001' },
            header: undefined
        },
        { body: { name: 'Room' }, header: 'header-request-0001' }
    ];
    for (const identity of identities) {
        await assert.rejects(
            () =>
                readGroupStateRouteRequest<{ requestId?: string; name: string; }>({
                    req: {
                        json: () => Promise.resolve(identity.body),
                        header: () => identity.header,
                        param: (name) => name === 'requestId' ? 'group-request-000001' : undefined
                    }
                }),
            TypeError,
            'API mutation requestId must be supplied only by the request path'
        );
    }
});
Deno.test('group create command retains its authenticated AppInbox envelope', () => {
    const command = toGroupStateCommand({
        operation: 'create-group',
        authSession: createGroupStateRouteAuthSession('alice'),
        scope: TEST_GROUP_SCOPE,
        request: {
            groupId: 'room/1',
            displayName: 'Room',
            kind: 'room',
            createdByPrincipalId: 'forged-creator',
            actorPrincipalId: 'forged-actor',
            actorSessionId: 'forged-session',
            requestId: 'group-route-create-body'
        }
    });
    assert.deepEqual(command, EXPECTED_CREATE_COMMAND);
});
Deno.test('group command output keeps create payloads isolated from updates', () => {
    const command = toGroupStateCommand({
        operation: 'create-group',
        authSession: createGroupStateRouteAuthSession('alice'),
        scope: TEST_GROUP_SCOPE,
        request: {
            groupId: 'room-1',
            displayName: 'Room',
            kind: 'room',
            createdByPrincipalId: 'forged-creator',
            requestId: 'create-request'
        }
    });
    assert.equal(command.type, AppInboxType.GROUP_CREATE);
    if (command.type === AppInboxType.GROUP_CREATE) {
        const payload: GroupCreateAppInboxPayload = command.data;
        assert.equal(payload.request.groupId, 'room-1');
        // @ts-expect-error A create enqueue is not a group-update payload.
        const invalidPayload: GroupUpdateAppInboxPayload = command.data;
        void invalidPayload;
    }
});
Deno.test('group aggregate commands retain update and director envelopes', () => {
    const authSession = createGroupStateRouteAuthSession('alice');
    const commands = [
        toGroupStateCommand({
            operation: 'update-group',
            authSession,
            scope: TEST_GROUP_SCOPE,
            groupId: 'room-2',
            request: {
                displayName: 'Renamed',
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                requestId: 'group-route-update-body'
            }
        }),
        toGroupStateCommand({
            operation: 'appoint-group-director',
            authSession,
            scope: TEST_GROUP_SCOPE,
            groupId: 'room-3',
            request: {
                heartbeatTtlMs: 20,
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                requestId: 'group-route-appoint-body'
            }
        })
    ];
    assert.deepEqual(commands, EXPECTED_AGGREGATE_COMMANDS);
});
Deno.test('group AppInbox keys isolate operation, caller, and complete GroupRef', () => {
    const requestId = 'group-route-isolation-request';
    const alice = createGroupStateRouteAuthSession('alice');
    const renewedAlice = { ...alice, sessionId: 'alice-renewed-session' };
    const toUpdate = (
        authSession: typeof alice,
        scope = TEST_GROUP_SCOPE,
        groupId = 'room-1'
    ) => toGroupStateCommand({
        operation: 'update-group',
        authSession,
        scope,
        groupId,
        request: { displayName: 'Same intent', requestId }
    });
    const original = toUpdate(alice);
    const renewed = toUpdate(renewedAlice);
    const variants = [
        original,
        toUpdate(createGroupStateRouteAuthSession('bob')),
        toUpdate(alice, { ...TEST_GROUP_SCOPE, applicationId: 'app-2' }),
        toUpdate(alice, { ...TEST_GROUP_SCOPE, workspaceId: 'workspace-2' }),
        toUpdate(alice, TEST_GROUP_SCOPE, 'room-2'),
        toGroupStateCommand({
            operation: 'appoint-group-director',
            authSession: alice,
            scope: TEST_GROUP_SCOPE,
            groupId: 'room-1',
            request: { requestId }
        })
    ];

    assert.equal(renewed.contextId, original.contextId);
    assert.notEqual(renewed.data.request.actorSessionId, original.data.request.actorSessionId);
    assert.deepEqual(variants.map((command) => command.resourceId), Array(6).fill(requestId));
    assert.equal(
        new Set(variants.map((command) => `${command.topicId}:${command.contextId}`)).size,
        variants.length
    );
});
Deno.test('group mutation response retains snapshot identity and durable error text', () => {
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const response = toGroupStateResponse({
        kind: 'mutation',
        written: toGroupStateWritten(snapshot)
    });
    assert.strictEqual(response.snapshot, snapshot);
    assert.throws(
        () =>
            toGroupStateResponse({
                kind: 'mutation',
                written: { status: 'error', result: Either.ofLeft('Mutation result rejected') }
            }),
        { message: 'Mutation result rejected' }
    );
});
Deno.test('group aggregate routes retain their AppInbox envelopes', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const runtime = createGroupStateRouteTestRuntime({
        groupService: { readSnapshot: () => Promise.resolve(snapshot) },
        processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot)
    });
    const responses = [
        await postGroupStateMutation(runtime.app, API_BASE, {
            groupId: 'room/1',
            displayName: 'Room',
            kind: 'room',
            createdByPrincipalId: 'forged-creator',
            actorPrincipalId: 'forged-actor',
            actorSessionId: 'forged-session',
            requestId: 'group-route-create-body'
        }),
        await putGroupStateMutation(runtime.app, `${API_BASE}/room-2`, {
            displayName: 'Renamed',
            actorPrincipalId: 'forged-actor',
            actorSessionId: 'forged-session',
            requestId: 'group-route-update-body'
        }),
        await postGroupStateMutation(runtime.app, `${API_BASE}/room-3/director/appoint`, {
            heartbeatTtlMs: 20,
            actorPrincipalId: 'forged-actor',
            actorSessionId: 'forged-session',
            requestId: 'group-route-appoint-body'
        })
    ];
    assert.equal(responses[0].status, 201);
    assert.equal(responses[1].status, 200);
    assert.equal(responses[2].status, 200);
    assert.deepEqual(enqueued, [EXPECTED_CREATE_COMMAND, ...EXPECTED_AGGREGATE_COMMANDS]);
});
Deno.test(
    'group aggregate routes reject legacy identities and expose only the strict path',
    async () => {
        const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
        const snapshot = createGroupStateRouteSnapshot('room-1');
        const runtime = createGroupStateRouteTestRuntime({
            processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot)
        });
        const strictPath = `${API_BASE}/requests/group-route-strict-request`;
        const bodyIdentity = await runtime.app.request(strictPath, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                groupId: 'body-id-group',
                displayName: 'Body',
                kind: 'room',
                requestId: 'body-request-000001'
            })
        });
        const headerIdentity = await runtime.app.request(strictPath, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'Idempotency-Key': 'header-request-0001'
            },
            body: JSON.stringify({ groupId: 'header-id-group', displayName: 'Header', kind: 'room' })
        });
        const oldRoute = await runtime.app.request(API_BASE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ groupId: 'old-id-group', displayName: 'Old', kind: 'room' })
        });
        const valid = await postGroupStateMutation(runtime.app, API_BASE, {
            groupId: 'strict-id-group',
            displayName: 'Strict',
            kind: 'room',
            requestId: 'group-route-strict-request'
        });

        assert.equal(bodyIdentity.status, 400);
        assert.equal(headerIdentity.status, 400);
        assert.equal(oldRoute.status, 404);
        assert.equal(valid.status, 201);
        for (const response of [bodyIdentity, headerIdentity]) {
            assert.ok(decodeApiMutationFailure(await response.json()));
        }
        assert.deepEqual(enqueued.map((entry) => entry.resourceId), [
            'group-route-strict-request'
        ]);
    }
);
Deno.test(
    'group aggregate route waits for AppInbox completion before its normal response',
    async () => {
        let resolveCompletion: (() => void) | undefined;
        let enqueued = 0;
        const snapshot = createGroupStateRouteSnapshot('room-1');
        const runtime = createGroupStateRouteTestRuntime({
            processGroupAppInbox: (_authority, _entry) =>
                new Promise((resolve) => {
                    enqueued += 1;
                    resolveCompletion = () => resolve(toGroupStateWritten(snapshot));
                })
        });
        const responsePromise = postGroupStateMutation(runtime.app, API_BASE, {
            groupId: 'room-1',
            displayName: 'Room',
            kind: 'room',
            requestId: 'group-route-await-completion'
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(enqueued, 1);
        assert.ok(resolveCompletion);
        resolveCompletion();
        const response = await responsePromise;
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), snapshot);
    }
);
Deno.test(
    'group aggregate route stops at route authentication failure before AppInbox',
    async () => {
        let enqueued = 0;
        const runtime = createGroupStateRouteTestRuntime({
            installStateAuthentication: false,
            requireApiAuthSession: () => Promise.reject(authenticationRequired('Unauthorized: route authentication failed')),
            processGroupAppInbox: () => {
                enqueued += 1;
                return Promise.reject(new Error('Unexpected AppInbox call after authentication failure'));
            }
        });
        const response = await postGroupStateMutation(runtime.app, API_BASE, {
            groupId: 'room-1',
            displayName: 'Room',
            kind: 'room'
        });
        assert.equal(response.status, 401);
        assert.deepEqual(decodeApiMutationFailure(await response.json()), {
            type: 'api-mutation-failure',
            version: 'canonical.v1',
            code: 'authentication-required',
            status: 401,
            message: 'Unauthorized: route authentication failed',
            issues: null,
            denial: {
                code: 'authentication-required',
                message: 'Unauthorized: route authentication failed',
                details: null
            },
            retry: null
        });
        assert.equal(enqueued, 0);
    }
);
Deno.test(
    'group aggregate route serializes AppInbox failure after the awaited completion',
    async () => {
        const failure = Object.assign(new Error('group command rejected'), {
            code: 'group-command-rejected',
            status: 409,
            details: { groupId: 'room-1' }
        });
        const runtime = createGroupStateRouteTestRuntime({
            processGroupAppInbox: () => Promise.reject(failure)
        });
        const response = await postGroupStateMutation(runtime.app, API_BASE, {
            groupId: 'room-1',
            displayName: 'Room',
            kind: 'room'
        });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
            type: 'api-mutation-failure',
            version: 'canonical.v1',
            code: 'group-command-rejected',
            status: 409,
            message: 'group command rejected',
            issues: null,
            denial: null,
            retry: null
        });
    }
);
Deno.test(
    'all non-presence group REST mutations reject malformed bodies before inbox ' +
        'enqueue',
    async () => {
        const processCalls: AuthenticatedGroupMutationEnqueue[] = [];
        const snapshot = createPredecessorGroupStateRouteSnapshot('room-1', ['alice']);
        const ownerSnapshot = {
            ...snapshot,
            members: snapshot.members.map((member) => ({ ...member, role: 'owner' as const }))
        };
        const { app } = createPredecessorGroupStateRouteTestRuntime({
            session: createPredecessorGroupStateRouteAuthSession('alice'),
            groupService: {
                readSnapshot: () => Promise.resolve(ownerSnapshot)
            },
            processGroupAppInbox: (_authority, input) => {
                processCalls.push(input);
                return Promise.reject(new Error('Malformed request reached group inbox'));
            }
        });
        for (const [index, testCase] of MALFORMED_NON_PRESENCE_ROUTE_CASES.entries()) {
            const response = await app.request(
                `${testCase.path}/requests/group-route-malformed-${index}`,
                {
                    method: testCase.method,
                    headers: {
                        authorization: 'Bearer token',
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify(testCase.body)
                }
            );
            assert.equal(response.status, 400, `${testCase.method} ${testCase.path}`);
            assert.ok(decodeApiMutationFailure(await response.json()));
        }
        assert.equal(processCalls.length, 0);
    }
);
