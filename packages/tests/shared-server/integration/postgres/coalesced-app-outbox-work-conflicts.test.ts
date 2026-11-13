import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { writeAppOutboxInserts } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    readIsObservedCoalescedSuccessorStored,
    tryReadCoalescedAppOutboxWorkEnvelope,
    writeCoalescedAppOutboxWork,
    type ComputedCoalescedAppOutboxWork
} from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork,
    readPendingTopologyReplan,
    resolveQueuedRtcTopologySuccessor,
    toCoalescedGroupRevisionKey
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import {
    computeRtcTopologyReservationFinish,
    finishRtcTopologyReservation
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-completion.ts';
import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { isCanonicalRtcTopologyWorkEntry } from '@shared/queuebox/rtc-topology-work-entry-contract.ts';

import { toEarlierALEnvelopeVersionResource } from '../../../shared/al-contracts/to-earlier-al-envelope-version-resource.ts';
import {
    createPostgresSql,
    topologyGroupSnapshot,
    type PostgresSql
} from '../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';
import { deletePostgresRunRows } from './test-support/delete-postgres-run-rows.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const RUN_ID = `coalesced-conflicts-${crypto.randomUUID()}`;

describe('Postgres coalesced APP_OUTBOX work conflicts', () => {
    let sql: PostgresSql | undefined;

    beforeAll(async () => {
        if (process.env.RALLAR_POSTGRES_INTEGRATION === '1') {
            sql = await createPostgresSql(requireDatabaseUrl());
        }
    });

    afterAll(async () => {
        if (sql !== undefined) {
            await deletePostgresRunRows(sql, RUN_ID);
            await sql.end();
        }
    });

    postgresIt('reports a head another writer inserted after this one read none, and writes nothing', async () => {
        const ref = toRunGroupRef('lost-head');
        const first = computeRevisionWork(ref, null, 'automatic');
        const second = computeRevisionWork(ref, null, 'automatic');

        expect(await writeInTransaction(first)).toBe('written');
        expect(await writeInTransaction(second)).toBe('head-present');

        const rows = await readRevisionRows(ref);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.resource).toBe(first.entryWrite.entry.resource);
    });

    postgresIt('reports a successor already queued at the same causal revision behind a reserved head, unchanged', async () => {
        const ref = toRunGroupRef('queued-successor');
        await writeInTransaction(computeRevisionWork(ref, null, 'automatic'));
        const reservedHead = await reserveHead(ref);
        const first = computeRevisionWork(ref, reservedHead, 'automatic');
        const repeated = computeRevisionWork(ref, reservedHead, 'automatic');
        expect(first.operation).toBe('write-successor');

        expect(await writeInTransaction(first)).toBe('written');
        expect(await writeInTransaction(repeated)).toBe('successor-present');

        const [, queuedSuccessor] = await readRevisionRows(ref);
        expect(queuedSuccessor?.key).toEqual(first.successorWrite.entry.key);
        expect(queuedSuccessor?.resource).toBe(first.successorWrite.entry.resource);
        expect((await readRevisionRows(ref)).map((row) => row.status)).toEqual([EntityStatus.RESERVED, EntityStatus.NEW]);
    });

    postgresIt('resolves an observed successor from the request computed for the same room, revision and origin', async () => {
        const ref = toRunGroupRef('resolved-successor');
        await writeInTransaction(computeRevisionWork(ref, null, 'automatic'));
        await writeInTransaction(computeRevisionWork(ref, await reserveHead(ref), 'automatic'));
        const [, observed] = await readRevisionRows(ref);
        const request = {
            overlayId: toScopedOverlayId(ref),
            sourceGroupStateCausalRevision: topologyGroupSnapshot(ref).causalRevision,
            origin: 'automatic' as const
        };

        expect(resolveQueuedRtcTopologySuccessor(request, observed!)).toBe('serves-request');
        expect(resolveQueuedRtcTopologySuccessor({ ...request, origin: 'commanded' }, observed!)).toBe(
            'request-waits-for-head'
        );
        expect(resolveQueuedRtcTopologySuccessor(request, { ...observed!, status: EntityStatus.FAILED })).toBe(
            'request-waits-for-head'
        );
        expect(
            resolveQueuedRtcTopologySuccessor(
                { ...request, sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 } },
                observed!
            )
        ).toBe('different-request');
        expect(resolveQueuedRtcTopologySuccessor(request, { ...observed!, resource: '{}' })).toBe('different-request');
    });

    postgresIt('guards an observed successor: still stored as observed, or changed since', async () => {
        const ref = toRunGroupRef('guarded-successor');
        await writeInTransaction(computeRevisionWork(ref, null, 'automatic'));
        await writeInTransaction(computeRevisionWork(ref, await reserveHead(ref), 'automatic'));
        const [, observed] = await readRevisionRows(ref);

        expect(await guardInTransaction(observed!)).toBe(true);
        expect(
            await guardInTransaction({
                ...observed!,
                dequeueAudit: { ...observed!.dequeueAudit, attempts: observed!.dequeueAudit.attempts + 1 }
            })
        ).toBe(false);
        expect(await guardInTransaction({ ...observed!, resource: '{}' })).toBe(false);
    });

    // Until the purge removes it, an expired head is absent to every reader yet still holds its key: a group idle for
    // its whole retention window comes back to a fresh head written over the expired one.
    postgresIt('writes a fresh head over an expired one that no reader sees but the purge has not removed', async () => {
        const ref = toRunGroupRef('expired-head');
        await writeInTransaction(computeRevisionWork(ref, null, 'automatic'));
        await expireRevisionRows(ref);
        const head = toCoalescedGroupRevisionKey(ref);
        const entries = createPSqlResourceInboxRepository(requireSql(), () => new Date()).entries;
        expect(await entries.findByKey(head)).toBeNull();

        const fresh = computeRevisionWork(ref, null, 'automatic');
        expect(await writeInTransaction(fresh)).toBe('written');

        const rows = await readRevisionRows(ref);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.resource).toBe(fresh.entryWrite.entry.resource);
        expect((await entries.findByKey(head))?.resource).toBe(fresh.entryWrite.entry.resource);
    });

    // #782: a head persisted under an older AL envelope version is replaced by the ordinary compare-and-set.
    postgresIt.each([
        { head: 'failed', failed: true },
        { head: 'pending', failed: false }
    ])(
        'replaces a $head head stamped with an unsupported envelope version at the next generation',
        async ({ head, failed }) => {
            const ref = toRunGroupRef(`unsupported-head-${head}`);
            await writeInTransaction(computeRevisionWork(ref, null, 'automatic'));
            const stale = await stampHeadEnvelopeVersion(ref, 3, failed);

            const replaced = computeRevisionWork(ref, stale, 'automatic');
            expect(await writeInTransaction(replaced)).toBe('written');

            const rows = await readRevisionRows(ref);
            expect(rows).toHaveLength(1);
            expect(rows[0]!.resource).toBe(replaced.entryWrite.entry.resource);
            const message = JSON.parse(rows[0]!.resource) as ALMessage;
            expect(message.id.v).toBe(AL_MESSAGE_ENVELOPE_VERSION);
            expect(
                (JSON.parse(message.payload.resource) as { data: { __rallarCoalescedWork: { generation: number; }; }; })
                    .data.__rallarCoalescedWork.generation
            ).toBe(2);
            expect(isCanonicalRtcTopologyWorkEntry(rows[0]!)).toBe(true);
        }
    );

    // A replan written while the head executes parks on a successor row; the head's own completion leaves that row queued.
    postgresIt('the pending replan read reports a successor parked behind a head that has since completed', async () => {
        const ref = toRunGroupRef('parked-successor');
        await writeInTransaction(computeRevisionWork(ref, null, 'automatic'));
        const reserved = await reserveHead(ref);
        const parked = computeParkedRevisionWork(ref, reserved);
        expect(await writeInTransaction(parked)).toBe('written');
        await finishInTransaction(reserved);

        const entries = createPSqlResourceInboxRepository(requireSql(), () => new Date()).entries;
        expect((await entries.findByKey(toCoalescedGroupRevisionKey(ref)))?.status).toBe(EntityStatus.COMPLETED);
        const parkedWork = tryReadCoalescedAppOutboxWorkEnvelope(parked.successorWrite.entry)!.data[
            COALESCED_APP_OUTBOX_WORK_FIELD
        ];
        expect(await readPendingTopologyReplan(entries, ref)).toEqual({
            reconfigureQueued: true,
            dueAtEpochMs: parkedWork.dueAtEpochMs,
            generation: parkedWork.generation
        });
    });

    postgresIt('the pending replan read reports nothing once the successor has completed too', async () => {
        const ref = toRunGroupRef('settled-successor');
        await writeInTransaction(computeRevisionWork(ref, null, 'automatic'));
        const reserved = await reserveHead(ref);
        const parked = computeParkedRevisionWork(ref, reserved);
        expect(await writeInTransaction(parked)).toBe('written');
        await finishInTransaction(reserved);
        const repository = createPSqlResourceInboxRepository(requireSql(), () => new Date());
        const successor = (await repository.reservations.startProcessingEntity(parked.successorWrite.entry)).right;
        await finishInTransaction(successor!);

        expect(await readPendingTopologyReplan(repository.entries, ref)).toBeNull();
    });

    postgresIt('still reports a duplicate plain outbox insert as corruption', async () => {
        const ref = toRunGroupRef('plain-duplicate');
        const work = computeRevisionWork(ref, null, 'automatic');
        await writeInTransaction(work);

        await expect(
            runInPSqlTransaction(requireSql(), async (transaction) => await writeAppOutboxInserts(transaction, [work.entryWrite]))
        ).rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);
    });

    function requireSql(): PostgresSql {
        if (sql === undefined) {
            throw new Error('Postgres integration is not enabled');
        }
        return sql;
    }

    async function writeInTransaction(computed: ComputedCoalescedAppOutboxWork) {
        return await runInPSqlTransaction(
            requireSql(),
            async (transaction) => await writeCoalescedAppOutboxWork(transaction, computed)
        );
    }

    async function finishInTransaction(reserved: ResourceEntry): Promise<void> {
        const finish = computeRtcTopologyReservationFinish(reserved, new Date());
        await runInPSqlTransaction(requireSql(), async (transaction) => await finishRtcTopologyReservation(transaction, finish));
    }

    async function guardInTransaction(observed: ResourceEntry): Promise<boolean> {
        return await runInPSqlTransaction(
            requireSql(),
            async (transaction) => await readIsObservedCoalescedSuccessorStored(transaction, observed)
        );
    }

    async function readRevisionRows(ref: GroupRef): Promise<readonly ResourceEntry[]> {
        const head = toCoalescedGroupRevisionKey(ref);
        const rows = await requireSql()<ResourceInboxRow[]>`
            select * from resource_inbox
            where ri_topic_id = ${head.topicId} and fk_ext_bank_id = ${head.contextId}
            order by ri_row_id
        `;
        return rows.map(toDomain);
    }

    async function expireRevisionRows(ref: GroupRef): Promise<void> {
        const head = toCoalescedGroupRevisionKey(ref);
        await requireSql()`
            update resource_inbox
            set expire_ts = (now() - interval '1 minute') at time zone 'UTC'
            where ri_topic_id = ${head.topicId} and fk_ext_bank_id = ${head.contextId}
        `;
    }

    /** Restamps the stored head's envelope version; failed, it is left as an exhausted attempt budget leaves it. */
    async function stampHeadEnvelopeVersion(ref: GroupRef, version: number, failed: boolean): Promise<ResourceEntry> {
        const head: Key = toCoalescedGroupRevisionKey(ref);
        const [stored] = await readRevisionRows(ref);
        await requireSql()`
            update resource_inbox
            set ri_resource = ${toEarlierALEnvelopeVersionResource(stored!.resource, version)}
            where ri_topic_id = ${head.topicId} and ri_resource_id = ${head.resourceId}
              and fk_ext_bank_id = ${head.contextId}
        `;
        if (failed) {
            await requireSql()`
                update resource_inbox
                set ri_status = ${EntityStatus.FAILED}, ri_attempts = 20, next_ts = null,
                    start_ts = now() at time zone 'UTC', end_ts = now() at time zone 'UTC'
                where ri_topic_id = ${head.topicId} and ri_resource_id = ${head.resourceId}
                  and fk_ext_bank_id = ${head.contextId}
            `;
        }
        const [restamped] = await readRevisionRows(ref);
        return restamped!;
    }

    async function reserveHead(ref: GroupRef): Promise<ResourceEntry> {
        const head: Key = toCoalescedGroupRevisionKey(ref);
        const [row] = await requireSql()<ResourceInboxRow[]>`
            update resource_inbox
            set ri_status = ${EntityStatus.RESERVED}, ri_attempts = ri_attempts + 1,
                start_ts = now() at time zone 'UTC', next_ts = null
            where ri_topic_id = ${head.topicId} and ri_resource_id = ${head.resourceId}
              and fk_ext_bank_id = ${head.contextId}
            returning *
        `;
        return toDomain(row!);
    }
});

function toRunGroupRef(groupId: string): GroupRef {
    return { applicationId: RUN_ID, workspaceId: 'coalesced', groupId };
}

function computeRevisionWork(
    ref: GroupRef,
    previousEntry: ResourceEntry | null,
    origin: 'automatic' | 'commanded'
): ComputedCoalescedAppOutboxWork {
    const requestedAtEpochMs = Date.now();
    return computeCoalescedRtcTopologyGroupRevisionWork({
        traceId: 'trace-coalesced-app-outbox-work-conflicts',
        aggregateRef: ref,
        groupSnapshot: topologyGroupSnapshot(ref),
        requestedAtEpochMs,
        expireAtEpochMs: requestedAtEpochMs + 60_000,
        timing: { window: { debounceMs: 0, maxWaitMs: 0 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'coalesced-conflicts',
        origin,
        previousEntry
    });
}

/**
 * A replan parked behind the reserved head with a debounce still running: the successor waits as RETRY with a future
 * retry time, so no worker of another test file claims it before this file reads and cleans it up.
 */
function computeParkedRevisionWork(ref: GroupRef, reservedHead: ResourceEntry): ComputedCoalescedAppOutboxWork {
    const requestedAtEpochMs = Date.now();
    return computeCoalescedRtcTopologyGroupRevisionWork({
        traceId: 'trace-coalesced-app-outbox-work-conflicts',
        aggregateRef: ref,
        groupSnapshot: topologyGroupSnapshot(ref),
        requestedAtEpochMs,
        expireAtEpochMs: requestedAtEpochMs + 60_000,
        timing: { window: { debounceMs: 30_000, maxWaitMs: 30_000 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'coalesced-conflicts',
        origin: 'automatic',
        previousEntry: reservedHead
    });
}

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when Postgres integration is enabled');
    }
    return databaseUrl;
}
