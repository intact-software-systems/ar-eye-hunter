import assert from 'node:assert/strict';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { GroupMutationReceipt } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeApiMutationFailure } from '@shared/api/mutation/api-mutation-failure.ts';

import type { ProcessGroupAppInbox } from '../../src/group-state/group-state-route-contracts.ts';
import {
    captureGroupStateRouteWrite,
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestRuntime,
    GROUP_ROUTE_TRACE_ID,
    postGroupStateMutation
} from './group-state-route-test-runtime.ts';

const GROUP_BASE = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';
const SESSION_BASE = `${GROUP_BASE}/sessions/alice-session`;
const CONTEXT_ID = 'application=app-1:workspace=workspace-1:group=room-1:caller=alice';
const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' } as const;
const ALICE_ACTOR = { actorPrincipalId: 'alice', actorSessionId: 'alice-session' } as const;

function createCapturingRuntime(enqueued: AuthenticatedGroupMutationEnqueue[]) {
    return createGroupStateRouteTestRuntime({
        processGroupAppInbox: captureGroupStateRouteWrite(enqueued, createGroupStateRouteSnapshot('room-1'))
    });
}

function createSubscriptionReceipt(subscriptionOutcome: GroupMutationReceipt['subscriptionOutcome']): GroupMutationReceipt {
    return {
        commandId: 'topicsub-route-command',
        requestId: 'topicsub-route-command',
        commandHash: 'topicsub-route-hash',
        aggregateRef: { ...SCOPE, groupId: 'room-1' },
        outcome: subscriptionOutcome === 'not-subscribed' ? 'no-op' : 'applied',
        attemptCount: 1,
        acceptedStorageRevision: 1,
        snapshotVersion: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        eventId: null,
        outboxIds: [],
        joinCode: null,
        joinCodeExpiresAtEpochMs: null,
        subscriptionOutcome,
        rejection: null
    };
}

function createSubscription(sessionId: string, topicId: string): GroupTopicSubscription {
    return {
        sessionId,
        principalId: sessionId.replace('-session', ''),
        topicId,
        connectionGenerationId: `${sessionId}-generation`,
        leaseExpiresAtEpochMs: 120_000,
        admittedAtGroupRevision: 3
    };
}

Deno.test('the subscribe route enqueues GROUP_TOPIC_SUBSCRIBE with the path requestId as resourceId', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createCapturingRuntime(enqueued);

    const response = await postGroupStateMutation(runtime.app, `${SESSION_BASE}/subscribe`, {
        topicId: 'room.feed',
        connectionGenerationId: 'ws-generation-1',
        reason: 'feed reader',
        requestId: 'topicsub-route-subscribe-request'
    });

    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
        enqueued,
        [{
            type: AppInboxType.GROUP_TOPIC_SUBSCRIBE,
            topicId: AppInboxType.GROUP_TOPIC_SUBSCRIBE,
            resourceId: 'topicsub-route-subscribe-request',
            contextId: CONTEXT_ID,
            senderId: 'alice',
            traceId: GROUP_ROUTE_TRACE_ID,
            data: {
                scope: SCOPE,
                groupId: 'room-1',
                sessionId: 'alice-session',
                request: {
                    topicId: 'room.feed',
                    connectionGenerationId: 'ws-generation-1',
                    reason: 'feed reader',
                    requestId: 'topicsub-route-subscribe-request',
                    ...ALICE_ACTOR
                }
            }
        }] satisfies AuthenticatedGroupMutationEnqueue[]
    );
});

Deno.test('the unsubscribe route enqueues GROUP_TOPIC_UNSUBSCRIBE', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createCapturingRuntime(enqueued);

    const response = await postGroupStateMutation(runtime.app, `${SESSION_BASE}/unsubscribe`, {
        topicId: 'app.scores',
        connectionGenerationId: 'ws-generation-2',
        requestId: 'topicsub-route-unsubscribe-request'
    });

    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
        enqueued,
        [{
            type: AppInboxType.GROUP_TOPIC_UNSUBSCRIBE,
            topicId: AppInboxType.GROUP_TOPIC_UNSUBSCRIBE,
            resourceId: 'topicsub-route-unsubscribe-request',
            contextId: CONTEXT_ID,
            senderId: 'alice',
            traceId: GROUP_ROUTE_TRACE_ID,
            data: {
                scope: SCOPE,
                groupId: 'room-1',
                sessionId: 'alice-session',
                request: {
                    topicId: 'app.scores',
                    connectionGenerationId: 'ws-generation-2',
                    requestId: 'topicsub-route-unsubscribe-request',
                    ...ALICE_ACTOR
                }
            }
        }] satisfies AuthenticatedGroupMutationEnqueue[]
    );
});

Deno.test('a path session other than the auth session is 403 and enqueues nothing', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createCapturingRuntime(enqueued);

    for (const action of ['subscribe', 'unsubscribe'] as const) {
        const response = await postGroupStateMutation(runtime.app, `${GROUP_BASE}/sessions/bob-session/${action}`, {
            topicId: 'room.feed',
            connectionGenerationId: 'ws-generation-1',
            requestId: `topicsub-route-other-session-${action}`
        });
        assert.equal(response.status, 403, action);
        assert.match(decodeApiMutationFailure(await response.json())?.message ?? '', /session id does not match/);
    }
    assert.equal(enqueued.length, 0);
});

Deno.test('malformed bodies are refused before enqueue', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createCapturingRuntime(enqueued);
    const malformedBodies = [
        { topicId: 'room.feed' },
        { topicId: 'room.feed', connectionGenerationId: '' },
        { topicId: 'rallar.state', connectionGenerationId: 'ws-generation-1' },
        { topicId: 'feed', connectionGenerationId: 'ws-generation-1' },
        { topicId: 'room.feed', connectionGenerationId: 'ws-generation-1', principalId: 'bob' },
        { topicId: 'room.feed', connectionGenerationId: 7 }
    ];

    for (const action of ['subscribe', 'unsubscribe'] as const) {
        for (const [index, body] of malformedBodies.entries()) {
            const response = await postGroupStateMutation(runtime.app, `${SESSION_BASE}/${action}`, {
                ...body,
                requestId: `topicsub-route-malformed-${action}-${index}`
            });
            assert.equal(response.status, 400, `${action} ${JSON.stringify(body)}`);
            const failure = decodeApiMutationFailure(await response.json());
            assert.equal(failure?.code, 'api-mutation-request-invalid', `${action} ${JSON.stringify(body)}`);
        }
        const bodyRequestId = await runtime.app.request(
            `${SESSION_BASE}/${action}/requests/topicsub-route-body-request-id`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    topicId: 'room.feed',
                    connectionGenerationId: 'ws-generation-1',
                    requestId: 'topicsub-route-body-request-id'
                })
            }
        );
        assert.equal(bodyRequestId.status, 400, `${action} requestId in the body`);
        const bodyRequestIdFailure = decodeApiMutationFailure(await bodyRequestId.json());
        assert.equal(bodyRequestIdFailure?.code, 'api-mutation-request-invalid', `${action} requestId in the body`);
        assert.match(bodyRequestIdFailure?.message ?? '', /requestId must be supplied only by the request path/);
    }
    assert.equal(enqueued.length, 0);
});

Deno.test('a forged actor in the body is replaced by the auth session', async () => {
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createCapturingRuntime(enqueued);

    for (const action of ['subscribe', 'unsubscribe'] as const) {
        const response = await postGroupStateMutation(runtime.app, `${SESSION_BASE}/${action}`, {
            topicId: 'room.feed',
            connectionGenerationId: 'ws-generation-1',
            actorPrincipalId: 'forged-actor',
            actorSessionId: 'forged-session',
            requestId: `topicsub-route-forged-${action}`
        });
        assert.equal(response.status, 200, `${action}: ${await response.clone().text()}`);
    }

    const subscription = { topicId: 'room.feed', connectionGenerationId: 'ws-generation-1' };
    assert.deepEqual(enqueued.map((entry) => [entry.type, entry.senderId, entry.data.request]), [
        [
            AppInboxType.GROUP_TOPIC_SUBSCRIBE,
            'alice',
            { ...subscription, requestId: 'topicsub-route-forged-subscribe', ...ALICE_ACTOR }
        ],
        [
            AppInboxType.GROUP_TOPIC_UNSUBSCRIBE,
            'alice',
            { ...subscription, requestId: 'topicsub-route-forged-unsubscribe', ...ALICE_ACTOR }
        ]
    ]);
});

Deno.test('the response is { outcome } from the receipt', async () => {
    const outcomes = [
        ['subscribe', 'subscribed'],
        ['subscribe', 'renewed'],
        ['unsubscribe', 'unsubscribed'],
        ['unsubscribe', 'not-subscribed']
    ] as const;

    for (const [action, outcome] of outcomes) {
        const processGroupAppInbox: ProcessGroupAppInbox = () => Promise.resolve(createSubscriptionReceipt(outcome));
        const runtime = createGroupStateRouteTestRuntime({ processGroupAppInbox });
        const response = await postGroupStateMutation(runtime.app, `${SESSION_BASE}/${action}`, {
            topicId: 'room.feed',
            connectionGenerationId: 'ws-generation-1',
            requestId: `topicsub-route-response-${outcome}`
        });

        assert.equal(response.status, 200, outcome);
        assert.deepEqual(await response.json(), { outcome }, outcome);
    }
});

Deno.test('the subscriptions read lists the session\'s rows and refuses another session', async () => {
    const rows = [createSubscription('alice-session', 'app.scores'), createSubscription('alice-session', 'room.feed')];
    const reads: (readonly [GroupRef, string])[] = [];
    const runtime = createGroupStateRouteTestRuntime({
        groupService: {
            readGroupSessionTopicSubscriptions: (ref: GroupRef, sessionId: string) => {
                reads.push([ref, sessionId]);
                return Promise.resolve(rows);
            }
        }
    });

    const own = await runtime.app.request(`${SESSION_BASE}/subscriptions`);
    assert.equal(own.status, 200, await own.clone().text());
    assert.deepEqual(await own.json(), { subscriptions: rows });

    const other = await runtime.app.request(`${GROUP_BASE}/sessions/bob-session/subscriptions`);
    assert.equal(other.status, 403);
    assert.match(JSON.stringify(await other.json()), /session id does not match/);

    // The read is scoped by the path's application, workspace and group and the authenticated session; the refused
    // read reaches no store.
    assert.deepEqual(reads, [[{ ...SCOPE, groupId: 'room-1' }, 'alice-session']]);
});
