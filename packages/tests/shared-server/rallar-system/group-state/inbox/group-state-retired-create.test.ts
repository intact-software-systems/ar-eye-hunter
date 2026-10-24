import {
    describe,
    expect,
    it
} from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    createAuthorityHarness,
    createResilience,
    SCOPE,
    waitForQueueEntry
} from './group-state-inbox-test-runtime.ts';

describe('retired room creation through AppInbox', () => {
    it('completes one 410 denial and replays it without retrying or recreating the room', async () => {
        const harness = await createAuthorityHarness(['owner'], {
            serviceOptions: { waitMaxElapsedMsecs: 1_000, waitRetryIntervalMsecs: 10, waitMaxRetryIntervalMsecs: 10, waitJitterRatio: 0 }
        });
        const ref = { ...SCOPE, groupId: 'permanently-retired' };
        const key = groupStateGroupStorageKey(ref);
        const retiredValue = JSON.stringify({
            ...ref,
            kind: 'retired-group',
            deletedAtEpochMs: harness.nowEpochMs - 1,
            causalRevision: { groupRevision: 4, presenceRevision: 0 },
            commandId: 'delete-retired-room',
            commandHash: 'retirement-command-hash'
        });
        await harness.runtimeRepository.upsert(GROUPS_NAMESPACE, key, retiredValue, NEVER_EXPIRE_AT_TIMESTAMP);
        const command = {
            type: AppInboxType.GROUP_CREATE,
            resourceId: 'recreate-retired-room',
            contextId: ref.groupId,
            senderId: 'owner',
            data: {
                scope: SCOPE,
                request: {
                    groupId: ref.groupId,
                    displayName: 'Recreated room',
                    kind: 'room' as const,
                    joinMode: 'open' as const,
                    createdByPrincipalId: 'owner',
                    actorPrincipalId: 'owner',
                    actorSessionId: 'owner-session',
                    requestId: 'recreate-retired-room'
                }
            }
        };
        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion(command, harness.sessions.owner);
        await waitForQueueEntry(harness.queue);
        const [entry] = await harness.queueEntries();
        const resilience = createResilience();
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        const result = await pending;

        expect(result.left).toMatchObject({ code: 'group-retired', status: 410, retry: null });
        expect(result.right).toBeUndefined();
        const terminalResult = await harness.results.findByKey(entry.key);
        expect(terminalResult?.status).toBe(EntityStatus.FAILED);
        expect(JSON.parse(terminalResult?.resource ?? 'null')).toMatchObject({ code: 'group-retired', status: 410 });
        for (let pass = 0; pass < 3; pass += 1) {
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        }
        expect(await harness.queue.getItem(entry.key)).toMatchObject({
            status: EntityStatus.FAILED,
            dequeueAudit: { attempts: 1 }
        });
        expect(await harness.service.processAuthenticatedGroupEntryUntilCompletion(command, harness.sessions.owner))
            .toEqual(result);
        expect(await harness.results.findByKey(entry.key)).toEqual(terminalResult);
        expect((await harness.runtimeRepository.findEntry(GROUPS_NAMESPACE, key))?.value).toBe(retiredValue);
        expect(await harness.repository.listEvents(ref)).toEqual([]);
        expect(await harness.repository.readSnapshot(ref)).toBeUndefined();
    });
});
