import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-runtime-namespaces.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

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
const NEVER_EXPIRE_YEAR = 9_999;

interface TopologyRetentionHarness {
    readonly runId: string;
    readonly sql: PSqlSql;
    readonly groupRef: GroupRef;
    readonly owner: IssuedAuthSession;
    readonly createRuntime: () => PostgresAppInboxWorkerRuntime;
}

interface StoredExpiry {
    readonly expireAtEpochMs: number;
    readonly expireYear: number;
}

describe('Postgres retention of topology command rows', () => {
    postgresIt('bounds the recompute outbox rows of a config write and a reconfigure, and the mutation record', async () => {
        await withTopologyRetentionHarness(async (harness) => {
            const runtime = harness.createRuntime();
            const configCapturedAtEpochMs = Date.now();
            await runTopologyCommand(harness, runtime, {
                requestId: `put-config-${harness.runId}`,
                capturedAtEpochMs: configCapturedAtEpochMs,
                payload: { operation: 'putConfig', config: { topologyKind: 'tree' } }
            });
            const reconfigureCapturedAtEpochMs = Date.now();
            await runTopologyCommand(harness, runtime, {
                requestId: `reconfigure-${harness.runId}`,
                capturedAtEpochMs: reconfigureCapturedAtEpochMs,
                payload: { operation: 'reconfigureTopology', requestOptions: {}, publish: false }
            });

            const outbox = await readOutboxExpiries(harness.sql, harness.runId);
            expect(outbox.length).toBeGreaterThan(0);
            expect(outbox.every((row) => row.expireYear < NEVER_EXPIRE_YEAR)).toBe(true);
            expect(Math.max(...outbox.map((row) => row.expireAtEpochMs))).toBe(
                reconfigureCapturedAtEpochMs + SHORT_RETENTION_MS
            );
            expect(await readMutationRecordExpiries(harness.sql, harness.runId)).toEqual([
                expect.objectContaining({ expireAtEpochMs: configCapturedAtEpochMs + SHORT_RETENTION_MS })
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
    const type = command.payload.operation === 'putConfig'
        ? AppInboxType.TOPOLOGY_CONFIG_PUT
        : AppInboxType.TOPOLOGY_RECONFIGURE;
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

async function readOutboxExpiries(sql: PSqlSql, runId: string): Promise<readonly StoredExpiry[]> {
    return await sql<StoredExpiry[]>`
        select round(extract(epoch from expire_ts) * 1000)::bigint::float8 as "expireAtEpochMs",
               extract(year from expire_ts)::int as "expireYear"
        from resource_inbox
        where ri_type_id = ${EnqueuedType.APP_OUTBOX} and ri_resource like ${`%${runId}%`}
    `;
}

async function readMutationRecordExpiries(sql: PSqlSql, runId: string): Promise<readonly StoredExpiry[]> {
    return await sql<StoredExpiry[]>`
        select round(extract(epoch from expire_at_ts) * 1000)::bigint::float8 as "expireAtEpochMs",
               extract(year from expire_at_ts)::int as "expireYear"
        from runtime_state_store
        where store_namespace = ${GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE} and store_key like ${`%${runId}%`}
    `;
}

async function readFactAttempts(sql: PSqlSql, requestId: string): Promise<readonly number[]> {
    const rows = await sql<{ ri_attempts: number; }[]>`
        select ri_attempts from resource_inbox
        where ri_type_id = ${EnqueuedType.APP_INBOX} and ri_resource like ${`%${requestId}%`}
    `;
    return rows.map((row) => Number(row.ri_attempts));
}
