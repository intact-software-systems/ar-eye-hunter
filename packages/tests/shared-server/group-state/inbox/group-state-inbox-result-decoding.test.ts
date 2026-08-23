import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-client.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

import { createAuthorityHarness, SCOPE, waitForQueueEntry } from './group-state-inbox-test-runtime.ts';

describe('group-state AppInbox durable result decoding', () => {
    it('returns the exact terminal left for a malformed completed group result', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const authority = harness.sessions.owner;
        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            {
                type: AppInboxType.GROUP_CREATE,
                resourceId: 'malformed-group-result',
                contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:malformed-result-room`,
                senderId: authority.clientId,
                data: {
                    scope: SCOPE,
                    request: {
                        groupId: 'malformed-result-room',
                        displayName: 'Malformed result room',
                        kind: 'room' as const,
                        joinMode: 'open' as const,
                        createdByPrincipalId: authority.clientId,
                        actorPrincipalId: authority.clientId,
                        actorSessionId: authority.sessionId,
                        requestId: 'malformed-group-result'
                    }
                }
            },
            authority
        );

        await waitForQueueEntry(harness.queue);
        const [key] = await harness.queue.getAllKeys();
        if (key === undefined) {
            throw new Error('Expected a durable group queue key');
        }
        const queued = await harness.queue.getItem(key);
        if (queued === undefined) {
            throw new Error('Expected a durable group queue entry');
        }
        const completed = {
            ...queued,
            resource: JSON.stringify({ status: 'created' }),
            status: EntityStatus.COMPLETED
        };
        await harness.results.replace(completed);
        await harness.queue.enqueue(completed);

        const result = await pending;
        expect(result.right).toBeUndefined();
        expect(result.left).toEqual({
            type: 'app-inbox-failure',
            version: 'canonical.v2',
            code: 'TypeError',
            status: 400,
            message: 'Group state result fields are invalid',
            issues: null,
            denial: null,
            retry: null
        });
    });
});
