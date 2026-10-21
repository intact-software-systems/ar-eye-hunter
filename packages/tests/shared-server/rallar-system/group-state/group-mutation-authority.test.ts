import { describe, expect, it } from 'vitest';

import {
    authorizeGroupMutation,
    captureAppInboxGroupMutationIngress,
    mutationDescriptor,
    type GroupMutationAuthorityDependencies
} from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';

import { authSession } from './group-state-test-runtime.ts';

const NOW_EPOCH_MS = 1_800_000_000_000;

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
            authenticatedAuthority: { principalId: 'alice', sessionId: 'alice-session' }
        });
        expect(ingress.causalToken).toMatch(/^[0-9a-f]{64}$/);
        expect(ingress.queueResourceId).toMatch(/^g-/);
    });
});

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
        serviceId: 'capture-service'
    };
}
