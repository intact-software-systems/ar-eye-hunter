import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import {
    GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE
} from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { createRtcTopologyWorkHandler } from '@shared-server/rallar-system/topology/replay/work/create-rtc-topology-work-handler.ts';
import { createGroupTopologyRuntimeOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

import { seedTopologyGroup, topologyGroupSnapshot } from '../../rallar-system/topology/concurrency/postgres-topology-concurrency-fixtures.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresClient,
    requirePostgresDatabaseUrl,
    withPostgresClients
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';
import {
    createPostgresAppInboxWorkerRuntime,
    createPostgresAppInboxWorkerTrace,
    type PostgresAppInboxWorkerRuntime
} from './test-support/postgres-app-inbox-worker-runtime.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
/** Short enough to wait out in a test; the configuration's floor applies to the API, not to the writer. */
const SHORT_RETENTION_MS = 3_000;

interface TopologyRetentionHarness {
    readonly runId: string;
    readonly sql: PSqlSql;
    readonly groupRef: GroupRef;
    readonly owner: IssuedAuthSession;
    readonly createRuntime: () => PostgresAppInboxWorkerRuntime;
}

interface StoredExpiry {
    readonly expireAtEpochMs: number;
}

interface StoredRecomputeRow extends StoredExpiry {
    readonly msgId: string;
    readonly status: string;
}

describe('Postgres retention of topology command rows', () => {
    postgresIt('completes the recompute rows of a config write and a reconfigure at their own window, and bounds the record', async () => {
        await withTopologyRetentionHarness(async (harness) => {
            const runtime = harness.createRuntime();
            const configRequestId = `put-config-${harness.runId}`;
            const configCapturedAtEpochMs = Date.now();
            await runTopologyCommand(harness, runtime, {
                requestId: configRequestId,
                capturedAtEpochMs: configCapturedAtEpochMs,
                payload: { operation: 'putConfig', config: { topologyKind: 'tree' } }
            });
            const reconfigureRequestId = `reconfigure-${harness.runId}`;
            const reconfigureCapturedAtEpochMs = Date.now();
            await runTopologyCommand(harness, runtime, {
                requestId: reconfigureRequestId,
                capturedAtEpochMs: reconfigureCapturedAtEpochMs,
                payload: { operation: 'reconfigureTopology', requestOptions: {}, publish: false }
            });
            const recomputeIds = [
                `${configRequestId}:rtc-topology-recompute:group-revision:group=1;presence=0`,
                `${reconfigureRequestId}:rtc-topology-recompute:explicit`
            ];

            await drainTopologyOutboxUntilCompleted(harness, recomputeIds);

            expect(await readRecomputeRows(harness.sql, recomputeIds)).toEqual([
                {
                    msgId: recomputeIds[0],
                    status: EntityStatus.COMPLETED,
                    expireAtEpochMs: configCapturedAtEpochMs + SHORT_RETENTION_MS
                },
                {
                    msgId: recomputeIds[1],
                    status: EntityStatus.COMPLETED,
                    expireAtEpochMs: reconfigureCapturedAtEpochMs + SHORT_RETENTION_MS
                }
            ]);
            expect(await readMutationRecordExpiries(harness.sql, harness.runId)).toEqual([
                { expireAtEpochMs: configCapturedAtEpochMs + SHORT_RETENTION_MS }
            ]);
        });
    }, 60_000);

    postgresIt('executes a config request again on its first attempt after the window, before any sweep', async () => {
        await withTopologyRetentionHarness(async (harness) => {
            const requestId = `put-config-again-${harness.runId}`;
            await runTopologyCommand(harness, harness.createRuntime(), {
                requestId,
                capturedAtEpochMs: Date.now(),
                payload: { operation: 'putConfig', config: { topologyKind: 'tree' } }
            });

            await new Promise((resolve) => setTimeout(resolve, SHORT_RETENTION_MS + 250));
            expect(await readMutationRecordExpiries(harness.sql, harness.runId)).toHaveLength(1);

            const executed = await runTopologyCommand(harness, harness.createRuntime(), {
                requestId,
                capturedAtEpochMs: Date.now(),
                payload: { operation: 'putConfig', config: { topologyKind: 'mesh' } }
            });
            expect(executed).toMatchObject({ receipt: { outcome: 'applied', acceptedVersion: 2 } });
            expect(await readFactAttempts(harness.sql, requestId)).toEqual([1]);
        });
    }, 60_000);

    postgresIt('writes an override over an expired override row, one revision past it', async () => {
        await withTopologyRetentionHarness(async (harness) => {
            const runtime = harness.createRuntime();
            const putOverride = (requestId: string, ttlMs: number) =>
                runTopologyCommand(harness, runtime, {
                    requestId,
                    capturedAtEpochMs: Date.now(),
                    payload: { operation: 'putOverride', config: { degreeLimit: 4 }, ttlMs, expiresAtEpochMs: null }
                });
            await putOverride(`put-override-${harness.runId}`, 500);
            await new Promise((resolve) => setTimeout(resolve, 750));

            expect(await putOverride(`put-override-again-${harness.runId}`, 60_000)).toMatchObject({ receipt: { outcome: 'applied' } });
            expect(await readOverrideRevisions(harness.sql, harness.runId)).toEqual([1]);
        });
    }, 60_000);
});

async function withTopologyRetentionHarness(run: (harness: TopologyRetentionHarness) => Promise<void>): Promise<void> {
    await withPostgresClients({
        namespace: null,
        clientCount: 1,
        createClient: async () => await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 4)
    }, async (clients) => {
        const sql = requirePostgresClient(clients, 0);
        const runId = crypto.randomUUID();
        const groupRef = { applicationId: 'topology-retention-test', workspaceId: runId, groupId: 'room' };
        const owner: IssuedAuthSession = {
            clientId: 'owner',
            username: 'owner',
            sessionId: `owner-${runId}`,
            accessToken: `owner-${runId}-token`,
            issuedAtEpochMs: Date.now() - 1_000,
            expiresAtEpochMs: Date.now() + 60 * 60 * 1_000
        };
        try {
            await seedTopologyGroup(sql, topologyGroupSnapshot(groupRef));
            await run({
                runId,
                sql,
                groupRef,
                owner,
                createRuntime: () =>
                    createPostgresAppInboxWorkerRuntime({
                        sql,
                        serviceId: 'topology-retention',
                        finishedRetentionMs: SHORT_RETENTION_MS,
                        newLaneHeldRows: undefined,
                        atEpochMs: Date.now(),
                        trace: createPostgresAppInboxWorkerTrace()
                    })
            });
        }
        finally {
            await deletePostgresRunRows(sql, runId);
        }
        expect(await readPostgresRunRowCounts(sql, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
    });
}

interface TopologyCommand {
    readonly requestId: string;
    readonly capturedAtEpochMs: number;
    readonly payload: Parameters<typeof toTopologyAppInboxCommand>[0]['payload'];
}

async function runTopologyCommand(
    harness: TopologyRetentionHarness,
    runtime: PostgresAppInboxWorkerRuntime,
    command: TopologyCommand
) {
    await runtime.authSessions.putSession(harness.owner);
    const type = {
        putConfig: AppInboxType.TOPOLOGY_CONFIG_PUT,
        putOverride: AppInboxType.TOPOLOGY_OVERRIDE_PUT,
        reconfigureTopology: AppInboxType.TOPOLOGY_RECONFIGURE
    }[command.payload.operation as 'putConfig' | 'putOverride' | 'reconfigureTopology'];
    const result = await runtime.runUntilCompletion(() =>
        runtime.topology.processAuthenticatedEntryUntilCompletionResult(
            {
                type,
                resourceId: command.requestId,
                contextId: [harness.groupRef.applicationId, harness.groupRef.workspaceId, harness.groupRef.groupId]
                    .map(encodeURIComponent)
                    .join(':'),
                senderId: harness.owner.clientId,
                data: toTopologyAppInboxCommand({
                    actor: { principalId: harness.owner.clientId, sessionId: harness.owner.sessionId },
                    groupRef: harness.groupRef,
                    requestId: command.requestId,
                    capturedAtEpochMs: command.capturedAtEpochMs,
                    payload: command.payload
                })
            },
            harness.owner
        )
    );
    if (result.right === undefined) {
        throw new Error(`Topology command ${command.requestId} failed: ${result.left?.message}`);
    }
    return result.right;
}

/** Runs the topology APP_OUTBOX worker until every named recompute row has completed. */
async function drainTopologyOutboxUntilCompleted(
    harness: TopologyRetentionHarness,
    msgIds: readonly string[]
): Promise<void> {
    const outboxQueueReader = createTopologyOutboxQueueReader(harness);
    for (let iteration = 0; iteration < 200; iteration += 1) {
        const rows = await readRecomputeRows(harness.sql, msgIds);
        if (rows.length === msgIds.length && rows.every((row) => row.status === EntityStatus.COMPLETED)) {
            return;
        }
        await outboxQueueReader.dequeueOutbox(OutboxQueueReader.OUTBOX_DEQUEUE_TYPES, createOutboxResilience());
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('The topology recompute rows did not complete');
}

function createTopologyOutboxQueueReader(harness: TopologyRetentionHarness): OutboxQueueReader {
    const resources = createPSqlResourceInboxRepository(harness.sql, () => new Date());
    const outboxQueueReader = new OutboxQueueReader(new PSqlQueueBox(resources, Temporal.Now.instant));
    const runtimeRepository = new PSqlRuntimeStateRepository(harness.sql);
    const groupStateRepository = createTestGroupStateRepository(
        runtimeRepository,
        new PSqlGroupStateEventRepository(harness.sql)
    );
    const topologyOwners = createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef: () => topologyGroupSnapshot(harness.groupRef),
        readCurrentGroupSnapshot: async (ref) => await groupStateRepository.readSnapshot(ref),
        readRttMeasurements: () => [],
        topologyService: new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000 })
    });
    outboxQueueReader.onOutboxMessageDo(
        AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        createRtcTopologyWorkHandler({
            nowEpochMs: Date.now,
            outboxQueueReader,
            database: harness.sql,
            topologyPlanning: topologyOwners.planning,
            executionRepository: new RtcTopologyExecutionRepository(runtimeRepository, undefined, Date.now),
            serviceId: 'topology-retention-outbox'
        })
    );
    return outboxQueueReader;
}

function createOutboxResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(100, duration, duration, duration));
}

async function readRecomputeRows(sql: PSqlSql, msgIds: readonly string[]): Promise<readonly StoredRecomputeRow[]> {
    return await sql<StoredRecomputeRow[]>`
        select ri_resource::jsonb #>> '{id,msgId}' as "msgId",
               ri_status as status,
               round(extract(epoch from expire_ts) * 1000)::bigint::float8 as "expireAtEpochMs"
        from resource_inbox
        where ri_type_id = ${EnqueuedType.APP_OUTBOX}
          and ri_resource::jsonb #>> '{id,msgId}' = any(${[...msgIds]}::text[])
        order by array_position(${[...msgIds]}::text[], ri_resource::jsonb #>> '{id,msgId}')
    `;
}

async function readMutationRecordExpiries(sql: PSqlSql, runId: string): Promise<readonly StoredExpiry[]> {
    return await sql<StoredExpiry[]>`
        select round(extract(epoch from expire_at_ts) * 1000)::bigint::float8 as "expireAtEpochMs"
        from runtime_state_store
        where store_namespace = ${GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE} and store_key like ${`%${runId}%`}
    `;
}

async function readOverrideRevisions(sql: PSqlSql, runId: string): Promise<readonly number[]> {
    const rows = await sql<{ revision: number; }[]>`
        select revision::int as revision from runtime_state_store
        where store_namespace = ${GROUP_TOPOLOGY_OVERRIDE_NAMESPACE} and store_key like ${`%${runId}%`}
          and expire_at_ts > now()
    `;
    return rows.map((row) => row.revision);
}

async function readFactAttempts(sql: PSqlSql, requestId: string): Promise<readonly number[]> {
    const rows = await sql<{ ri_attempts: number; }[]>`
        select ri_attempts from resource_inbox
        where ri_type_id = ${EnqueuedType.APP_INBOX} and ri_resource like ${`%${requestId}%`}
    `;
    return rows.map((row) => Number(row.ri_attempts));
}
