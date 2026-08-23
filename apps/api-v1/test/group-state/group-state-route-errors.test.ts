import assert from 'node:assert/strict';

import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { toGroupStateErrorResponse } from '../../src/group-state/group-state-route-errors.ts';

import {
    createLiveGroupStateRouteAuthSession,
    createOwnerGroupStateRouteSnapshot,
    createRejectingGroupStateRouteTestRuntime,
    withStrictGroupStateRouteReadAuth
} from './group-state-route-test-runtime.ts';

Deno.test('group route errors retain policy details and structured AppInbox status', async () => {
    const policyError = new GroupPolicyDeniedError({
        allowed: false,
        code: 'group-invite-required',
        message: 'Invite required.',
        details: { groupId: 'room-1' }
    });
    const policyResponse = toGroupStateErrorResponse(
        createErrorResponseContext(),
        policyError
    );

    assert.equal(policyResponse.status, 403);
    assert.deepEqual(await policyResponse.json(), {
        error: 'Forbidden: Invite required.',
        code: 'group-invite-required',
        message: 'Invite required.',
        details: { groupId: 'room-1' }
    });

    const structuredFailure = Object.assign(
        new Error('Group mutation command differs for request same-request'),
        {
            code: 'group-mutation-idempotency-conflict',
            status: 409
        }
    );
    const structuredResponse = toGroupStateErrorResponse(
        createErrorResponseContext(),
        structuredFailure
    );

    assert.equal(structuredResponse.status, 409);
    assert.deepEqual(await structuredResponse.json(), {
        error: 'Group mutation command differs for request same-request',
        code: 'group-mutation-idempotency-conflict'
    });
});
function createErrorResponseContext(): {
    json(value: unknown, status?: number): Response;
} {
    return {
        json: (body, status) => new Response(JSON.stringify(body), { status })
    };
}

Deno.test('group route adapter preserves canonical AppInbox status code and message', async () => {
    const failure = Object.assign(
        new Error('Group mutation command differs for request same-request'),
        {
            code: 'group-mutation-idempotency-conflict',
            status: 409
        }
    );
    const { app } = createRejectingGroupStateRouteTestRuntime({
        session: createLiveGroupStateRouteAuthSession('alice'),
        groupService: {},
        processGroupAppInbox: () => Promise.reject(failure)
    });

    const response = await app.request(
        '/api/state/apps/app-1/workspaces/workspace-1/groups/requests/' +
            'group-conflict-request-001',
        {
            method: 'POST',
            headers: {
                authorization: 'Bearer token',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                groupId: 'room-1',
                displayName: 'Room 1',
                kind: 'room',
                joinMode: 'open'
            })
        }
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code: 'group-mutation-idempotency-conflict',
        status: 409,
        message: 'Group mutation command differs for request same-request',
        issues: null,
        denial: null,
        retry: null
    });
});

Deno.test('group state routes return stable policy error codes when available', async () => {
    await withStrictGroupStateRouteReadAuth(false, async () => {
        const { app } = createRejectingGroupStateRouteTestRuntime({
            session: createLiveGroupStateRouteAuthSession('alice'),
            groupService: {
                listSnapshots: () =>
                    Promise.reject(
                        new GroupPolicyDeniedError({
                            allowed: false,
                            code: 'group-invite-required',
                            message: 'Invite required.',
                            details: { groupId: 'room-1' }
                        })
                    )
            }
        });

        const response = await app.request(
            '/api/state/apps/app-1/workspaces/workspace-1/groups',
            { headers: { authorization: 'Bearer token' } }
        );

        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), {
            error: 'Forbidden: Invite required.',
            code: 'group-invite-required',
            message: 'Invite required.',
            details: { groupId: 'room-1' }
        });
    });
});

Deno.test('group mutation routes return stable lifecycle policy error codes', async () => {
    await withStrictGroupStateRouteReadAuth(false, async () => {
        const snapshot = createOwnerGroupStateRouteSnapshot('room-1', ['alice']);
        const ownerSnapshot: GroupSnapshot = {
            ...snapshot,
            members: snapshot.members.map((member) => member.principalId === 'alice' ? { ...member, role: 'owner' as const } : member)
        };
        const { app } = createRejectingGroupStateRouteTestRuntime({
            session: createLiveGroupStateRouteAuthSession('alice'),
            groupService: {
                readSnapshot: () => Promise.resolve(ownerSnapshot)
            },
            processGroupAppInbox: () =>
                Promise.reject(
                    new GroupPolicyDeniedError({
                        allowed: false,
                        code: 'group-archived',
                        message: 'Group is archived.',
                        details: { groupId: 'room-1' }
                    })
                )
        });

        const response = await app.request(
            '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/requests/' +
                'group-lifecycle-denial-001',
            {
                method: 'PUT',
                headers: {
                    authorization: 'Bearer token',
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ displayName: 'Renamed' })
            }
        );

        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), {
            type: 'api-mutation-failure',
            version: 'canonical.v2',
            code: 'group-archived',
            status: 403,
            message: 'Group is archived.',
            issues: null,
            denial: {
                code: 'group-archived',
                message: 'Group is archived.',
                details: { groupId: 'room-1' }
            },
            retry: null
        });
    });
});
