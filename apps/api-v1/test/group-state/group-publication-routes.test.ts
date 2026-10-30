import assert from 'node:assert/strict';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { decodeApiMutationFailure } from '@shared/api/mutation/api-mutation-failure.ts';

import {
    captureGroupStateRouteWrite,
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestRuntime,
    GROUP_ROUTE_TRACE_ID,
    postGroupStateMutation
} from './group-state-route-test-runtime.ts';

const GRANTS_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/publication-grants/bob';
const CONTEXT_ID = 'application=app-1:workspace=workspace-1:group=room-1:caller=alice';
const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' } as const;

function createGrantedSnapshot(): GroupSnapshot {
    const snapshot = createGroupStateRouteSnapshot('room-1', ['alice', 'bob']);
    return {
        ...snapshot,
        publicationGrants: [{
            ...SCOPE,
            groupId: 'room-1',
            principalId: 'bob',
            topics: { 'room.feed': { publish: true, subscribe: false } },
            updated: snapshot.group.updated
        }]
    };
}

function createCapturingRuntime(enqueued: AuthenticatedGroupMutationEnqueue[], snapshot: GroupSnapshot) {
    return createGroupStateRouteTestRuntime({ processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot) });
}

Deno.test('the grant route enqueues GROUP_PUBLICATION_GRANT with the path requestId as resourceId', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createCapturingRuntime(enqueued, createGrantedSnapshot());

    const response = await postGroupStateMutation(runtime.app, `${GRANTS_BASE}/grant`, {
        topicId: 'room.feed',
        publish: true,
        subscribe: false,
        reason: 'feed host',
        requestId: 'pubgrant-route-grant-request'
    });

    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
        enqueued,
        [{
            type: AppInboxType.GROUP_PUBLICATION_GRANT,
            topicId: AppInboxType.GROUP_PUBLICATION_GRANT,
            resourceId: 'pubgrant-route-grant-request',
            contextId: CONTEXT_ID,
            senderId: 'alice',
            traceId: GROUP_ROUTE_TRACE_ID,
            data: {
                scope: SCOPE,
                groupId: 'room-1',
                principalId: 'bob',
                request: {
                    topicId: 'room.feed',
                    publish: true,
                    subscribe: false,
                    reason: 'feed host',
                    requestId: 'pubgrant-route-grant-request',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session'
                }
            }
        }] satisfies AuthenticatedGroupMutationEnqueue[]
    );
});

Deno.test('the revoke route enqueues GROUP_PUBLICATION_REVOKE', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createCapturingRuntime(enqueued, createGroupStateRouteSnapshot('room-1', ['alice', 'bob']));

    const response = await postGroupStateMutation(runtime.app, `${GRANTS_BASE}/revoke`, {
        topicId: 'app.scores',
        publish: false,
        subscribe: true,
        requestId: 'pubgrant-route-revoke-request'
    });

    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
        enqueued,
        [{
            type: AppInboxType.GROUP_PUBLICATION_REVOKE,
            topicId: AppInboxType.GROUP_PUBLICATION_REVOKE,
            resourceId: 'pubgrant-route-revoke-request',
            contextId: CONTEXT_ID,
            senderId: 'alice',
            traceId: GROUP_ROUTE_TRACE_ID,
            data: {
                scope: SCOPE,
                groupId: 'room-1',
                principalId: 'bob',
                request: {
                    topicId: 'app.scores',
                    publish: false,
                    subscribe: true,
                    requestId: 'pubgrant-route-revoke-request',
                    actorPrincipalId: 'alice',
                    actorSessionId: 'alice-session'
                }
            }
        }] satisfies AuthenticatedGroupMutationEnqueue[]
    );
});

Deno.test('a forged actor in the body is replaced by the auth session', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createCapturingRuntime(enqueued, createGroupStateRouteSnapshot('room-1', ['alice', 'bob']));

    for (const action of ['grant', 'revoke'] as const) {
        const response = await postGroupStateMutation(runtime.app, `${GRANTS_BASE}/${action}`, {
            topicId: 'room.feed',
            publish: true,
            subscribe: true,
            actorPrincipalId: 'forged-actor',
            actorSessionId: 'forged-session',
            requestId: `pubgrant-route-forged-${action}`
        });
        assert.equal(response.status, 200, `${action}: ${await response.clone().text()}`);
    }

    const replacedActor = { actorPrincipalId: 'alice', actorSessionId: 'alice-session' };
    const permissions = { topicId: 'room.feed', publish: true, subscribe: true };
    assert.deepEqual(enqueued.map((entry) => [entry.type, entry.senderId, entry.data.request]), [
        [
            AppInboxType.GROUP_PUBLICATION_GRANT,
            'alice',
            { ...permissions, requestId: 'pubgrant-route-forged-grant', ...replacedActor }
        ],
        [
            AppInboxType.GROUP_PUBLICATION_REVOKE,
            'alice',
            { ...permissions, requestId: 'pubgrant-route-forged-revoke', ...replacedActor }
        ]
    ]);
});

Deno.test('malformed grant and revoke bodies are refused before enqueue', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createCapturingRuntime(enqueued, createGroupStateRouteSnapshot('room-1', ['alice', 'bob']));
    const malformedBodies = [
        { topicId: 'room.feed', publish: false, subscribe: false },
        { topicId: 'rallar.state', publish: true, subscribe: false },
        { topicId: 'feed', publish: true, subscribe: false },
        { topicId: 'room.feed', publish: true, subscribe: false, role: 'admin' },
        { topicId: 'room.feed', publish: true },
        { topicId: 'room.feed', publish: 'yes', subscribe: false },
        { topicId: 'room.feed', publish: true, subscribe: false, reason: 7 }
    ];

    for (const action of ['grant', 'revoke'] as const) {
        for (const [index, body] of malformedBodies.entries()) {
            const response = await postGroupStateMutation(runtime.app, `${GRANTS_BASE}/${action}`, {
                ...body,
                requestId: `pubgrant-route-malformed-${action}-${index}`
            });
            assert.equal(response.status, 400, `${action} ${JSON.stringify(body)}`);
            const failure = decodeApiMutationFailure(await response.json());
            assert.equal(failure?.code, 'api-mutation-request-invalid', `${action} ${JSON.stringify(body)}`);
        }
        const bodyRequestId = await runtime.app.request(
            `${GRANTS_BASE}/${action}/requests/pubgrant-route-body-request-id`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    topicId: 'room.feed',
                    publish: true,
                    subscribe: false,
                    requestId: 'pubgrant-route-body-request-id'
                })
            }
        );
        assert.equal(bodyRequestId.status, 400, `${action} requestId in the body`);
    }
    assert.equal(enqueued.length, 0);
});

Deno.test('the response is the written GroupSnapshot', async () => {
    const snapshot = createGrantedSnapshot();
    const runtime = createCapturingRuntime([], snapshot);

    const response = await postGroupStateMutation(runtime.app, `${GRANTS_BASE}/grant`, {
        topicId: 'room.feed',
        publish: true,
        subscribe: false,
        requestId: 'pubgrant-route-response-request'
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(snapshot)));
});
