import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { CoalescedAppOutboxWorkService } from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work-service.ts';
import { PSqlCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/psql-crdt-log-repository.ts';
import { createRtcTopologyOutboxPublisher } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { readPGliteDatabaseEpochMs } from './pglite-app-inbox-test-runtime.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';
import { CRDT_DOCUMENT_REF, createResourceEntry } from './pglite-queue-crdt-test-runtime.ts';
import { advanceCoalescedGeneration, topologyGroupSnapshotWithSessionIds } from './pglite-topology-test-runtime.ts';

const FUTURE_MS = Date.parse('9999-12-31T23:59:59.999Z');
const PAST_MS = Date.parse('2000-01-01T00:00:00.000Z');
const PAST_INSTANT = Temporal.Instant.from('2000-01-01T00:00:00.000Z');

interface StringCountRow {
    readonly count: string;
}

interface CreatedTimestampRow {
    readonly created_ts: string;
}

interface ExpireTimestampRow {
    readonly expire_ts: string;
}

interface StartTimestampRow {
    readonly start_ts: string;
}

interface EndTimestampRow {
    readonly end_ts: string;
}

Deno.test(
    'PSqlResourceInboxRepository and ResourceInboxResultsRepository run against PGlite SQL adapter',
    async () => {
        await withPGliteSql(async (sql) => {
            const inbox = createPSqlResourceInboxRepository(sql);
            const results = new ResourceInboxResultsRepository(sql);
            const active = createResourceEntry('active-1', {
                payload: { text: 'active' },
                typeId: 'TYPE_A'
            });
            const expired = createResourceEntry('expired-1', {
                payload: { text: 'expired' },
                typeId: 'TYPE_A',
                expiryTs: PAST_INSTANT
            });
            const exhausted = {
                ...createResourceEntry('exhausted-ordinary', {
                    payload: { text: 'exhausted ordinary' },
                    typeId: 'TYPE_EXHAUSTED'
                }),
                dequeueAudit: { attempts: 2 }
            };
            const exhaustedTimeout = {
                ...createResourceEntry('exhausted-timeout', {
                    payload: { text: 'exhausted timeout' },
                    typeId: 'TYPE_EXHAUSTED_TIMEOUT'
                }),
                status: EntityStatus.RESERVED,
                dequeueAudit: {
                    attempts: 2,
                    startTs: Temporal.Instant.from('2020-01-01T00:00:00Z')
                }
            };

            const stored = await inbox.entries.write(active);
            assert.ok(stored.db?.id);
            await inbox.entries.write(expired);
            await inbox.entries.write(exhausted);
            await inbox.entries.write(exhaustedTimeout);
            assert.equal(
                await inbox.reservations.isEntriesToLock(
                    new Set([exhausted.typeId]),
                    new Set([EntityStatus.NEW]),
                    2
                ),
                false
            );
            assert.equal(
                await inbox.reservations.isEntriesToLock(
                    new Set([exhausted.typeId]),
                    new Set([EntityStatus.NEW])
                ),
                true
            );
            assert.equal(
                await inbox.reservations.isTimeoutOnReservedEntries(
                    new Set([exhaustedTimeout.typeId]),
                    Temporal.Duration.from({ seconds: 1 }),
                    2
                ),
                false
            );
            assert.equal(
                await inbox.reservations.isTimeoutOnReservedEntries(
                    new Set([exhaustedTimeout.typeId]),
                    Temporal.Duration.from({ seconds: 1 })
                ),
                true
            );
            const databaseClockTimeout = {
                ...createResourceEntry('database-clock-timeout', {
                    payload: { text: 'database clock timeout' },
                    typeId: 'TYPE_DATABASE_CLOCK_TIMEOUT'
                }),
                status: EntityStatus.RESERVED,
                dequeueAudit: {
                    attempts: 1,
                    startTs: Temporal.Instant.from('2020-01-01T00:00:00Z')
                }
            };
            await inbox.entries.write(databaseClockTimeout);
            await sql`
      update resource_inbox
      set start_ts = (now() - interval '29 seconds') at time zone 'UTC'
      where ri_topic_id = ${databaseClockTimeout.key.topicId}
        and ri_resource_id = ${databaseClockTimeout.key.resourceId}
        and fk_ext_bank_id = ${databaseClockTimeout.key.contextId}
    `;
            const originalDateNow = Date.now;
            Date.now = () => Date.parse('1900-01-01T00:00:00Z');
            try {
                assert.equal(
                    (await inbox.transaction((transactionInbox) =>
                        transactionInbox.reservations.findTimedOutReservedEntriesSkipLocked(
                            new Set([databaseClockTimeout.typeId]),
                            30_000,
                            { maxToReserve: 1, maxAttempts: 2 }
                        )
                    )).size,
                    0
                );
                await sql`
        update resource_inbox
        set start_ts = (now() - interval '31 seconds') at time zone 'UTC'
        where ri_topic_id = ${databaseClockTimeout.key.topicId}
          and ri_resource_id = ${databaseClockTimeout.key.resourceId}
          and fk_ext_bank_id = ${databaseClockTimeout.key.contextId}
      `;
                assert.equal(
                    (await inbox.transaction((transactionInbox) =>
                        transactionInbox.reservations.findTimedOutReservedEntriesSkipLocked(
                            new Set([databaseClockTimeout.typeId]),
                            30_000,
                            { maxToReserve: 1, maxAttempts: 2 }
                        )
                    )).size,
                    1
                );
            }
            finally {
                Date.now = originalDateNow;
            }

            const immutable = {
                ...createResourceEntry('immutable-replay', {
                    payload: { text: 'immutable' },
                    typeId: 'APP_OUTBOX',
                    expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000001Z')
                }),
                audit: {
                    ...createResourceEntry('immutable-replay').audit,
                    createdTs: Temporal.PlainDateTime.from('2026-06-01T12:00:00.000001'),
                    expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000001Z')
                }
            };
            assert.equal(await inbox.entries.writeIfAbsentOrMatch(immutable), 'inserted');
            assert.equal(await inbox.entries.writeIfAbsentOrMatch(immutable), 'matched');
            await assert.rejects(
                () =>
                    inbox.entries.writeIfAbsentOrMatch({
                        ...immutable,
                        audit: {
                            ...immutable.audit,
                            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.000002Z')
                        }
                    }),
                ResourceInboxInvariantCorruptionError
            );

            const timestampRoundingCases = [
                ['below-half', '0000004', '12:00:00'],
                ['half-even-down', '0000005', '12:00:00'],
                ['half-even-up', '0000015', '12:00:00.000002'],
                ['above-half', '0000006', '12:00:00.000001'],
                ['second-rollover', '9999995', '12:00:01']
            ] as const;
            for (const [scenario, fraction, expectedTime] of timestampRoundingCases) {
                const creationBase = createResourceEntry(`round-created-${scenario}`, {
                    payload: { scenario },
                    typeId: 'APP_OUTBOX',
                    expiryTs: Temporal.Instant.from('9999-12-31T23:59:59Z')
                });
                const creationEntry = {
                    ...creationBase,
                    audit: {
                        ...creationBase.audit,
                        createdTs: Temporal.PlainDateTime.from(
                            `2026-06-01T12:00:00.${fraction}`
                        )
                    }
                };
                assert.equal(await inbox.entries.writeIfAbsentOrMatch(creationEntry), 'inserted');
                const creationRows = await sql<CreatedTimestampRow[]>`
        select created_ts::text as created_ts
        from resource_inbox
        where ri_topic_id = ${creationEntry.key.topicId}
          and ri_resource_id = ${creationEntry.key.resourceId}
          and fk_ext_bank_id = ${creationEntry.key.contextId}
      `;
                assert.equal(
                    creationRows[0]?.created_ts,
                    `2026-06-01 ${expectedTime}`
                );
                assert.equal(await inbox.entries.writeIfAbsentOrMatch(creationEntry), 'matched');

                const expiryEntry = createResourceEntry(`round-expiry-${scenario}`, {
                    payload: { scenario },
                    typeId: 'APP_OUTBOX',
                    expiryTs: Temporal.Instant.from(`9998-06-01T12:00:00.${fraction}Z`)
                });
                assert.equal(await inbox.entries.writeIfAbsentOrMatch(expiryEntry), 'inserted');
                const expiryRows = await sql<ExpireTimestampRow[]>`
        select expire_ts::text as expire_ts
        from resource_inbox
        where ri_topic_id = ${expiryEntry.key.topicId}
          and ri_resource_id = ${expiryEntry.key.resourceId}
          and fk_ext_bank_id = ${expiryEntry.key.contextId}
      `;
                assert.equal(
                    expiryRows[0]?.expire_ts,
                    `9998-06-01 ${expectedTime}`
                );
                assert.equal(await inbox.entries.writeIfAbsentOrMatch(expiryEntry), 'matched');
            }

            assert.equal((await inbox.entries.findByKey(active.key))?.key.resourceId, 'active-1');
            assert.equal(await inbox.entries.findByKey(expired.key), null);
            assert.equal(
                await inbox.reservations.isEntriesToLock(
                    new Set(['TYPE_A']),
                    new Set([EntityStatus.NEW])
                ),
                true
            );

            const locked = await inbox.transaction((txInbox) =>
                txInbox.reservations.findEntriesSkipLocked(
                    new Set(['TYPE_A']),
                    new Set([EntityStatus.NEW]),
                    10
                )
            );
            assert.equal(locked.size, 1);
            assert.equal([...locked.values()][0].key.resourceId, 'active-1');

            const reserved = await inbox.reservations.startProcessingEntity(active);
            assert.equal(reserved.right?.status, EntityStatus.RESERVED);
            assert.equal(reserved.right?.dequeueAudit.attempts, 1);
            assert.equal(await inbox.entries.writeIfAbsentOrMatch(active), 'matched');

            const reservedStartRows = await sql<StartTimestampRow[]>`
      select start_ts::text as start_ts
      from resource_inbox
      where ri_topic_id = ${active.key.topicId}
        and ri_resource_id = ${active.key.resourceId}
        and fk_ext_bank_id = ${active.key.contextId}
    `;
            const reservedStartText = reservedStartRows[0]?.start_ts;
            assert.ok(reservedStartText);
            const reservedStartTs = Temporal.Instant.from(
                `${reservedStartText.replace(' ', 'T')}Z`
            );
            assert.equal(
                reserved.right?.dequeueAudit.startTs?.toString(),
                reservedStartTs.toString()
            );
            const releasedAt = Temporal.Instant.fromEpochMilliseconds(
                Number(reservedStartTs.epochMilliseconds) + 123
            );
            assert.equal(
                await inbox.reservations.releaseReserved(active.key, {
                    expectedAttempts: 2,
                    releasedAt,
                    disposition: { status: EntityStatus.COMPLETED, delayMs: null }
                }),
                null
            );
            const released = await inbox.reservations.releaseReserved(active.key, {
                expectedAttempts: 1,
                releasedAt,
                disposition: { status: EntityStatus.COMPLETED, delayMs: null }
            });
            const releaseRows = await sql<EndTimestampRow[]>`
      select end_ts::text as end_ts
      from resource_inbox
      where ri_topic_id = ${active.key.topicId}
        and ri_resource_id = ${active.key.resourceId}
        and fk_ext_bank_id = ${active.key.contextId}
    `;
            assert.equal(
                releaseRows[0]?.end_ts,
                releasedAt.toString().replace('T', ' ').replace(/Z$/u, '')
            );
            assert.equal(released?.dequeueAudit.endTs?.toString(), releasedAt.toString());
            assert.equal(released?.dequeueAudit.nextTs, undefined);
            assert.equal((await inbox.entries.findByKey(active.key))?.status, EntityStatus.COMPLETED);
            assert.equal(await inbox.entries.writeIfAbsentOrMatch(active), 'matched');

            const batchFirst = createResourceEntry('release-batch-first', {
                payload: { text: 'first' },
                typeId: 'TYPE_A'
            });
            const batchSecond = createResourceEntry('release-batch-second', {
                payload: { text: 'second' },
                typeId: 'TYPE_A'
            });
            await inbox.entries.write(batchFirst);
            await inbox.entries.write(batchSecond);
            const firstReservation = await inbox.reservations.startProcessingEntity(batchFirst);
            const secondReservation = await inbox.reservations.startProcessingEntity(batchSecond);
            assert.ok(firstReservation.right);
            assert.ok(secondReservation.right);
            const queueBox = new PSqlQueueBox(inbox);
            await assert.rejects(
                () =>
                    queueBox.releaseEntries([
                        firstReservation.right!,
                        {
                            ...secondReservation.right!,
                            dequeueAudit: {
                                ...secondReservation.right!.dequeueAudit,
                                attempts: 0
                            }
                        }
                    ], { status: EntityStatus.COMPLETED, delayMs: null }),
                (error) =>
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'resource-inbox-lost-reservation'
            );
            assert.equal((await inbox.entries.findByKey(batchFirst.key))?.status, EntityStatus.RESERVED);
            assert.equal((await inbox.entries.findByKey(batchSecond.key))?.status, EntityStatus.RESERVED);
            assert.equal(await inbox.maintenance.deleteExpired(), 1);

            const resultEntry = createResourceEntry('result-1', {
                topicId: 'result-topic',
                typeId: 'RESULT',
                status: EntityStatus.COMPLETED,
                payload: { text: 'result' }
            });
            const activeResult = await results.writeIfAbsentOrReplaceExpired(resultEntry);
            assert.equal(activeResult.key.resourceId, 'result-1');

            const replacedResult = await results.replace(
                createResourceEntry('result-1', {
                    topicId: 'result-topic',
                    typeId: 'RESULT',
                    status: EntityStatus.FAILED,
                    payload: { text: 'result-updated' }
                })
            );
            assert.equal(replacedResult.status, EntityStatus.FAILED);
            assert.deepEqual(JSON.parse(replacedResult.resource), { text: 'result-updated' });

            await results.replace(
                createResourceEntry('result-expired', {
                    topicId: 'result-topic',
                    typeId: 'RESULT',
                    status: EntityStatus.COMPLETED,
                    expiryTs: PAST_INSTANT
                })
            );
            assert.equal(await results.deleteExpired(), 1);
            assert.equal(await inbox.entries.deleteByKey(active.key), true);
        });
    }
);

Deno.test(
    'Coalesced APP_OUTBOX RTC topology work fits the durable resource inbox key columns',
    async () => {
        await withPGliteSql(async (sql) => {
            const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql));
            const service = new CoalescedAppOutboxWorkService(
                new OutboxQueueReader(queue),
                'rallar-server-instance-with-a-long-identity',
                () => 500
            );
            const groupId = 'rallar-bb-group-chromium-w0-configured-live-distributed-run-1234567890';
            const overlayId = JSON.stringify(['rallar-server', 'default', groupId]);
            const contextId = `rallar-server:default:${groupId}`;

            const result = await service.enqueue({
                type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
                topicId: 'app-outbox.rtc-topology',
                resourceId: overlayId,
                contextId,
                data: { overlayId }
            });
            const updated = await service.enqueue({
                type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
                topicId: 'app-outbox.rtc-topology',
                resourceId: overlayId,
                contextId,
                data: { overlayId, revision: 2 },
                reason: 'rtt'
            });
            const stored = await queue.getItem(updated.entry.key);
            const rowCount = await sql<StringCountRow[]>`
      select count(*) as count
      from resource_inbox
      where fk_ext_bank_id = ${updated.entry.key.contextId}
        and ri_resource_id = ${updated.entry.key.resourceId}
        and ri_topic_id = ${updated.entry.key.topicId}
    `;

            assert.ok(stored);
            assert.equal(stored.typeId, 'APP_OUTBOX');
            assert.equal(result.action, 'inserted');
            assert.equal(updated.action, 'updated');
            assert.equal(Number(rowCount[0].count), 1);
            assert.ok(stored.key.topicId.length <= 36);
            assert.ok(stored.key.resourceId.length <= 36);
            assert.ok(stored.key.contextId.length <= 35);
            assert.ok(stored.audit.createdBy.length <= 16);
            assert.deepEqual(service.readEnvelope(stored), updated.envelope);
            assert.equal(updated.envelope.resourceId, overlayId);
            assert.equal(updated.envelope.contextId, contextId);
            assert.equal(updated.envelope.data.revision, 2);
        });
    }
);

Deno.test(
    'transaction-bound APP_OUTBOX coalescing fences generation and reserved work',
    async () => {
        await withPGliteSql(async (sql) => {
            const repository = createPSqlResourceInboxRepository(sql);
            const queue = new PSqlQueueBox(repository);
            const service = new CoalescedAppOutboxWorkService(
                new OutboxQueueReader(queue),
                'rallar-server',
                () => 500
            );
            const first = (await service.enqueue({
                type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
                topicId: 'app-outbox.rtc-topology',
                resourceId: 'transactional-overlay',
                contextId: 'transactional-room',
                data: { overlayId: 'transactional-overlay', revision: 1 }
            })).entry;
            const second = advanceCoalescedGeneration(first, 2);
            const successor = createResourceEntry('transactional-successor', {
                topicId: first.key.topicId,
                contextId: first.key.contextId,
                typeId: first.typeId,
                payload: { generation: 2, kind: 'successor' }
            });

            const statusFirst = (await service.enqueue({
                type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
                topicId: 'app-outbox.rtc-topology',
                resourceId: 'transactional-status-fence',
                contextId: 'transactional-room',
                data: { overlayId: 'transactional-status-fence', revision: 1 }
            })).entry;
            await repository.entries.writeIfAbsentOrMatch(statusFirst);
            await sql`
      update resource_inbox
      set ri_status = ${EntityStatus.RETRY}
      where ri_topic_id = ${statusFirst.key.topicId}
        and ri_resource_id = ${statusFirst.key.resourceId}
        and fk_ext_bank_id = ${statusFirst.key.contextId}
    `;
            const statusMismatch = await sql.begin(async (transaction) =>
                await createPSqlResourceInboxRepository(transaction).entries.replacePendingIfMatch(
                    statusFirst,
                    advanceCoalescedGeneration(statusFirst, 2),
                    1
                )
            );
            assert.equal(statusMismatch, null);
            assert.equal(
                (await repository.entries.findAnyByKey(statusFirst.key))?.status,
                EntityStatus.RETRY
            );

            const updated = await sql.begin(async (transaction) =>
                await service.write(transaction, {
                    expectedEntry: first,
                    entry: second,
                    successorEntry: successor
                })
            );
            assert.equal(updated.action, 'updated');
            assert.equal((await repository.entries.findByKey(first.key))?.resource, second.resource);

            const reserved = await queue.reserveEntries(
                new Set([first.typeId]),
                new Set([EntityStatus.NEW]),
                { maxToReserve: 1, maxAttempts: 20 }
            );
            assert.equal(reserved.size, 1);
            const observedReserved = [...reserved.values()][0];
            assert.ok(observedReserved);
            const third = advanceCoalescedGeneration(second, 3);
            const blocked = await sql.begin(async (transaction) =>
                await service.write(transaction, {
                    expectedEntry: observedReserved,
                    entry: third,
                    successorEntry: successor
                })
            );

            assert.equal(blocked.action, 'successor');
            assert.equal(blocked.blockedByReserved, true);
            assert.equal((await repository.entries.findAnyByKey(first.key))?.resource, second.resource);
            assert.equal((await repository.entries.findAnyByKey(first.key))?.status, EntityStatus.RESERVED);
            assert.equal((await repository.entries.findByKey(successor.key))?.resource, successor.resource);

            const replay = await sql.begin(async (transaction) =>
                await service.write(transaction, {
                    expectedEntry: observedReserved,
                    entry: third,
                    successorEntry: successor
                })
            );
            assert.equal(replay.action, 'successor');
            assert.equal((await repository.entries.findAnyByKey(first.key))?.resource, second.resource);
            assert.equal((await repository.entries.findAnyByKey(first.key))?.status, EntityStatus.RESERVED);
            assert.equal((await repository.entries.findByKey(successor.key))?.resource, successor.resource);

            await assert.rejects(
                async () => {
                    await sql.begin(async (transaction) =>
                        await service.write(transaction, {
                            expectedEntry: observedReserved,
                            entry: third,
                            successorEntry: {
                                ...successor,
                                resource: JSON.stringify({ different: true })
                            }
                        })
                    );
                },
                (error) =>
                    error instanceof ResourceInboxInvariantCorruptionError &&
                    error.code === 'resource-inbox-invariant-corruption'
            );
        });
    }
);

Deno.test('transaction-bound APP_OUTBOX coalescing revives finished work in place', async () => {
    await withPGliteSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql);
        const queue = new PSqlQueueBox(repository);
        const service = new CoalescedAppOutboxWorkService(
            new OutboxQueueReader(queue),
            'rallar-server',
            () => 500
        );
        const first = (await service.enqueue({
            type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
            topicId: 'app-outbox.rtc-topology',
            resourceId: 'revive-overlay',
            contextId: 'revive-room',
            data: { overlayId: 'revive-overlay', revision: 1 }
        })).entry;
        const reserved = await queue.reserveEntries(
            new Set([first.typeId]),
            new Set([EntityStatus.NEW]),
            { maxToReserve: 1, maxAttempts: 20 }
        );
        const observedReserved = [...reserved.values()][0];
        assert.ok(observedReserved);
        assert.ok(
            await repository.finalization.finishReserved(
                observedReserved.key,
                observedReserved.dequeueAudit.attempts,
                EntityStatus.COMPLETED,
                new Date(600)
            )
        );
        const finished = await repository.entries.findAnyByKey(first.key);
        assert.equal(finished?.status, EntityStatus.COMPLETED);

        const revivedEntry = advanceCoalescedGeneration({ ...first, resource: finished!.resource }, 2);
        const successor = createResourceEntry('revive-successor', {
            topicId: first.key.topicId,
            contextId: first.key.contextId,
            typeId: first.typeId,
            payload: { generation: 2, kind: 'successor' }
        });
        const revived = await sql.begin(async (transaction) =>
            await service.write(transaction, {
                expectedEntry: finished!,
                entry: revivedEntry,
                successorEntry: successor
            })
        );
        assert.equal(revived.action, 'updated');
        const stored = await repository.entries.findByKey(first.key);
        assert.equal(stored?.status, EntityStatus.NEW);
        assert.equal(stored?.resource, revivedEntry.resource);
        assert.equal(stored?.dequeueAudit.attempts, 0);

        const staleExpected = await sql.begin(async (transaction) =>
            await service.write(transaction, {
                expectedEntry: finished!,
                entry: revivedEntry,
                successorEntry: successor
            })
        );
        assert.equal(staleExpected.action, 'successor');
        assert.equal((await repository.entries.findByKey(first.key))?.resource, revivedEntry.resource);
        assert.equal((await repository.entries.findByKey(successor.key))?.resource, successor.resource);
    });
});

Deno.test(
    'PGlite topology gates skip unchanged coalesced group-revision rebuilds and fail open',
    async () => {
        await withPGliteSql(async (sql) => {
            const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
            const groupRef = {
                applicationId: 'fingerprint-gate',
                workspaceId: 'atomic-work',
                groupId: 'room'
            };
            let currentSnapshot = topologyGroupSnapshotWithSessionIds(
                groupRef,
                ['session-a', 'session-b'],
                nowEpochMs
            );
            const runtimeRepository = new PSqlRuntimeStateRepository(sql);
            const topologyService = new RallarRtcTopologyService({ now: () => nowEpochMs });
            const topologyManagement = createGroupTopologyRuntimeOwners({
                findGroupSnapshotByRef: () => currentSnapshot,
                readCurrentGroupSnapshot: async () => currentSnapshot,
                readRttMeasurements: () => [],
                topologyService,
                topologySnapshotRepository: new RtcTopologySnapshotRepository(runtimeRepository)
            });
            const executionRepository = new RtcTopologyExecutionRepository(
                runtimeRepository,
                60_000,
                () => nowEpochMs
            );
            const resourceInbox = createPSqlResourceInboxRepository(sql);
            const queue = new PSqlQueueBox(resourceInbox);
            const coalescedService = new CoalescedAppOutboxWorkService(
                new OutboxQueueReader(queue),
                'fingerprint-gate-worker',
                () => nowEpochMs
            );
            const handler = createRtcTopologyWorkHandler({
                runtime: createRtcTopologyOutboxPublisher({
                    outboxQueueReader: new OutboxQueueReader(queue),
                    senderId: 'fingerprint-gate-worker',
                    now: () => nowEpochMs
                }),
                database: sql,
                topologyPlanning: topologyManagement.planning,
                executionRepository
            });
            const toCoalescedComputed = (snapshot: GroupSnapshot, previousEntry: ResourceEntry | null) =>
                computeCoalescedRtcTopologyGroupRevisionWork({
                    aggregateRef: groupRef,
                    groupSnapshot: snapshot,
                    requestedAtEpochMs: nowEpochMs,
                    expireAtEpochMs: FUTURE_MS,
                    recomputeDebounceMs: 0,
                    senderId: 'fingerprint-gate-worker',
                    origin: 'automatic',
                    previousEntry
                });
            const coalescedKey = toCoalescedComputed(currentSnapshot, null).entry.key;
            const runCoalescedIntent = async (snapshot: GroupSnapshot) => {
                currentSnapshot = snapshot;
                const previousEntry = (await queue.getItem(coalescedKey)) ?? null;
                const computed = toCoalescedComputed(snapshot, previousEntry);
                await sql.begin(async (transaction) => await coalescedService.write(transaction, computed));
                await sql`
        update resource_inbox
        set ri_status = 'RESERVED', ri_attempts = ri_attempts + 1,
            start_ts = now() at time zone 'UTC', end_ts = null, next_ts = null
        where ri_topic_id = ${coalescedKey.topicId}
          and ri_resource_id = ${coalescedKey.resourceId}
          and fk_ext_bank_id = ${coalescedKey.contextId}
      `;
                const reserved = await resourceInbox.entries.findAnyByKey(coalescedKey);
                assert.ok(reserved);
                await handler.onMessage(JSON.parse(reserved.resource) as ALMessage, reserved);
                return reserved.key;
            };

            const firstKey = await runCoalescedIntent(currentSnapshot);
            assert.equal((await resourceInbox.entries.findAnyByKey(firstKey))?.status, EntityStatus.COMPLETED);
            let metrics = topologyService.readMetrics();
            assert.equal(metrics.topologyPublishedCount, 1);
            assert.equal(metrics.topologyRebuildSkippedFingerprintCount, 0);
            assert.ok(await executionRepository.readTopologyInputFingerprint(groupRef));

            await runCoalescedIntent(currentSnapshot);
            metrics = topologyService.readMetrics();
            assert.equal(metrics.topologyRebuildSkippedFingerprintCount, 1);
            assert.equal(metrics.topologyPublishedCount, 1);
            assert.equal(metrics.topologyUpdateCount, 1);

            const mismatchedFingerprint = `sha256:${'0'.repeat(64)}`;
            await sql.begin(async (transaction) =>
                await executionRepository.writeTopologyInputFingerprint(
                    transaction,
                    groupRef,
                    mismatchedFingerprint
                )
            );
            await runCoalescedIntent(currentSnapshot);
            metrics = topologyService.readMetrics();
            assert.equal(metrics.topologyRebuildSkippedFingerprintCount, 1);
            assert.equal(metrics.topologyPublishSkippedUnchangedCount, 1);
            assert.equal(metrics.topologyPublishedCount, 1);
            assert.equal(metrics.topologyUpdateCount, 2);
            assert.notEqual(
                await executionRepository.readTopologyInputFingerprint(groupRef),
                mismatchedFingerprint
            );

            await runCoalescedIntent(currentSnapshot);
            metrics = topologyService.readMetrics();
            assert.equal(metrics.topologyRebuildSkippedFingerprintCount, 2);
            assert.equal(metrics.topologyUpdateCount, 2);

            const grownSnapshot = topologyGroupSnapshotWithSessionIds(
                groupRef,
                ['session-a', 'session-b', 'session-c'],
                nowEpochMs
            );
            await runCoalescedIntent({
                ...grownSnapshot,
                causalRevision: { groupRevision: 2, presenceRevision: 3 },
                group: { ...grownSnapshot.group, presenceVersion: 3 }
            });
            metrics = topologyService.readMetrics();
            assert.equal(metrics.topologyPublishedCount, 2);
            assert.equal(metrics.topologyUpdateCount, 3);
        });
    }
);

Deno.test('PSqlAppDataRepository runs against PGlite SQL adapter', async () => {
    await withPGliteSql(async (sql) => {
        const repository = new PSqlAppDataRepository(sql);

        await repository.upsert({
            namespace: 'app-smoke',
            storeName: 'store',
            key: 'alpha',
            value: { count: 1 },
            schemaVersion: 1,
            expireAtTimestamp: FUTURE_MS
        });
        await repository.upsert({
            namespace: 'app-smoke',
            storeName: 'store',
            key: 'alpha',
            value: { count: 2 },
            schemaVersion: 2,
            expireAtTimestamp: FUTURE_MS
        });
        await repository.upsert({
            namespace: 'app-smoke',
            storeName: 'store',
            key: 'beta',
            value: { count: 3 },
            schemaVersion: 1,
            expireAtTimestamp: FUTURE_MS
        });
        await repository.upsert({
            namespace: 'app-smoke',
            storeName: 'store',
            key: 'expired',
            value: { count: 4 },
            schemaVersion: 1,
            expireAtTimestamp: PAST_MS
        });

        const alpha = await repository.findEntry({
            namespace: 'app-smoke',
            storeName: 'store',
            key: 'alpha'
        });
        assert.deepEqual(alpha?.value, { count: 2 });
        assert.equal(alpha?.schemaVersion, 2);
        assert.equal(alpha?.revision, 1);

        const firstPage = await repository.findEntriesPage({
            namespace: 'app-smoke',
            storeName: 'store',
            limit: 1
        });
        const secondPage = await repository.findEntriesPage({
            namespace: 'app-smoke',
            storeName: 'store',
            afterKey: firstPage.at(-1)?.key,
            limit: 10
        });
        const prefixedPage = await repository.findEntriesPage({
            namespace: 'app-smoke',
            storeName: 'store',
            keyPrefix: 'a',
            limit: 10
        });

        assert.deepEqual(firstPage.map((entry) => entry.key), ['alpha']);
        assert.deepEqual(secondPage.map((entry) => entry.key), ['beta', 'expired']);
        assert.deepEqual(prefixedPage.map((entry) => entry.key), ['alpha']);

        assert.equal(
            await repository.deleteExpired({
                namespace: 'app-smoke',
                storeName: 'store',
                expireAtOrBeforeTimestamp: Date.now()
            }),
            1
        );
        assert.equal(
            await repository.deleteByKey({
                namespace: 'app-smoke',
                storeName: 'store',
                key: 'beta'
            }),
            true
        );
        assert.equal(
            await repository.findEntry({
                namespace: 'app-smoke',
                storeName: 'store',
                key: 'beta'
            }),
            undefined
        );
    });
});

Deno.test('PSqlCrdtLogRepository exposes supported CRDT reads', async () => {
    await withPGliteSql(async (sql) => {
        const repository = new PSqlCrdtLogRepository(sql);

        assert.equal(await repository.readDocumentMetadata(CRDT_DOCUMENT_REF), undefined);
        assert.equal(await repository.readSnapshot(CRDT_DOCUMENT_REF), undefined);
        assert.deepEqual(
            (await repository.listAfter({
                document: CRDT_DOCUMENT_REF
            })).records,
            []
        );
        assert.deepEqual((await repository.listDocuments()).documents, []);
    });
});
