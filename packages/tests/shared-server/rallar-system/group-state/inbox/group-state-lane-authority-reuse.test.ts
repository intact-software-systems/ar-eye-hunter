import { describe, expect, expectTypeOf, it } from 'vitest';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { toGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type {
    RuntimeStateGuardedBatchResult,
    RuntimeStateGuardedBatchWrite
} from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type {
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions
} from '@shared-server/runtime-state/runtime-state-repository.ts';
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

/**
 * Runtime-state reads the route's authorization performs before enqueue: one
 * session read that verifies the bearer credential against storage, no causal
 * revision read and no persisted capture; the lane reads the causal revision
 * and persists the ingress itself. The REST route's bearer lookup reads the
 * session as well; this read stays so a direct service caller gets the same
 * credential check.
 */
const ROUTE_RUNTIME_STATE_READS_PER_AUTHORIZATION = 1;

const GROUP_ID = 'authority-reuse-room';

describe('group mutation lane authority reuse', () => {
    it('authorizes a route mutation with one session read and nothing persisted', async () => {
        const runtimeRepository = new CountingRuntimeStateRepository();
        const harness = await createAuthorityHarness(['owner', 'alice'], { runtimeRepository });
        await createRoom(harness, GROUP_ID, 'Authority reuse room');
        const descriptor = toGroupMutationDescriptor(presenceConnectEnqueue(GROUP_ID, 'alice', harness.nowEpochMs));
        runtimeRepository.readCount = 0;
        runtimeRepository.writeCount = 0;

        const authorized = await harness.groupStateService.authorizeMutation(descriptor, harness.sessions.alice);

        expect(runtimeRepository.readCount).toBe(ROUTE_RUNTIME_STATE_READS_PER_AUTHORIZATION);
        expect(runtimeRepository.writeCount).toBe(0);
        expect(authorized.authorityProof).toMatchObject({
            version: 1,
            principalId: 'alice',
            sessionId: 'alice-session',
            sessionIssuedAtEpochMs: harness.sessions.alice.issuedAtEpochMs,
            sessionExpiresAtEpochMs: harness.sessions.alice.expiresAtEpochMs,
            commandMac: expect.stringMatching(/^[0-9a-f]{64}$/)
        });
        expect(authorized.descriptor.request).toMatchObject({ actorPrincipalId: 'alice', actorSessionId: 'alice-session' });
    });

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

    it('accepts the route proof only through the AppInbox capture', async () => {
        const harness = await createAuthorityHarness(['owner']);

        expectTypeOf(harness.groupStateService.captureMutationIngress).parameter(1).toEqualTypeOf<IssuedAuthSession>();
        expectTypeOf(harness.groupStateService.captureAppInboxMutationIngress).parameter(1).not.toEqualTypeOf<IssuedAuthSession>();
    });

    it('keeps the captured queue identity and authority across a redelivery', async () => {
        const harness = await createAuthorityHarness(['owner', 'alice']);
        await createRoom(harness, GROUP_ID, 'Authority reuse room');
        await activateMember(harness, GROUP_ID, 'alice');
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
        const completed = await harness.queue.getItem(original.key);
        expect(readPersistedAuthority(completed!)).toEqual(firstAttemptAuthority);
        expect(firstAttemptAuthority).toMatchObject({ queueResourceId: expect.stringMatching(/^g-/) });
    });
});

class CountingRuntimeStateRepository extends FakeRuntimeStateRepository {
    readCount = 0;
    writeCount = 0;

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

    override upsert(namespace: string, key: string, value: string, expireAtTimestamp: number): Promise<void> {
        this.writeCount += 1;
        return super.upsert(namespace, key, value, expireAtTimestamp);
    }

    override upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.writeCount += 1;
        return super.upsertIfRevision(namespace, key, value, expireAtTimestamp, expectedRevision);
    }

    override writeGuardedBatch(input: RuntimeStateGuardedBatchWrite): Promise<RuntimeStateGuardedBatchResult> {
        this.writeCount += 1;
        return super.writeGuardedBatch(input);
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
