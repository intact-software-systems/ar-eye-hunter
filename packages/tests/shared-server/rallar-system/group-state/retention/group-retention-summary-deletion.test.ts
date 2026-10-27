import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { PRESENCE_SUMMARIES_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { ResourceInboxHandlerRetryableConflict } from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';

import { createGroupDeltaProducer, type GroupDeltaProducerFixture } from '../presence/group-delta-producer-fixture.ts';
import {
    commitRetention,
    createRetentionDatabaseFixture,
    type RetentionDatabaseFixture
} from './group-retention-database-fixture.ts';

let fixture: RetentionDatabaseFixture | undefined;
afterEach(async () => {
    await fixture?.storage.close();
    fixture = undefined;
    vi.restoreAllMocks();
});

describe('retirement fences queued presence summaries', () => {
    it('fences a missing-summary insertion between the authority and child inventory reads', async () => {
        fixture = await createRetentionDatabaseFixture();
        const producer = await createGroupDeltaProducer(fixture.storage.sql);
        await archiveProducer(fixture, producer);
        await fixture.runtime.deleteByKey(PRESENCE_SUMMARIES_NAMESPACE, groupStateGroupStorageKey(producer.ref));
        const repository = fixture.repository;
        const readAuthority = repository.readPresenceSummaryEntries.bind(repository);
        const readChildren = repository.readRetirementEntries.bind(repository);
        const inserted = Promise.withResolvers<void>();
        let inventoryStarted = false;
        vi.spyOn(repository, 'readRetirementEntries').mockImplementationOnce(async (ref) => {
            inventoryStarted = true;
            const children = await readChildren(ref);
            await producer.worker.processReservedEntry(producer.message, producer.entry);
            inserted.resolve();
            return children;
        });
        vi.spyOn(repository, 'readPresenceSummaryEntries').mockImplementationOnce(async (ref) => {
            // If child inventory starts independently, force it to miss the summary before authority reads its successor.
            await Promise.resolve();
            if (inventoryStarted) {
                await inserted.promise;
            }
            return await readAuthority(ref);
        });
        const ingress = fixture.retention.capture({
            groupRef: producer.ref,
            requestId: 'delete-read-race',
            observedAtEpochMs: fixture.nowEpochMs
        });
        const computed = fixture.retention.compute(
            await fixture.retention.read(ingress, { attemptCount: 1, traceId: 'trace-group-retention-summary-deletion' })
        );
        expect(await repository.findPresenceSummaryEntry(producer.ref)).toBeDefined();

        await expect(commitRetention(fixture, computed)).rejects.toMatchObject({ code: 'runtime-state-write-conflict' });
        const retry = fixture.retention.compute(await fixture.retention.read(ingress, { attemptCount: 2, traceId: 'trace-group-retention-summary-deletion' }));
        await commitRetention(fixture, retry);
        expect(await repository.findGroup(producer.ref)).toBeUndefined();
        expect(await repository.findPresenceSummaryEntry(producer.ref)).toBeUndefined();
        expect((await repository.listEvents(producer.ref)).filter((event) => event.eventType === 'group-deleted')).toHaveLength(1);
    }, 30_000);

    it.each(['summary-first', 'overlap'] as const)('converges summary and deletion with %s transactions', async (order) => {
        fixture = await createRetentionDatabaseFixture();
        const producer = await createGroupDeltaProducer(fixture.storage.sql);
        await archiveProducer(fixture, producer);
        const ingress = fixture.retention.capture({ groupRef: producer.ref, requestId: 'delete-summary-race', observedAtEpochMs: fixture.nowEpochMs });
        const computed = fixture.retention.compute(
            await fixture.retention.read(ingress, { attemptCount: 1, traceId: 'trace-group-retention-summary-deletion' })
        );
        const current = fixture;
        if (order === 'summary-first') {
            await producer.worker.processReservedEntry(producer.message, producer.entry);
            await expect(commitRetention(fixture, computed)).rejects.toMatchObject({ code: 'runtime-state-write-conflict' });
        }
        else {
            const readDone = Promise.withResolvers<void>();
            const read = producer.worker.read.bind(producer.worker);
            vi.spyOn(producer.worker, 'read').mockImplementationOnce(async (items, now) => {
                const observed = await read(items, now);
                readDone.resolve();
                return observed;
            });
            const outcomes = await Promise.allSettled([
                producer.worker.processReservedEntry(producer.message, producer.entry),
                readDone.promise.then(() => commitRetention(current, computed))
            ]);
            expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
            if (outcomes[1].status === 'fulfilled') {
                expect(outcomes[0].status === 'rejected' || outcomes[0].value instanceof ResourceInboxHandlerRetryableConflict).toBe(true);
            }
        }
        const retry = fixture.retention.compute(await fixture.retention.read(ingress, { attemptCount: 2, traceId: 'trace-group-retention-summary-deletion' }));
        await commitRetention(fixture, retry);
        expect(await fixture.repository.findGroup(producer.ref)).toBeUndefined();
        expect(await fixture.repository.findPresenceSummaryEntry(producer.ref)).toBeUndefined();
        expect((await fixture.repository.listEvents(producer.ref)).filter((event) => event.eventType === 'group-deleted')).toHaveLength(1);
    }, 30_000);

    it.each(['missing', 'present'] as const)('prevents a delayed %s summary from recreating deleted state and settles its retry', async (summary) => {
        fixture = await createRetentionDatabaseFixture();
        const producer = await createGroupDeltaProducer(fixture.storage.sql);
        await archiveProducer(fixture, producer);
        if (summary === 'missing') {
            await fixture.runtime.deleteByKey(PRESENCE_SUMMARIES_NAMESPACE, groupStateGroupStorageKey(producer.ref));
        }
        const ingress = fixture.retention.capture({ groupRef: producer.ref, requestId: 'delete-summary-race', observedAtEpochMs: fixture.nowEpochMs });
        const computed = fixture.retention.compute(
            await fixture.retention.read(ingress, { attemptCount: 1, traceId: 'trace-group-retention-summary-deletion' })
        );
        expect(computed.outcome).toBe('write');
        const read = producer.worker.read.bind(producer.worker);
        const current = fixture;
        vi.spyOn(producer.worker, 'read').mockImplementationOnce(async (items, now) => {
            const observed = await read(items, now);
            await commitRetention(current, computed);
            return observed;
        });

        expect(await producer.worker.processReservedEntry(producer.message, producer.entry)).toBeInstanceOf(ResourceInboxHandlerRetryableConflict);
        expect(await fixture.repository.findPresenceSummaryEntry(producer.ref)).toBeUndefined();
        expect(await fixture.repository.findGroup(producer.ref)).toBeUndefined();
        await expect(producer.worker.processReservedEntry(producer.message, producer.entry)).resolves.toBeUndefined();
        expect(await fixture.repository.findPresenceSummaryEntry(producer.ref)).toBeUndefined();
    }, 30_000);
});

async function archiveProducer(fixture: RetentionDatabaseFixture, producer: GroupDeltaProducerFixture): Promise<void> {
    const stored = await fixture.repository.findGroupEntry(producer.ref);
    if (!stored) {
        throw new Error('Producer room missing');
    }
    await fixture.repository.updateGroup({
        ...stored.value,
        status: 'archived',
        deleted: null,
        archived: { ...stored.value.updated, atEpochMs: fixture.nowEpochMs - 604800000 },
        metadata: { rallarRetention: { mode: 'temporary', reconnectGraceMs: 1000, emptyPresenceFingerprint: null } },
        snapshotVersion: stored.value.snapshotVersion + 1
    }, stored.entry.revision);
}
