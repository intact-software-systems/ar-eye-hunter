import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { toAuthenticatedGroupMutationQueueKey } from '@shared-server/rallar-system/group-state/inbox/to-authenticated-group-mutation-queue-key.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';

import { createAuthorityHarness, processAuthenticated, SCOPE } from './group-state-inbox-test-runtime.ts';

/** Past the strict queue identity's 128-character resource and context bounds, so both are hashed. */
const LONG_SUFFIX = 'x'.repeat(140);

describe('authenticated group mutation queue key', () => {
    it('is the key the production reservation stores a command under when its ids exceed the strict bounds', async () => {
        const harness = await createAuthorityHarness(['owner']);
        const owner = harness.sessions.owner;
        const requestId = `create-long-room-${LONG_SUFFIX}`;
        const input: AuthenticatedGroupMutationEnqueue = {
            type: AppInboxType.GROUP_CREATE,
            resourceId: requestId,
            contextId: `${SCOPE.applicationId}:${SCOPE.workspaceId}:long-room:${LONG_SUFFIX}`,
            senderId: owner.clientId,
            data: {
                scope: SCOPE,
                request: {
                    groupId: 'long-room',
                    displayName: 'Long room',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: owner.clientId,
                    actorPrincipalId: owner.clientId,
                    actorSessionId: owner.sessionId,
                    requestId
                }
            }
        };

        const created = await processAuthenticated({ service: harness.service, reader: harness.reader, authority: owner, input });

        expect(created.left).toBeUndefined();
        const key = toAuthenticatedGroupMutationQueueKey(input);
        expect(key.resourceId).not.toBe(requestId);
        const reserved = (await harness.queueEntries()).filter((entry) => entry.typeId === EnqueuedType.APP_INBOX);
        expect(reserved.map((entry) => entry.key)).toEqual([key]);
    });
});
