import assert from 'node:assert/strict';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import type { GroupStateRouteAuthSession } from '../../src/group-state/group-state-route-contracts.ts';
import { toGroupStateCommand } from '../../src/group-state/to-group-state-command.ts';

import {
    captureGroupStateRouteWrite,
    createGroupStateRouteAuthSession,
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestRuntime,
    createLiveGroupStateRouteAuthSession,
    createOwnerGroupStateRouteSnapshot,
    createRejectingGroupStateRouteTestRuntime,
    postGroupStateMutation,
    postGroupStateMutationWithHeaders,
    putGroupStateMutation,
    TEST_GROUP_SCOPE,
    toGroupStateWritten
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';
const AUTHENTICATED_HEADERS = { authorization: 'Bearer token' } as const;
const EXPECTED_MEMBERSHIP_COMMANDS = [
    {
        type: AppInboxType.GROUP_MEMBER_REMOVE,
        topicId: AppInboxType.GROUP_MEMBER_REMOVE,
        resourceId: 'group-route-remove-request',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-1',
            principalId: 'bob',
            request: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                requestId: 'group-route-remove-request'
            }
        }
    },
    {
        type: AppInboxType.GROUP_MEMBER_BAN,
        topicId: AppInboxType.GROUP_MEMBER_BAN,
        resourceId: 'group-route-ban-request',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-1',
            principalId: 'bob',
            request: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                requestId: 'group-route-ban-request'
            }
        }
    },
    {
        type: AppInboxType.GROUP_MEMBER_UNBAN,
        topicId: AppInboxType.GROUP_MEMBER_UNBAN,
        resourceId: 'group-route-unban-request',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-1',
            principalId: 'bob',
            request: {
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                requestId: 'group-route-unban-request'
            }
        }
    },
    {
        type: AppInboxType.GROUP_MEMBER_ROLE_SET,
        topicId: AppInboxType.GROUP_MEMBER_ROLE_SET,
        resourceId: 'group-route-role-request',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-1',
            principalId: 'bob',
            request: {
                role: 'admin',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                requestId: 'group-route-role-request'
            }
        }
    },
    {
        type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
        topicId: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
        resourceId: 'group-route-transfer-request',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-1',
            request: {
                newOwnerPrincipalId: 'bob',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                requestId: 'group-route-transfer-request'
            }
        }
    },
    {
        type: AppInboxType.GROUP_MEMBER_UPSERT,
        topicId: AppInboxType.GROUP_MEMBER_UPSERT,
        resourceId: 'group-route-upsert-request',
        contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
        senderId: 'alice',
        data: {
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            groupId: 'room-1',
            principalId: 'alice',
            request: {
                status: 'active',
                actorPrincipalId: 'alice',
                actorSessionId: 'alice-session',
                requestId: 'group-route-upsert-request'
            }
        }
    }
] satisfies readonly AuthenticatedGroupMutationEnqueue[];

Deno.test('group membership commands retain governance and self-service envelopes', () => {
    const authSession = createGroupStateRouteAuthSession('alice');
    const commandBase = { authSession, scope: TEST_GROUP_SCOPE, groupId: 'room-1' } as const;
    const forgedActor = { actorPrincipalId: 'forged-actor', actorSessionId: 'forged-session' };
    const commands = [
        ...createMemberRestrictionCommands(authSession),
        toGroupStateCommand({
            operation: 'set-group-member-role',
            ...commandBase,
            principalId: 'bob',
            request: {
                role: 'admin',
                ...forgedActor,
                requestId: 'group-route-role-request'
            }
        }),
        toGroupStateCommand({
            operation: 'transfer-group-ownership',
            ...commandBase,
            request: {
                newOwnerPrincipalId: 'bob',
                ...forgedActor,
                requestId: 'group-route-transfer-request'
            }
        }),
        toGroupStateCommand({
            operation: 'upsert-group-member',
            ...commandBase,
            principalId: 'alice',
            request: {
                status: 'active',
                role: 'admin',
                ...forgedActor,
                requestId: 'group-route-upsert-request'
            }
        })
    ];

    assert.deepEqual(commands, EXPECTED_MEMBERSHIP_COMMANDS);
});

Deno.test(
    'group membership routes retain every AppInbox envelope and self-service omission',
    async () => {
        const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
        const snapshot = createGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
        const runtime = createGroupStateRouteTestRuntime({
            processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot)
        });

        const responses = [
            await postGroupStateMutation(runtime.app, `${API_BASE}/members/bob/remove`, {
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                requestId: 'group-route-remove-request'
            }),
            await postGroupStateMutation(runtime.app, `${API_BASE}/members/bob/ban`, {
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                requestId: 'group-route-ban-request'
            }),
            await postGroupStateMutation(runtime.app, `${API_BASE}/members/bob/unban`, {
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                requestId: 'group-route-unban-request'
            }),
            await putGroupStateMutation(runtime.app, `${API_BASE}/members/bob/role`, {
                role: 'admin',
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                requestId: 'group-route-role-request'
            }),
            await postGroupStateMutation(runtime.app, `${API_BASE}/owner/transfer`, {
                newOwnerPrincipalId: 'bob',
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                requestId: 'group-route-transfer-request'
            }),
            await putGroupStateMutation(runtime.app, `${API_BASE}/members/alice`, {
                status: 'active',
                role: 'admin',
                actorPrincipalId: 'forged-actor',
                actorSessionId: 'forged-session',
                requestId: 'group-route-upsert-request'
            })
        ];

        for (const response of responses) {
            assert.equal(response.status, 200);
        }
        assert.deepEqual(enqueued, EXPECTED_MEMBERSHIP_COMMANDS);
    }
);

Deno.test(
    'group governance routes enqueue safe workflows with authenticated actors',
    verifyGroupGovernanceRoutes
);

async function verifyGroupGovernanceRoutes(): Promise<void> {
    const snapshot = createOwnerGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const { app } = createRejectingGroupStateRouteTestRuntime({
        session: createLiveGroupStateRouteAuthSession('alice'),
        groupService: {},
        processGroupAppInbox: (_authority, input) => {
            enqueued.push(input);
            return Promise.resolve(toGroupStateWritten(snapshot));
        }
    });
    const responses = await requestGovernanceRoutes(app);

    for (const response of responses) {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), snapshot);
    }
    assertMemberRestrictionEnvelopes(enqueued.slice(0, 3));
    assertRoleAndOwnershipEnvelopes(enqueued.slice(3));
}

async function requestGovernanceRoutes(
    app: ReturnType<typeof createRejectingGroupStateRouteTestRuntime>['app']
): Promise<Response[]> {
    return await Promise.all([
        postGroupStateMutationWithHeaders(app, `${API_BASE}/members/bob/remove`, {
            headers: AUTHENTICATED_HEADERS,
            body: { requestId: 'group-route-remove-bob' }
        }),
        postGroupStateMutationWithHeaders(app, `${API_BASE}/members/bob/ban`, {
            headers: AUTHENTICATED_HEADERS,
            body: { requestId: 'group-route-ban-bob-1' }
        }),
        postGroupStateMutationWithHeaders(app, `${API_BASE}/members/bob/unban`, {
            headers: AUTHENTICATED_HEADERS,
            body: { requestId: 'group-route-unban-bob' }
        }),
        putGroupStateMutation(app, `${API_BASE}/members/bob/role`, {
            role: 'admin',
            requestId: 'group-route-role-bob'
        }),
        postGroupStateMutationWithHeaders(app, `${API_BASE}/owner/transfer`, {
            headers: AUTHENTICATED_HEADERS,
            body: { newOwnerPrincipalId: 'bob', requestId: 'group-route-transfer-owner' }
        })
    ]);
}

function assertMemberRestrictionEnvelopes(enqueued: AuthenticatedGroupMutationEnqueue[]): void {
    assert.deepEqual(enqueued, [
        {
            type: AppInboxType.GROUP_MEMBER_REMOVE,
            topicId: AppInboxType.GROUP_MEMBER_REMOVE,
            resourceId: 'group-route-remove-bob',
            contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
            senderId: 'alice',
            data: {
                scope: TEST_GROUP_SCOPE,
                groupId: 'room-1',
                principalId: 'bob',
                request: {
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'group-route-remove-bob'
                }
            }
        },
        {
            type: AppInboxType.GROUP_MEMBER_BAN,
            topicId: AppInboxType.GROUP_MEMBER_BAN,
            resourceId: 'group-route-ban-bob-1',
            contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
            senderId: 'alice',
            data: {
                scope: TEST_GROUP_SCOPE,
                groupId: 'room-1',
                principalId: 'bob',
                request: {
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'group-route-ban-bob-1'
                }
            }
        },
        {
            type: AppInboxType.GROUP_MEMBER_UNBAN,
            topicId: AppInboxType.GROUP_MEMBER_UNBAN,
            resourceId: 'group-route-unban-bob',
            contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
            senderId: 'alice',
            data: {
                scope: TEST_GROUP_SCOPE,
                groupId: 'room-1',
                principalId: 'bob',
                request: {
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'group-route-unban-bob'
                }
            }
        }
    ]);
}

function assertRoleAndOwnershipEnvelopes(enqueued: AuthenticatedGroupMutationEnqueue[]): void {
    assert.deepEqual(enqueued, [
        {
            type: AppInboxType.GROUP_MEMBER_ROLE_SET,
            topicId: AppInboxType.GROUP_MEMBER_ROLE_SET,
            resourceId: 'group-route-role-bob',
            contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
            senderId: 'alice',
            data: {
                scope: TEST_GROUP_SCOPE,
                groupId: 'room-1',
                principalId: 'bob',
                request: {
                    role: 'admin',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'group-route-role-bob'
                }
            }
        },
        {
            type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
            topicId: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
            resourceId: 'group-route-transfer-owner',
            contextId: 'application=app-1:workspace=workspace-1:group=room-1:caller=alice',
            senderId: 'alice',
            data: {
                scope: TEST_GROUP_SCOPE,
                groupId: 'room-1',
                request: {
                    newOwnerPrincipalId: 'bob',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session',
                    requestId: 'group-route-transfer-owner'
                }
            }
        }
    ]);
}

function createMemberRestrictionCommands(
    authSession: GroupStateRouteAuthSession
): readonly ReturnType<typeof toGroupStateCommand>[] {
    const commandBase = { authSession, scope: TEST_GROUP_SCOPE, groupId: 'room-1' } as const;
    const forgedActor = { actorPrincipalId: 'forged-actor', actorSessionId: 'forged-session' };
    return [
        toGroupStateCommand({
            operation: 'remove-group-member',
            ...commandBase,
            principalId: 'bob',
            request: { ...forgedActor, requestId: 'group-route-remove-request' }
        }),
        toGroupStateCommand({
            operation: 'ban-group-member',
            ...commandBase,
            principalId: 'bob',
            request: { ...forgedActor, requestId: 'group-route-ban-request' }
        }),
        toGroupStateCommand({
            operation: 'unban-group-member',
            ...commandBase,
            principalId: 'bob',
            request: { ...forgedActor, requestId: 'group-route-unban-request' }
        })
    ];
}
