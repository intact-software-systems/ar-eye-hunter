import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createAuthorityHarness, createResilience, SCOPE, waitForQueueEntry } from './group-state-inbox-test-runtime.ts';

describe('GroupStateInboxService authority capture and retry', () => {
    it('keeps captured facts and finishes on redelivery after a conditional write conflicts', async () => {
        const harness = await createAuthorityHarness(['owner']);
        let capturedResource: string | undefined;
        harness.runtimeRepository.beforeConditionalWrite = async () => {
            harness.runtimeRepository.beforeConditionalWrite = undefined;
            const [entry] = await harness.queueEntries();
            capturedResource = entry.resource;
            throw new RuntimeStateWriteConflictError();
        };
        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion({
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'create-authority-retry',
            contextId: 'authority-retry',
            senderId: 'owner',
            data: {
                scope: SCOPE,
                request: {
                    groupId: 'authority-retry',
                    displayName: 'Authority retry',
                    kind: 'room',
                    joinMode: 'open',
                    createdByPrincipalId: 'owner',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'create-authority-retry'
                }
            }
        }, harness.sessions.owner);
        await waitForQueueEntry(harness.queue);
        const [original] = await harness.queueEntries();
        const resilience = createResilience();

        await expect.poll(async () => {
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
            return await harness.queue.getItem(original.key);
        }).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });

        await expect(pending).resolves.toMatchObject({ right: { status: 'created' } });
        expect(capturedResource).toBeDefined();
        expect((await harness.queue.getItem(original.key))?.resource).toBe(capturedResource);
        expect(original.resource).not.toBe(capturedResource);
        expect((await harness.repository.readSnapshot({ ...SCOPE, groupId: 'authority-retry' }))?.group.displayName)
            .toBe('Authority retry');
    });
});
