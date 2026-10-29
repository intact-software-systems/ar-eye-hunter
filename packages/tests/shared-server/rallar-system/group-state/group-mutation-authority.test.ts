import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import {
    authorizeGroupMutation,
    captureAppInboxGroupMutationIngress,
    mutationDescriptor,
    type GroupMutationAuthorityDependencies
} from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';

import { authSession } from './group-state-test-runtime.ts';
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
        await processPublicationCommand(harness, {
            type: AppInboxType.GROUP_JOIN,
            principalId: null,
            requestId: 'publication-join-bob'
        });

        const granted = await processPublicationCommand(harness, {
            type: AppInboxType.GROUP_PUBLICATION_GRANT,
            principalId: 'bob',
            requestId: 'publication-grant-bob'
        });
        const revoked = await processPublicationCommand(harness, {
            type: AppInboxType.GROUP_PUBLICATION_REVOKE,
            principalId: 'bob',
            requestId: 'publication-revoke-bob'
        });

        expect(granted.left, JSON.stringify(granted.left)).toBeUndefined();
        expect(revoked.left, JSON.stringify(revoked.left)).toBeUndefined();
        const events = await harness.repository.listEvents({ ...SCOPE, groupId: 'publication-room' });
        expect(events.filter((event) => event.eventType === 'publication-grant-changed').map((event) => event.payload))
            .toEqual([
                { principalId: 'bob', topicId: 'room.feed', permissions: { publish: true, subscribe: false } },
                { principalId: 'bob', topicId: 'room.feed', permissions: { publish: false, subscribe: false } }
            ]);
    });
});

interface PublicationCommandCase {
    readonly type:
        | typeof AppInboxType.GROUP_JOIN
        | typeof AppInboxType.GROUP_PUBLICATION_GRANT
        | typeof AppInboxType.GROUP_PUBLICATION_REVOKE;
    readonly principalId: string | null;
    readonly requestId: string;
}

async function processPublicationCommand(harness: AuthorityHarness, testCase: PublicationCommandCase) {
    const base = {
        traceId: 'trace-test-fixture',
        resourceId: testCase.requestId,
        contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:publication-room`
    };
    if (testCase.type === AppInboxType.GROUP_JOIN || testCase.principalId === null) {
        const bob = harness.sessions.bob;
        return await processAuthenticated({
            service: harness.service,
            reader: harness.reader,
            authority: bob,
            input: {
                ...base,
                type: AppInboxType.GROUP_JOIN,
                senderId: bob.clientId,
                data: {
                    scope: SCOPE,
                    groupId: 'publication-room',
                    request: { actorPrincipalId: 'bob', actorSessionId: bob.sessionId, requestId: testCase.requestId }
                }
            }
        });
    }
    const owner = harness.sessions.owner;
    return await processAuthenticated({
        service: harness.service,
        reader: harness.reader,
        authority: owner,
        input: {
            ...base,
            type: testCase.type,
            senderId: owner.clientId,
            data: {
                scope: SCOPE,
                groupId: 'publication-room',
                principalId: testCase.principalId,
                request: {
                    topicId: 'room.feed',
                    publish: true,
                    subscribe: false,
                    actorPrincipalId: 'owner',
                    actorSessionId: owner.sessionId,
                    requestId: testCase.requestId
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
