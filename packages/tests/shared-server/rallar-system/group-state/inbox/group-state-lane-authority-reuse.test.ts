import { describe, expect, it, vi } from 'vitest';

import { toGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry, RuntimeStateEntryPageOptions } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { activateMember, presenceConnectEnqueue } from './group-state-inbox-presence-fixtures.ts';
import {
    createAuthorityHarness,
    createResilience,
    createRoom,
    SCOPE,
    waitForQueueEntry
} from './group-state-inbox-test-runtime.ts';

/**
 * Runtime-state reads one presence connect performs inside the lane, from its
 * dequeue to its completion: the lane captures the ingress with the route's
 * proof (one causal-revision read), persists it, re-checks only that the
 * session is still live (one session read), then reads the presence facts.
 */
const LANE_RUNTIME_STATE_READS_PER_PRESENCE_CONNECT = 5;

const GROUP_ID = 'authority-reuse-room';

describe('group mutation lane authority reuse', () => {
    it('captures a presence connect with the route proof and stores the credential-equivalent authority', async () => {
        const runtimeRepository = new CountingRuntimeStateRepository();
        const harness = await createAuthorityHarness(['owner', 'alice'], { runtimeRepository });
        await createRoom(harness, GROUP_ID, 'Authority reuse room');
        await activateMember(harness, GROUP_ID, 'alice');
        const enqueue = presenceConnectEnqueue(GROUP_ID, 'alice', harness.nowEpochMs);

        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion(enqueue, harness.sessions.alice);
        await waitForQueueEntry(harness.queue);
        const credentialIngress = await harness.groupStateService.captureAppInboxMutationIngress(
            toGroupMutationDescriptor(enqueue),
            harness.sessions.alice
        );
        runtimeRepository.readCount = 0;
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({ right: { commandId: expect.any(String) } });
        expect(runtimeRepository.readCount).toBe(LANE_RUNTIME_STATE_READS_PER_PRESENCE_CONNECT);
        const entry = await readConnectEntry(harness.queueEntries);
        expect(entry.status).toBe(EntityStatus.COMPLETED);
        expect(readPersistedAuthority(entry)).toEqual(JSON.parse(JSON.stringify(credentialIngress)));
    });

    it('refuses a presence connect whose session was revoked between enqueue and execution', async () => {
        const harness = await createAuthorityHarness(['owner', 'alice']);
        await createRoom(harness, GROUP_ID, 'Authority reuse room');
        await activateMember(harness, GROUP_ID, 'alice');

        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            presenceConnectEnqueue(GROUP_ID, 'alice', harness.nowEpochMs),
            harness.sessions.alice
        );
        await waitForQueueEntry(harness.queue);
        await harness.authSessions.deleteSession(harness.sessions.alice);
        await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());

        await expect(pending).resolves.toMatchObject({
            left: { status: 403, code: 'group-mutation-authority-denied' }
        });
        expect(await harness.repository.listPresenceSessions({ ...SCOPE, groupId: GROUP_ID })).toEqual([]);
    });

    it('keeps the captured queue identity and captures once across a redelivery', async () => {
        const harness = await createAuthorityHarness(['owner', 'alice']);
        await createRoom(harness, GROUP_ID, 'Authority reuse room');
        await activateMember(harness, GROUP_ID, 'alice');
        const capture = vi.spyOn(harness.groupStateService, 'captureAppInboxMutationIngress');
        let firstAttemptAuthority: JsonWireValue | undefined;
        harness.runtimeRepository.beforeConditionalWrite = async () => {
            harness.runtimeRepository.beforeConditionalWrite = undefined;
            firstAttemptAuthority = readPersistedAuthority(await readConnectEntry(harness.queueEntries));
            throw new RuntimeStateWriteConflictError();
        };

        const pending = harness.service.processAuthenticatedGroupEntryUntilCompletion(
            presenceConnectEnqueue(GROUP_ID, 'alice', harness.nowEpochMs),
            harness.sessions.alice
        );
        await waitForQueueEntry(harness.queue);
        const original = await readConnectEntry(harness.queueEntries);
        const resilience = createResilience();
        await expect.poll(async () => {
            await harness.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
            return await harness.queue.getItem(original.key);
        }).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } });

        await expect(pending).resolves.toMatchObject({ right: { commandId: expect.any(String) } });
        expect(capture).toHaveBeenCalledTimes(1);
        const completed = await harness.queue.getItem(original.key);
        expect(readPersistedAuthority(completed!)).toEqual(firstAttemptAuthority);
        expect(firstAttemptAuthority).toMatchObject({ queueResourceId: expect.stringMatching(/^g-/) });
    });
});

class CountingRuntimeStateRepository extends FakeRuntimeStateRepository {
    readCount = 0;

    override findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        this.readCount += 1;
        return super.findEntry(namespace, key);
    }

    override findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        this.readCount += 1;
        return super.findAllEntries(namespace);
    }

    override readRuntimeStateBatch(
        input: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        this.readCount += 1;
        return super.readRuntimeStateBatch(input);
    }

    override findEntriesByPrefix(namespace: string, keyPrefix: string): Promise<readonly RuntimeStateEntry[]> {
        this.readCount += 1;
        return super.findEntriesByPrefix(namespace, keyPrefix);
    }

    override findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntry[]> {
        this.readCount += 1;
        return super.findEntriesByPrefixPage(namespace, keyPrefix, options);
    }

    override findEntriesByKeys(namespace: string, keys: readonly string[]): Promise<readonly RuntimeStateEntry[]> {
        this.readCount += 1;
        return super.findEntriesByKeys(namespace, keys);
    }
}

async function readConnectEntry(
    queueEntries: () => Promise<readonly ResourceEntry[]>
): Promise<ResourceEntry> {
    const entry = (await queueEntries()).find((candidate) => candidate.key.resourceId === 'connect-alice');
    if (entry === undefined) {
        throw new Error('Expected the queued presence connect entry');
    }
    return entry;
}

function readPersistedAuthority(entry: ResourceEntry): JsonWireValue {
    const message = JSON.parse(entry.resource) as { payload: { resource: string; }; };
    const enqueue = JSON.parse(message.payload.resource) as { authority: JsonWireValue; };
    return enqueue.authority;
}
