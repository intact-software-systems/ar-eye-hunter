import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    authorizeGroupMutation,
    captureAppInboxGroupMutationIngress,
    mutationDescriptor,
    type GroupMutationAuthorityDependencies
} from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';

import { authSession } from './group-state-test-runtime.ts';
import { readMatrixTopicSubscription, writeMatrixClientSession } from './inbox/group-state-inbox-operation-matrix-runtime.ts';
import {
    createAuthorityHarness,
    createRoom,
    processAuthenticated,
    SCOPE,
    type AuthorityHarness
} from './inbox/group-state-inbox-test-runtime.ts';

const NOW_EPOCH_MS = 1_800_000_000_000;
const FINISHED_RETENTION_MS = 60_000;

describe('group mutation ingress capture', () => {
    it('captures an AppInbox ingress from the route proof without a repository read', async () => {
        const dependencies = createReadlessDependencies();
        const session = authSession({
            clientId: 'alice',
            sessionId: 'alice-session',
            accessToken: 'alice-token',
            nowEpochMs: NOW_EPOCH_MS
        });
        const descriptor = mutationDescriptor({
            operation: 'joinGroup',
            scope: { applicationId: 'capture-app', workspaceId: 'workspace-1' },
            groupId: 'capture-room',
            request: { requestId: 'capture-join-request-0001' }
        });
        const authorized = await authorizeGroupMutation(dependencies, descriptor, session);

        const ingress = await captureAppInboxGroupMutationIngress(
            dependencies,
            authorized.descriptor,
            authorized.authorityProof
        );

        expect(ingress.facts).toMatchObject({
            nowEpochMs: NOW_EPOCH_MS,
            expireAtEpochMs: NOW_EPOCH_MS + FINISHED_RETENTION_MS,
            authenticatedAuthority: { principalId: 'alice', sessionId: 'alice-session' }
        });
        expect(ingress.causalToken).toMatch(/^[0-9a-f]{64}$/);
        expect(ingress.queueResourceId).toMatch(/^g-/);
    });

    it('grantGroupPublication and revokeGroupPublication run end to end through processAuthenticated', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await createRoom(harness, 'publication-room', 'Publication room');
        await joinPublicationRoom(harness, 'bob');

        const granted = await processPublicationCommand(harness, AppInboxType.GROUP_PUBLICATION_GRANT, 'bob', PUBLISH_ONLY);
        const revoked = await processPublicationCommand(harness, AppInboxType.GROUP_PUBLICATION_REVOKE, 'bob', PUBLISH_ONLY);

        expect(granted.left, JSON.stringify(granted.left)).toBeUndefined();
        expect(revoked.left, JSON.stringify(revoked.left)).toBeUndefined();
        const events = await harness.repository.listEvents({ ...SCOPE, groupId: 'publication-room' });
        expect(events.filter((event) => event.eventType === 'publication-grant-changed').map((event) => event.payload))
            .toEqual([
                { principalId: 'bob', topicId: 'room.feed', permissions: { publish: true, subscribe: false } },
                { principalId: 'bob', topicId: 'room.feed', permissions: { publish: false, subscribe: false } }
            ]);
    });

    it('subscribeGroupTopic and unsubscribeGroupTopic run end to end through processAuthenticated', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob']);
        await createRoom(harness, 'publication-room', 'Publication room');
        await joinPublicationRoom(harness, 'bob');
        await processPublicationCommand(harness, AppInboxType.GROUP_PUBLICATION_GRANT, 'bob', { publish: false, subscribe: true });
        await writeMatrixClientSession(harness, 'bob', 'bob-ws-generation-1');

        const subscribed = await processSubscriptionCommand(harness, AppInboxType.GROUP_TOPIC_SUBSCRIBE, 'bob-session');
        const row = await readMatrixTopicSubscription(harness, 'publication-room', 'bob-session', 'room.feed');
        const unsubscribed = await processSubscriptionCommand(harness, AppInboxType.GROUP_TOPIC_UNSUBSCRIBE, 'bob-session');

        expect(subscribed.right).toMatchObject({ outcome: 'applied', eventId: null, subscriptionOutcome: 'subscribed' });
        expect(row).toMatchObject({ principalId: 'bob', connectionGenerationId: 'bob-ws-generation-1' });
        expect(unsubscribed.right).toMatchObject({ outcome: 'applied', subscriptionOutcome: 'unsubscribed' });
        expect(await readMatrixTopicSubscription(harness, 'publication-room', 'bob-session', 'room.feed')).toBeUndefined();
        const events = await harness.repository.listEvents({ ...SCOPE, groupId: 'publication-room' });
        // The subscription writes record no event: the room holds only its creation, join and grant.
        expect(events.map((event) => event.eventType)).toEqual(['group-created', 'member-joined', 'publication-grant-changed']);
    });

    it('a subscribe or unsubscribe naming a session other than the caller\'s is refused and writes no row', async () => {
        const harness = await createAuthorityHarness(['owner', 'bob', 'carol']);
        await createRoom(harness, 'publication-room', 'Publication room');
        await joinPublicationRoom(harness, 'bob');
        await processPublicationCommand(harness, AppInboxType.GROUP_PUBLICATION_GRANT, 'bob', { publish: false, subscribe: true });
        await writeMatrixClientSession(harness, 'bob', 'bob-ws-generation-1');
        await writeMatrixClientSession(harness, 'carol', 'bob-ws-generation-1');
        const carolSession = harness.sessions.carol.sessionId;

        for (const type of [AppInboxType.GROUP_TOPIC_SUBSCRIBE, AppInboxType.GROUP_TOPIC_UNSUBSCRIBE] as const) {
            await expectSessionRefused(harness, type, 'bob-other-session');
            await expectSessionRefused(harness, type, carolSession);
        }
        for (const sessionId of ['bob-other-session', carolSession]) {
            expect(await readMatrixTopicSubscription(harness, 'publication-room', sessionId, 'room.feed')).toBeUndefined();
        }
    });
});

const PUBLISH_ONLY = { publish: true, subscribe: false } as const;

async function expectSessionRefused(
    harness: AuthorityHarness,
    type: typeof AppInboxType.GROUP_TOPIC_SUBSCRIBE | typeof AppInboxType.GROUP_TOPIC_UNSUBSCRIBE,
    sessionId: string
): Promise<void> {
    const refusal = await processSubscriptionCommand(harness, type, sessionId).then(
        (result) => result.left,
        (error: Error) => error
    );
    expect(refusal, `${type} ${sessionId}`).toMatchObject({ code: 'group-mutation-authority-denied' });
}

const PUBLICATION_ROOM_CONTEXT = `${SCOPE.applicationId}:${SCOPE.workspaceId}:publication-room`;

async function joinPublicationRoom(harness: AuthorityHarness, principalId: string) {
    const member = harness.sessions[principalId];
    const requestId = `publication-join-${principalId}`;
    return await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: member,
        input: {
            traceId: 'trace-test-fixture',
            type: AppInboxType.GROUP_JOIN,
            resourceId: requestId,
            contextId: PUBLICATION_ROOM_CONTEXT,
            senderId: member.clientId,
            data: {
                scope: SCOPE,
                groupId: 'publication-room',
                request: { actorPrincipalId: principalId, actorSessionId: member.sessionId, requestId }
            }
        }
    });
}

async function processPublicationCommand(
    harness: AuthorityHarness,
    type: typeof AppInboxType.GROUP_PUBLICATION_GRANT | typeof AppInboxType.GROUP_PUBLICATION_REVOKE,
    principalId: string,
    permissions: Readonly<{ publish: boolean; subscribe: boolean; }>
) {
    const owner = harness.sessions.owner;
    const requestId = `${type}-${principalId}`;
    return await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: owner,
        input: {
            traceId: 'trace-test-fixture',
            type,
            resourceId: requestId,
            contextId: PUBLICATION_ROOM_CONTEXT,
            senderId: owner.clientId,
            data: {
                scope: SCOPE,
                groupId: 'publication-room',
                principalId,
                request: {
                    topicId: 'room.feed',
                    ...permissions,
                    actorPrincipalId: 'owner',
                    actorSessionId: owner.sessionId,
                    requestId
                }
            }
        }
    });
}

async function processSubscriptionCommand(
    harness: AuthorityHarness,
    type: typeof AppInboxType.GROUP_TOPIC_SUBSCRIBE | typeof AppInboxType.GROUP_TOPIC_UNSUBSCRIBE,
    sessionId: string
) {
    const bob = harness.sessions.bob;
    const requestId = `${type}-bob-feed-${sessionId}`;
    return await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: bob,
        input: {
            traceId: 'trace-test-fixture',
            type,
            resourceId: requestId,
            contextId: PUBLICATION_ROOM_CONTEXT,
            senderId: bob.clientId,
            data: {
                scope: SCOPE,
                groupId: 'publication-room',
                sessionId,
                request: {
                    topicId: 'room.feed',
                    connectionGenerationId: 'bob-ws-generation-1',
                    actorPrincipalId: 'bob',
                    actorSessionId: bob.sessionId,
                    requestId
                }
            }
        }
    });
}

/** Capture is pure over its command input: every repository it could reach fails the test. */
function createReadlessDependencies(): GroupMutationAuthorityDependencies {
    return {
        authSessions: {
            findBySessionId: async () => {
                throw new Error('The ingress capture must not read the auth session');
            }
        },
        now: () => NOW_EPOCH_MS,
        randomId: () => 'capture-random-id',
        serviceId: 'capture-service',
        finishedRetentionMs: FINISHED_RETENTION_MS
    };
}
