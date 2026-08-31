import assert from 'node:assert/strict';

import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';

import {
    captureGroupStateRouteWrite,
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestRuntime,
    postGroupStateMutation
} from './group-state-route-test-runtime.ts';

const API_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups';

Deno.test('eight lifecycle routes normalize authority and preserve command identity', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const snapshot = createGroupStateRouteSnapshot('room-1');
    const runtime = createGroupStateRouteTestRuntime({
        processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot)
    });
    const commands = [
        { route: 'plan', type: 'GROUP_PLAN', request: {} },
        {
            route: 'connect',
            type: 'GROUP_CONNECT',
            request: { expectedFormationEpoch: 1, expectedLayout: { groupRevision: 1, presenceRevision: 0, version: 2, state: 'active' } }
        },
        { route: 'activate', type: 'GROUP_ACTIVATE', request: {} },
        { route: 'reconfigure', type: 'GROUP_RECONFIGURE', request: { landing: 'hold' } },
        { route: 'pause', type: 'GROUP_TRANSPORT_PAUSE', request: {} },
        { route: 'resume', type: 'GROUP_TRANSPORT_RESUME', request: {} },
        { route: 'reset', type: 'GROUP_FORMATION_RESET', request: {} },
        { route: 'start', type: 'GROUP_FORMATION_START', request: {} }
    ];
    for (const command of commands) {
        const response = await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/${command.route}`, {
            ...command.request,
            actorPrincipalId: 'forged-actor',
            actorSessionId: 'forged-session',
            requestId: `group-lifecycle-route-${command.route}`
        });
        assert.equal(response.status, 200, `${command.route}: ${await response.clone().text()}`);
        assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(snapshot)));
        const enqueue = enqueued.at(-1)!;
        assert.equal(enqueue.type, command.type);
        assert.equal(enqueue.topicId, command.type);
        assert.equal(enqueue.resourceId, `group-lifecycle-route-${command.route}`);
        assert.equal(enqueue.contextId, 'application=app-1:workspace=workspace-1:group=room-1:caller=alice');
        assert.deepEqual(enqueue.data.request, {
            ...command.request,
            ...(command.route === 'reconfigure' ? { expectedFormationEpoch: null } : {}),
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: `group-lifecycle-route-${command.route}`
        });
    }
});

Deno.test('connect refuses missing and malformed layout identities before enqueue', async () => {
    const runtime = createGroupStateRouteTestRuntime({
        processGroupAppInbox: () => Promise.reject(new Error('must not enqueue'))
    });
    for (
        const request of [
            {},
            {
                expectedFormationEpoch: 1,
                expectedLayout: { groupRevision: 1, presenceRevision: 0, version: 2, state: 'active' },
                connectTriggerGeneration: 'forged'
            },
            { expectedFormationEpoch: 1 },
            { expectedFormationEpoch: 1, expectedLayout: {} },
            { expectedFormationEpoch: -1, expectedLayout: { groupRevision: 1, presenceRevision: 0, version: 2, state: 'active' } }
        ]
    ) {
        const response = await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/connect`, request);
        assert.equal(response.status, 400);
    }
});

Deno.test('retired lifecycle URLs cannot enter authority', async () => {
    const runtime = createGroupStateRouteTestRuntime({
        processGroupAppInbox: () => Promise.reject(new Error('must not enqueue'))
    });
    for (const route of ['establish', 'reopen']) {
        const response = await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/${route}`, {});
        assert.equal(response.status, 404);
    }
});

Deno.test('reconfigure rejects caller epoch fields before enqueue without erasing them', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createGroupStateRouteTestRuntime({
        processGroupAppInbox: captureGroupStateRouteWrite(enqueued, createGroupStateRouteSnapshot('room-1'))
    });
    for (const expectedFormationEpoch of [null, 0, 42, 'invalid']) {
        const response = await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/reconfigure`, {
            expectedFormationEpoch,
            requestId: `reconfigure-extra-epoch-${String(expectedFormationEpoch)}`
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).message, 'Group reconfigureGroup request has unexpected key: expectedFormationEpoch');
    }
    assert.deepEqual(enqueued, []);
});

Deno.test('reconfigure preserves omission and null landing with authenticated identity', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createGroupStateRouteTestRuntime({
        processGroupAppInbox: captureGroupStateRouteWrite(enqueued, createGroupStateRouteSnapshot('room-1'))
    });
    for (const request of [{}, { landing: null }]) {
        const response = await postGroupStateMutation(runtime.app, `${API_BASE}/room-1/lifecycle/reconfigure`, {
            ...request,
            requestId: `reconfigure-default-${enqueued.length}`
        });
        assert.equal(response.status, 200);
        assert.deepEqual(enqueued.at(-1)?.data.request, {
            requestId: `reconfigure-default-${enqueued.length - 1}`,
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            expectedFormationEpoch: null,
            landing: null
        });
    }
});

Deno.test('group lifecycle transition routes reject malformed actor fields', async () => {
    const runtime = createGroupStateRouteTestRuntime({
        processGroupAppInbox: () => Promise.reject(new Error('must not enqueue'))
    });
    const response = await postGroupStateMutation(
        runtime.app,
        `${API_BASE}/room-1/lifecycle/activate`,
        { traceId: 7 }
    );
    assert.equal(response.status, 400);
});
