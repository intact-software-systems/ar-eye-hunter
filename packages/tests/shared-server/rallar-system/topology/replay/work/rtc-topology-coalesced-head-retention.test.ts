import { PGlite } from '@electric-sql/pglite';
import { Temporal } from '@js-temporal/polyfill';
import { readFileSync } from 'node:fs';
import {
    describe,
    expect,
    it
} from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { toDomain, type ResourceInboxRow } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import {
    writeCoalescedAppOutboxWork,
    type CoalescedAppOutboxWorkWrite
} from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupConnectTriggerLatchRepository } from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts';
import {
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE
} from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import {
    computeCoalescedRtcTopologyGroupRevisionWork,
    toCoalescedGroupRevisionKey
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import { createPGliteSqlClient } from '../../../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from '../../../../integration/postgres/test-support/delete-postgres-run-rows.ts';
import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { createGroupAuthorityRead } from '../../../group-state/mutation/group-mutation-test-runtime.ts';

/** The head's first expiry: short enough to wait out. */
const FIRST_EXPIRY_MS = 1_500;
const RETENTION_MS = 3_600_000;

/** What the harness's reads and clock answer; a test changes it between steps. */
interface HeadHarnessState {
    /** The group as every read sees it; a test changes it to make the next replan publish. */
    group: GroupSnapshot;
    /** The instant the handler's attempt reads; set just before it runs. */
    attemptAtEpochMs: number;
}

interface HeadHarness {
    readonly sql: PSqlSql;
    readonly resources: PSqlResourceInboxRepository;
    readonly queue: PSqlQueueBox;
    readonly state: HeadHarnessState;
    readonly headKey: Key;
    readonly snapshots: RtcTopologySnapshotRepository;
    readonly handler: OnMessageCallback;
}

describe.each(['memory', 'postgres'] as const)('the coalesced topology head near its first expiry (%s)', (backend) => {
    const sqlIt = backend === 'postgres' && process.env.RALLAR_POSTGRES_INTEGRATION !== '1' ? it.skip : it;

    sqlIt('keeps a head merged shortly before its first expiry visible past it, and its replan runs', async () => {
        await withHeadSql(backend, async (h) => {
            const firstAtEpochMs = Date.now();
            expect(await writeHead(h, null, firstAtEpochMs + FIRST_EXPIRY_MS)).toBe('written');
            const pending = await requireStoredHead(h);
            expect(pending.status).toBe(EntityStatus.NEW);
            const mergedExpiryEpochMs = Date.now() + RETENTION_MS;
            expect(await writeHead(h, pending, mergedExpiryEpochMs)).toBe('written');

            await waitUntil(firstAtEpochMs + FIRST_EXPIRY_MS + 250);

            const head = await h.queue.getItem(h.headKey);
            expect(head?.audit.expiryTs.epochMilliseconds).toBe(mergedExpiryEpochMs);
            await runHead(h, head!);
            expect((await h.snapshots.findSnapshot(h.state.group.group))?.state).toBe('active');
            expect((await h.queue.getItem(h.headKey))?.status).toBe(EntityStatus.COMPLETED);
        });
    }, 30_000);

    sqlIt('keeps a head revived shortly before its first expiry visible past it, and its replan runs', async () => {
        await withHeadSql(backend, async (h) => {
            const firstAtEpochMs = Date.now();
            expect(await writeHead(h, null, firstAtEpochMs + FIRST_EXPIRY_MS)).toBe('written');
            const finished = await finishHead(h);
            const revivedExpiryEpochMs = Date.now() + RETENTION_MS;
            expect(await writeHead(h, finished, revivedExpiryEpochMs)).toBe('written');

            await waitUntil(firstAtEpochMs + FIRST_EXPIRY_MS + 250);

            const head = await h.queue.getItem(h.headKey);
            expect(head?.status).toBe(EntityStatus.NEW);
            expect(head?.audit.expiryTs.epochMilliseconds).toBe(revivedExpiryEpochMs);
            await runHead(h, head!);
            expect((await h.snapshots.findSnapshot(h.state.group.group))?.state).toBe('active');
            expect((await h.queue.getItem(h.headKey))?.status).toBe(EntityStatus.COMPLETED);
        });
    }, 30_000);

    sqlIt('gives a wake derived from a head near its expiry the retention window past the attempt', async () => {
        await withHeadSql(backend, async (h) => {
            expect(await writeHead(h, null, Date.now() + 5_000)).toBe('written');

            await runHead(h, await requireStoredHead(h));

            expect(await readWakeExpiries(h)).toEqual([h.state.attemptAtEpochMs + RETENTION_MS]);
        });
    }, 30_000);

    // A group idle for its retention window comes back to a fresh head, whose generations, and so whose work ids, start
    // again; the work claim of the earlier head's run may still hold its key until the sweep.
    sqlIt('publishes from a fresh head over the expired work claim of the head it replaced', async () => {
        await withHeadSql(backend, async (h) => {
            expect(await writeHead(h, null, Date.now() + RETENTION_MS)).toBe('written');
            await runHead(h, await requireStoredHead(h));
            expect(await readPublicationRows(h)).toHaveLength(2);
            await expireHeadAndPublicationRows(h);

            h.state.group = { ...h.state.group, group: { ...h.state.group.group, displayName: 'renamed after a long idle' } };
            expect(await writeHead(h, null, Date.now() + RETENTION_MS)).toBe('written');
            await runHead(h, await requireStoredHead(h));

            expect((await h.queue.getItem(h.headKey))?.status).toBe(EntityStatus.COMPLETED);
            expect(await readPublicationRows(h)).toEqual([
                { namespace: RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE, revision: 1, live: true },
                { namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, revision: 0, live: false },
                { namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE, revision: 0, live: true }
            ]);
        });
    }, 30_000);
});

async function withHeadSql(backend: 'memory' | 'postgres', run: (harness: HeadHarness) => Promise<void>): Promise<void> {
    const applicationId = `head-retention-${crypto.randomUUID()}`;
    if (backend === 'memory') {
        const sql = createPGliteSqlClient(new PGlite());
        try {
            await sql.exec(readFileSync(new URL('../../../../../../../apps/api-v1/src/db/in-memory-schema.sql', import.meta.url), 'utf8'));
            await run(createHeadHarness(sql, applicationId));
        }
        finally {
            await sql.close();
        }
        return;
    }
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    try {
        await run(createHeadHarness(sql, applicationId));
    }
    finally {
        await deletePostgresRunRows(sql, applicationId);
        expect(await readPostgresRunRowCounts(sql, applicationId)).toEqual(NO_POSTGRES_RUN_ROWS);
        await sql.end();
    }
}

function createHeadHarness(sql: PSqlSql, applicationId: string): HeadHarness {
    const runtimeRepository = new PSqlRuntimeStateRepository(sql);
    const resources = createPSqlResourceInboxRepository(sql, () => new Date());
    const queue = new PSqlQueueBox(resources, Temporal.Now.instant);
    const read = createGroupAuthorityRead({ applicationId, lifecycleState: 'planned', formationEpoch: 3 });
    const value = read.group!.value;
    const member = { ...read.actorMember!, applicationId, principalId: value.ownerPrincipalId, role: 'owner' as const };
    const group: GroupSnapshot = {
        group: value,
        causalRevision: { groupRevision: value.snapshotVersion, presenceRevision: 0 },
        members: [member],
        activeSessions: [],
        memberCount: 1,
        onlineMemberCount: 0
    };
    const state: HeadHarnessState = { group, attemptAtEpochMs: 0 };
    const snapshots = new RtcTopologySnapshotRepository(runtimeRepository);
    const topology = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: async () => state.group,
        readCurrentGroupSnapshot: async () => state.group,
        readRttMeasurements: () => [],
        topologyService: new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000 }),
        topologySnapshotRepository: snapshots
    });
    return {
        sql,
        resources,
        queue,
        state,
        headKey: toCoalescedGroupRevisionKey(group.group),
        snapshots,
        handler: createRtcTopologyWorkHandler({
            nowEpochMs: () => state.attemptAtEpochMs,
            finishedRetentionMs: RETENTION_MS,
            outboxQueueReader: new OutboxQueueReader(queue),
            database: sql,
            topologyPlanning: topology.planning,
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository),
            formationAutomation: {
                latches: new GroupConnectTriggerLatchRepository(runtimeRepository),
                readGroup: async () => state.group.group,
                readPlanned: async () => await snapshots.findSnapshot(group.group) ?? null,
                nowEpochMs: Date.now,
                submitCommand: async () => {
                    throw new Error('Publication never submits directly');
                }
            }
        })
    };
}

/** A presence change of the group as its summary writes it: the change's own retention deadline rides on it. */
async function writeHead(
    h: HeadHarness,
    previousEntry: ResourceEntry | null,
    expireAtEpochMs: number
): Promise<CoalescedAppOutboxWorkWrite> {
    const computed = computeCoalescedRtcTopologyGroupRevisionWork({
        aggregateRef: h.state.group.group,
        groupSnapshot: h.state.group,
        requestedAtEpochMs: Date.now(),
        expireAtEpochMs,
        timing: { window: { debounceMs: 0, maxWaitMs: 0 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'head-retention',
        origin: 'automatic',
        previousEntry
    });
    return await runInPSqlTransaction(h.sql, async (transaction) => await writeCoalescedAppOutboxWork(transaction, computed));
}

async function requireStoredHead(h: HeadHarness): Promise<ResourceEntry> {
    const head = await h.queue.getItem(h.headKey);
    if (!head) {
        throw new Error('The coalesced head is missing');
    }
    return head;
}

async function finishHead(h: HeadHarness): Promise<ResourceEntry> {
    const [row] = await h.sql<ResourceInboxRow[]>`
        update resource_inbox
        set ri_status = ${EntityStatus.COMPLETED}, ri_attempts = 1, start_ts = now() at time zone 'UTC',
            end_ts = now() at time zone 'UTC', next_ts = null
        where ri_topic_id = ${h.headKey.topicId} and ri_resource_id = ${h.headKey.resourceId}
          and fk_ext_bank_id = ${h.headKey.contextId}
        returning *
    `;
    return toDomain(row!);
}

async function runHead(h: HeadHarness, head: ResourceEntry): Promise<void> {
    const reserved = await h.resources.reservations.startProcessingEntity(head);
    if (!reserved.right) {
        throw new Error('The queue refused to reserve the coalesced head');
    }
    h.state.attemptAtEpochMs = Date.now();
    await h.handler.onMessage(decodePersistedALMessage(reserved.right.resource), reserved.right);
}

async function readWakeExpiries(h: HeadHarness): Promise<readonly number[]> {
    const key = toAppQueueKey({
        contextId: groupStateGroupStorageKey(h.state.group.group),
        topicId: 'app-outbox.group-connect-trigger',
        resourceId: 'unused'
    });
    const rows = await h.sql<{ expireAtEpochMs: number; }[]>`
        select round(extract(epoch from expire_ts) * 1000)::bigint::float8 as "expireAtEpochMs"
        from resource_inbox
        where fk_ext_bank_id = ${key.contextId} and ri_topic_id = ${key.topicId}
    `;
    return rows.map((row) => Number(row.expireAtEpochMs));
}

interface PublicationRow {
    readonly namespace: string;
    readonly revision: number;
    readonly live: boolean;
}

/** In namespace order, the work claim first, and expired rows before live ones. */
async function readPublicationRows(h: HeadHarness): Promise<readonly PublicationRow[]> {
    const rows = await h.sql<PublicationRow[]>`
        select store_namespace as namespace, revision::int as revision, expire_at_ts > now() as live
        from runtime_state_store
        where store_namespace in (${RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE}, ${RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE})
          and store_key like ${`%${h.state.group.group.applicationId}%`}
    `;
    const namespaces = [RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE, RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE];
    return [...rows].sort((left, right) => namespaces.indexOf(left.namespace) - namespaces.indexOf(right.namespace) || Number(left.live) - Number(right.live));
}

async function expireHeadAndPublicationRows(h: HeadHarness): Promise<void> {
    await h.sql`
        update resource_inbox set expire_ts = (now() - interval '1 minute') at time zone 'UTC'
        where ri_topic_id = ${h.headKey.topicId} and ri_resource_id = ${h.headKey.resourceId}
          and fk_ext_bank_id = ${h.headKey.contextId}
    `;
    await h.sql`
        update runtime_state_store set expire_at_ts = now() - interval '1 minute'
        where store_namespace in (${RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE}, ${RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE})
          and store_key like ${`%${h.state.group.group.applicationId}%`}
    `;
}

async function waitUntil(epochMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, epochMs - Date.now())));
}
