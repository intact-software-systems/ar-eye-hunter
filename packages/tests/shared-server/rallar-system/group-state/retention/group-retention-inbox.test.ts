import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it } from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { createAppInboxRetryFinalizer } from '@shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts';
import { writeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { GroupRetentionService } from '@shared-server/rallar-system/group-state/retention/group-retention-service.ts';
import type { RallarTimingEvent, RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createAppInboxTestResilience } from '../../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createRetentionDatabaseFixture, RETENTION_REF, seedRetentionRoom, type RetentionDatabaseFixture } from './group-retention-database-fixture.ts';

let fixture: RetentionDatabaseFixture | undefined;
afterEach(async () => {
    await fixture?.storage.close();
    fixture = undefined;
});

describe('retention through the registered AppInbox capability', () => {
    it('atomically persists its exact result and replays it after later archival without duplicate effects', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const timings: RallarTimingEvent[] = [];
        const { inbox, reader, results } = createInbox(fixture, fixture.retention, (event) => timings.push(event));
        const command = { groupRef: RETENTION_REF, requestId: 'first-scan', observedAtEpochMs: fixture.nowEpochMs };
        const entry = await inbox.enqueueGroupRetention(command);
        expect((await fixture.repository.findGroup(RETENTION_REF))?.emptySinceEpochMs).toBeNull();
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        const accepted = await results.findByKey(entry.key);
        expect(accepted?.status).toBe(EntityStatus.COMPLETED);
        expect(JSON.parse(accepted?.resource ?? 'null')).toMatchObject({ groupRef: RETENTION_REF, receipt: { outcome: 'applied', attemptCount: 1 } });
        expect((await fixture.repository.findGroup(RETENTION_REF))?.emptySinceEpochMs).toBe(fixture.nowEpochMs);
        const phases = timings.filter((event) => event.component === 'group-retention');
        expect(phases.map((event) => event.operation)).toEqual(['read', 'compute', 'validate', 'write']);
        for (const phase of phases) {
            expect(phase).toMatchObject({
                ...RETENTION_REF,
                serviceId: 'retention-inbox-test',
                requestId: command.requestId,
                status: 'ok',
                details: { attempt: 1 }
            });
            expect(phase.durationMs).toBeGreaterThanOrEqual(0);
        }
        const transactionTiming = timings.findIndex((event) => event.component === 'app-inbox-phase' && event.operation === 'transaction');
        const writeTiming = timings.findIndex((event) => event.component === 'group-retention' && event.operation === 'write');
        expect(transactionTiming).toBeGreaterThanOrEqual(0);
        expect(writeTiming).toBeGreaterThan(transactionTiming);
        expect(timings[writeTiming].durationMs).toBeGreaterThanOrEqual(timings[transactionTiming].durationMs);

        fixture.nowEpochMs += 1_000;
        const archiveEntry = await inbox.enqueueGroupRetention({ ...command, requestId: 'archive-scan', observedAtEpochMs: fixture.nowEpochMs });
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await results.findByKey(archiveEntry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect((await fixture.repository.findGroup(RETENTION_REF))?.status).toBe('archived');
        const events = await fixture.repository.listEvents(RETENTION_REF);
        const replay = await inbox.enqueueGroupRetention(command);
        expect(replay.key).toEqual(entry.key);
        expect((await results.findByKey(entry.key))?.resource).toBe(accepted?.resource);
        expect(await fixture.repository.listEvents(RETENTION_REF)).toEqual(events);
        await expect(inbox.enqueueGroupRetention({ ...command, observedAtEpochMs: fixture.nowEpochMs })).rejects.toMatchObject({ status: 409 });
    }, 30_000);

    it('keeps identical scan identifiers isolated by the complete room scope', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const { inbox, reader, results } = createInbox(fixture);
        const command = { requestId: 'shared-scan', observedAtEpochMs: fixture.nowEpochMs };
        const actual = await inbox.enqueueGroupRetention({ ...command, groupRef: RETENTION_REF });
        const absentRef = { ...RETENTION_REF, workspaceId: 'other-workspace' };
        const absent = await inbox.enqueueGroupRetention({ ...command, groupRef: absentRef });
        expect(actual.key).not.toEqual(absent.key);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect(JSON.parse((await results.findByKey(absent.key))?.resource ?? 'null')).toEqual({ groupRef: absentRef, receipt: null });
        expect((await results.findByKey(actual.key))?.status).toBe(EntityStatus.COMPLETED);
    }, 30_000);

    it.each([1, 20])('reenters from fresh authority after %i real conditional conflicts', async (conflicts) => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const current = fixture;
        let reads = 0;
        const retention = new GroupRetentionService({
            repository: {
                findIdempotentGroupMutationReceipt: (ref, id) => current.repository.findIdempotentGroupMutationReceipt(ref, id),
                readPresenceSummaryEntries: async (ref) => {
                    const read = await current.repository.readPresenceSummaryEntries(ref);
                    reads += 1;
                    if (reads <= conflicts && read.status === 'stable' && read.group) {
                        await current.repository.updateGroup({
                            ...read.group.value,
                            displayName: `Concurrent edit ${reads}`,
                            snapshotVersion: read.group.value.snapshotVersion + 1
                        }, read.group.entry.revision);
                    }
                    return read;
                }
            }
        }, { serviceId: 'retention-test', now: () => current.nowEpochMs });
        const timings: RallarTimingEvent[] = [];
        const { inbox, reader, results, queue } = createInbox(current, retention, (event) => timings.push(event));
        const entry = await inbox.enqueueGroupRetention({ groupRef: RETENTION_REF, requestId: 'conflicted-scan', observedAtEpochMs: current.nowEpochMs });
        const resilience = createAppInboxTestResilience(0);
        for (let delivery = 0; delivery < (conflicts === 1 ? 2 : 20); delivery++) {
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        }
        const result = await results.findByKey(entry.key);
        expect((await queue.getItem(entry.key))?.resource).toBe(entry.resource);
        expect(reads).toBe(conflicts === 1 ? 2 : 20);
        const writes = timings.filter((event) => event.component === 'group-retention' && event.operation === 'write');
        expect(writes.map((event) => event.details?.attempt)).toEqual(Array.from({ length: reads }, (_, index) => index + 1));
        expect(writes.filter((event) => event.status === 'error')).toHaveLength(conflicts);
        expect(writes[0].error?.message).toContain('conflict');
        const group = await current.repository.findGroup(RETENTION_REF);
        expect(group?.displayName).toBe(`Concurrent edit ${conflicts}`);
        if (conflicts === 1) {
            expect(result?.status).toBe(EntityStatus.COMPLETED);
            expect(JSON.parse(result?.resource ?? 'null')).toMatchObject({ receipt: { outcome: 'applied', attemptCount: 2 } });
            expect(group?.emptySinceEpochMs).toBe(current.nowEpochMs);
        }
        else {
            expect(result?.status).toBe(EntityStatus.FAILED);
            expect(JSON.parse(result?.resource ?? 'null')).toMatchObject({ code: 'app-inbox-retry-exhausted', retry: { attempts: 20 } });
            expect(group?.emptySinceEpochMs).toBeNull();
        }
    }, 30_000);

    it.each(['outbox', 'result'] as const)('rolls back every domain effect when the final %s write fails', async (fault) => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const timings: RallarTimingEvent[] = [];
        const { inbox, reader, results } = createInbox(fixture, fixture.retention, (event) => timings.push(event));
        const command = { groupRef: RETENTION_REF, requestId: `failed-${fault}`, observedAtEpochMs: fixture.nowEpochMs };
        const ingress = fixture.retention.capture(command);
        const computed = fixture.retention.compute(await fixture.retention.read(ingress, 1));
        if (computed.outcome !== 'write') {
            throw new Error('Expected an observation write');
        }
        if (fault === 'outbox') {
            await fixture.storage.sql.begin((transaction) => writeAppOutboxInsert(transaction, computed.outboxWrites[0]));
        }
        else {
            await fixture.storage.sql`alter table resource_inbox_results add constraint fail_success_result check (ris_status <> 'COMPLETED')`;
        }
        const before = await fixture.repository.readPresenceSummaryEntries(RETENTION_REF);
        const events = await fixture.repository.listEvents(RETENTION_REF);
        const outbox = await fixture.storage
            .sql`select ri_resource_id, ri_resource from resource_inbox where ri_type_id <> 'APP_INBOX' order by ri_resource_id`;
        const entry = await inbox.enqueueGroupRetention(command);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));

        expect(await fixture.repository.readPresenceSummaryEntries(RETENTION_REF)).toEqual(before);
        expect(await fixture.repository.listEvents(RETENTION_REF)).toEqual(events);
        expect(await fixture.repository.findIdempotentGroupMutationReceipt(RETENTION_REF, ingress.commandId)).toBeUndefined();
        expect(await fixture.storage.sql`select ri_resource_id, ri_resource from resource_inbox where ri_type_id <> 'APP_INBOX' order by ri_resource_id`)
            .toEqual(outbox);
        expect((await results.findByKey(entry.key))?.status).not.toBe(EntityStatus.COMPLETED);
        expect(timings.find((event) => event.component === 'group-retention' && event.operation === 'write')?.status)
            .toBe('error');
        expect(timings.find((event) => event.component === 'app-inbox-phase' && event.operation === 'transaction')?.status)
            .toBe('error');
    }, 30_000);
});

function createInbox(fixture: RetentionDatabaseFixture, retention = fixture.retention, timing?: RallarTimingSink) {
    const resources = createPSqlResourceInboxRepository(fixture.storage.sql, () => new Date(fixture.nowEpochMs));
    const queue = new PSqlQueueBox(resources, () => Temporal.Instant.fromEpochMilliseconds(fixture.nowEpochMs));
    const reader = new InboxQueueReader(queue, {
        newLaneConcurrency: 1,
        nowEpochMs: () => fixture.nowEpochMs,
        onRetryExhausted: createAppInboxRetryFinalizer({ database: fixture.storage.sql })
    });
    const results = new ResourceInboxResultsRepository(fixture.storage.sql);
    const inbox = new GroupStateInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: resources.entries,
        resourceInboxResultsRepository: results,
        database: fixture.storage.sql,
        groupStateService: { ...fixture.mutations, retention },
        resultReader: fixture.repository
    }, { serviceId: 'retention-inbox-test', timing, options: { nowEpochMs: () => fixture.nowEpochMs } });
    return { inbox, reader, results, queue };
}
