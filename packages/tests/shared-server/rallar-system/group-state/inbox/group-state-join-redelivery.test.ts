import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createAuthorityHarness, createResilience, createRoom, SCOPE, waitForQueueEntry } from './group-state-inbox-test-runtime.ts';

describe('authenticated group join redelivery', () => {
    it('recomputes after a conditional conflict and commits a durable authenticated membership and result', async () => {
        const harness = await createAuthorityHarness(['owner', 'member']);
        await createRoom(harness, 'join-redelivery', 'Join redelivery');
        let capturedResource: string | undefined;
        let writes = 0;
        harness.runtimeRepository.beforeConditionalWrite = async () => {
            writes += 1;
            if (writes !== 1) {
                return;
            }
            const entry = (await harness.queueEntries()).find((entry) => entry.status === EntityStatus.RESERVED);
            capturedResource = entry?.resource;
            throw new RuntimeStateWriteConflictError();
        };
        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion({
            type: AppInboxType.GROUP_JOIN,
            resourceId: 'join-member',
            contextId: 'join-redelivery',
            senderId: 'member',
            data: {
                scope: SCOPE,
                groupId: 'join-redelivery',
                request: { actorPrincipalId: 'member', actorSessionId: 'member-session', requestId: 'join-member' }
            }
        }, harness.sessions.member);
        await waitForQueueEntry(harness.queue);
        const original = (await harness.queueEntries()).find((entry) => entry.key.resourceId === 'join-member');
        expect(original).toBeDefined();
        const resilience = createResilience();

        await expect.poll(async () => {
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
            return await harness.queue.getItem(original!.key);
        }).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });

        await expect(pending).resolves.toMatchObject({ right: { status: 'ok' } });
        expect(writes).toBeGreaterThan(1);
        expect(capturedResource).toBeDefined();
        expect((await harness.queue.getItem(original!.key))?.resource).toBe(capturedResource);
        expect(await harness.results.findByKey(original!.key)).toMatchObject({ status: EntityStatus.COMPLETED });
        const snapshot = await harness.repository.readSnapshot({ ...SCOPE, groupId: 'join-redelivery' });
        expect(snapshot?.members).toEqual(expect.arrayContaining([expect.objectContaining({ principalId: 'member', status: 'active' })]));
    });
});
