import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlResourceInboxMaintenance } from '@shared-server/queuebox/postgres/resource-inbox-maintenance.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { PSqlAdminQueueReader } from '@shared-server/rallar-system/admin-operations/postgres/p-sql-admin-queue-reader.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import { CLIENT_STATE_IDEMPOTENT_NAMESPACE } from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import type { GroupStateInboxDurableResult } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import { IDEMPOTENT_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { evictExpiredRuntimeStateRows } from '@shared-server/runtime-state/postgres/runtime-state-expiry-worker.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { putAuthorisedWsTestTicket } from '../../rallar-system/client-state/authorised-ws-test-ticket.ts';
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
import {
    createPostgresAppInboxTestAuthority,
    runGroupAppInbox
} from './test-support/postgres-group-app-inbox-mutation.ts';
import { seedGroupFormation } from './test-support/postgres-group-formation-fixture.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
/** Short enough to wait out in a test; the configuration's floor applies to the API, not to the writer. */
const SHORT_RETENTION_MS = 3_000;
/** The committed default window. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;

interface RetentionHarness {
    /** Carried by every scope, session and request this test writes, so its rows can be found and removed. */
    readonly runId: string;
    readonly sql: PSqlSql;
    readonly scope: StateScope;
    /** Finishes commands with the short window. */
    readonly short: PostgresAppInboxWorkerRuntime;
    /** Finishes commands with the committed default window. */
    readonly long: PostgresAppInboxWorkerRuntime;
    /** A short-window runtime whose group ingress clock reads the instant it is created. */
    readonly createLaterShortRuntime: () => PostgresAppInboxWorkerRuntime;
}

interface StoredRowExpiry {
    readonly status: string;
    /** Milliseconds from the row's finish (or creation, for a result or an unfinished row) to its expiry. */
    readonly retainedMs: number;
}

describe('Postgres retention of finished AppInbox commands', () => {
    postgresIt('expires a finished fact, its result and its outbox rows after the window and keeps the rest', async () => {
        await withRetentionHarness(async (harness) => {
            const shortSession = await connect(harness, harness.short, 'short');
            const longSession = await connect(harness, harness.long, 'long');
            const unfinishedAtEpochMs = Date.now() + 7_000_000_000;
            await harness.short.client.enqueueExpiredSessions(unfinishedAtEpochMs);

            expect(await readFactExpiries(harness.sql, shortSession)).toEqual([
                { status: EntityStatus.COMPLETED, retainedMs: SHORT_RETENTION_MS }
            ]);
            expect(await readFactExpiries(harness.sql, longSession)).toEqual([
                { status: EntityStatus.COMPLETED, retainedMs: DEFAULT_RETENTION_MS }
            ]);
            expect(await countOutboxRows(harness.sql, shortSession)).toBeGreaterThan(0);
            const completedBefore = await readFinishedFactCount(harness.sql);

            await waitOutShortRetention();
            await sweepExpiredRows(harness.sql);

            expect(await readFactExpiries(harness.sql, shortSession)).toEqual([]);
            expect(await countResultRows(harness.sql, shortSession)).toBe(0);
            expect(await countOutboxRows(harness.sql, shortSession)).toBe(0);
            expect(await readFactExpiries(harness.sql, longSession)).toHaveLength(1);
            expect(await countResultRows(harness.sql, longSession)).toBe(1);
            expect(await countOutboxRows(harness.sql, longSession)).toBeGreaterThan(0);
            expect(await readTickStatuses(harness.sql, unfinishedAtEpochMs)).toEqual([EntityStatus.NEW]);
            expect(await readFinishedFactCount(harness.sql)).toBeLessThan(completedBefore);
            await deleteTicks(harness.sql, unfinishedAtEpochMs);
        });
    }, 60_000);

    postgresIt('sweeps an idle process\'s finished expired-sessions ticks after the window', async () => {
        await withRetentionHarness(async (harness) => {
            const tickAtEpochMs = Date.now() + 8_000_000_000;
            await harness.short.dequeueUntilSettled(finishTick(harness, tickAtEpochMs));
            expect(await readTickStatuses(harness.sql, tickAtEpochMs)).toEqual([EntityStatus.COMPLETED]);

            await waitOutShortRetention();
            await sweepExpiredRows(harness.sql);

            expect(await readTickStatuses(harness.sql, tickAtEpochMs)).toEqual([]);
            expect(await countTickResults(harness.sql, tickAtEpochMs)).toBe(0);
        });
    }, 60_000);

    postgresIt('replays a request inside the window and executes it again after the window', async () => {
        await withRetentionHarness(async (harness) => {
            const principalId = `principal-${harness.runId}`;
            const authority = await putSession(harness, principalId);
            const requestId = `rename-first-${harness.runId}`;

            const first = await upsertPrincipal(harness, { authority, principalId, requestId, displayName: 'First' });
            await upsertPrincipal(harness, {
                authority,
                principalId,
                requestId: `rename-second-${harness.runId}`,
                displayName: 'Second'
            });
            const replayed = await upsertPrincipal(harness, { authority, principalId, requestId, displayName: 'First' });
            expect(replayed).toEqual(first);
            expect(await readDisplayName(harness, principalId)).toBe('Second');
            expect(await countIdempotencyRecords(harness.sql, principalId)).toBe(2);

            await waitOutShortRetention();
            await sweepExpiredRows(harness.sql);
            expect(await countIdempotencyRecords(harness.sql, principalId)).toBe(0);

            const executed = await upsertPrincipal(harness, { authority, principalId, requestId, displayName: 'First' });
            expect(executed.result.event?.eventType).toBe('principal-updated');
            expect(executed.result.snapshot.stateRevision).toBeGreaterThan(first.result.snapshot.stateRevision + 1);
            expect(await readDisplayName(harness, principalId)).toBe('First');
        });
    }, 60_000);
    postgresIt('executes a request again on its first attempt after the window, before any sweep', async () => {
        await withRetentionHarness(async (harness) => {
            const principalId = `principal-${harness.runId}`;
            const authority = await putSession(harness, principalId);
            const requestId = `rename-unswept-${harness.runId}`;
            await upsertPrincipal(harness, { authority, principalId, requestId, displayName: 'First' });
            await upsertPrincipal(harness, {
                authority,
                principalId,
                requestId: `rename-unswept-second-${harness.runId}`,
                displayName: 'Second'
            });

            await waitOutShortRetention();
            expect(await countIdempotencyRecords(harness.sql, principalId)).toBe(2);

            const executed = await upsertPrincipal(harness, { authority, principalId, requestId, displayName: 'First' });
            expect(executed.result.event?.eventType).toBe('principal-updated');
            expect(await readDisplayName(harness, principalId)).toBe('First');
            expect(await readFactAttempts(harness.sql, requestId)).toEqual([1]);
        });
    }, 60_000);
});

describe('Postgres retention of a group request\'s idempotency', () => {
    postgresIt('replays a group update inside the window and executes it again after the window', async () => {
        await withRetentionHarness(async (harness) => {
            const fixture = await seedGroupFormation({
                sql: harness.sql,
                scope: harness.scope,
                activeMemberIds: [],
                atEpochMs: Date.now(),
                requestIdFor: (semanticId) => `${semanticId}-${harness.runId}`
            });
            const authority = createPostgresAppInboxTestAuthority('alice', 'alice-session');
            await harness.short.authSessions.putSession(authority);
            const requestId = `rename-group-first-${harness.runId}`;

            const first = await renameGroup(harness, { authority, groupId: fixture.groupRef.groupId, requestId }, 'First');
            await renameGroup(
                harness,
                { authority, groupId: fixture.groupRef.groupId, requestId: `rename-group-second-${harness.runId}` },
                'Second'
            );
            expect(await renameGroup(harness, { authority, groupId: fixture.groupRef.groupId, requestId }, 'First'))
                .toEqual(first);
            expect(await readGroupDisplayName(harness, fixture.groupRef.groupId)).toBe('Second');
            // The creation ran on a default-window service, so only the two short-window records expire.
            expect(await countGroupIdempotencyRecords(harness.sql, harness.runId)).toBe(3);

            await waitOutShortRetention();
            await sweepExpiredRows(harness.sql);
            expect(await countGroupIdempotencyRecords(harness.sql, harness.runId)).toBe(1);

            await renameGroup(
                { ...harness, short: harness.createLaterShortRuntime() },
                { authority, groupId: fixture.groupRef.groupId, requestId },
                'First'
            );
            expect(await readGroupDisplayName(harness, fixture.groupRef.groupId)).toBe('First');
        });
    }, 60_000);

    postgresIt('executes a group request again on its first attempt after the window, before any sweep', async () => {
        await withRetentionHarness(async (harness) => {
            const fixture = await seedGroupFormation({
                sql: harness.sql,
                scope: harness.scope,
                activeMemberIds: [],
                atEpochMs: Date.now(),
                requestIdFor: (semanticId) => `${semanticId}-${harness.runId}`
            });
            const authority = createPostgresAppInboxTestAuthority('alice', 'alice-session');
            await harness.short.authSessions.putSession(authority);
            const groupId = fixture.groupRef.groupId;
            const requestId = `rename-group-unswept-${harness.runId}`;
            await renameGroup(harness, { authority, groupId, requestId }, 'First');
            await renameGroup(
                harness,
                { authority, groupId, requestId: `rename-group-unswept-second-${harness.runId}` },
                'Second'
            );

            await waitOutShortRetention();
            expect(await countGroupIdempotencyRecords(harness.sql, harness.runId)).toBe(3);

            await renameGroup(
                { ...harness, short: harness.createLaterShortRuntime() },
                { authority, groupId, requestId },
                'First'
            );
            expect(await readGroupDisplayName(harness, groupId)).toBe('First');
            expect(await readFactAttempts(harness.sql, requestId)).toEqual([1]);
        });
    }, 60_000);
});

async function withRetentionHarness(run: (harness: RetentionHarness) => Promise<void>): Promise<void> {
    await withPostgresClients({
        namespace: null,
        clientCount: 1,
        createClient: async () => await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 4)
    }, async (clients) => {
        const sql = requirePostgresClient(clients, 0);
        const runId = crypto.randomUUID();
        const createRuntime = (serviceId: string, finishedRetentionMs: number) =>
            createPostgresAppInboxWorkerRuntime({
                sql,
                serviceId,
                finishedRetentionMs,
                newLaneHeldRows: undefined,
                atEpochMs: Date.now(),
                trace: createPostgresAppInboxWorkerTrace()
            });
        try {
            await run({
                runId,
                sql,
                scope: { applicationId: 'app-inbox-retention-test', workspaceId: runId },
                short: createRuntime('retention-short', SHORT_RETENTION_MS),
                long: createRuntime('retention-long', DEFAULT_RETENTION_MS),
                createLaterShortRuntime: () => createRuntime('retention-later', SHORT_RETENTION_MS)
            });
        }
        finally {
            await deletePostgresRunRows(sql, runId);
        }
        expect(await readPostgresRunRowCounts(sql, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
    });
}

/** An authorised WebSocket connect: its fact, its result and the state-sync outbox rows it writes. */
async function connect(
    harness: RetentionHarness,
    runtime: PostgresAppInboxWorkerRuntime,
    label: string
): Promise<string> {
    const nowEpochMs = Date.now();
    const authSession = await putSession(harness, `${label}-${harness.runId}`);
    const ticketDigest = await putAuthorisedWsTestTicket(runtime.authSessions, authSession);
    const result = await runtime.runUntilCompletion(() =>
        runtime.client.writeAuthorisedWsClientConnect({
            authSession,
            generationId: `${label}-generation`,
            ticketDigest,
            input: { ...harness.scope, clientInstanceId: 'browser', connectedAtEpochMs: nowEpochMs }
        })
    );
    expect(result.right).toBeDefined();
    return authSession.sessionId;
}

async function putSession(harness: RetentionHarness, principalId: string): Promise<IssuedAuthSession> {
    const nowEpochMs = Date.now();
    const authSession: IssuedAuthSession = {
        clientId: principalId,
        username: principalId,
        sessionId: `${principalId}-session`,
        accessToken: `${principalId}-retention-token`,
        issuedAtEpochMs: nowEpochMs - 1_000,
        expiresAtEpochMs: nowEpochMs + 60 * 60 * 1_000
    };
    await harness.short.authSessions.putSession(authSession);
    return authSession;
}

interface PrincipalUpsert {
    readonly authority: IssuedAuthSession;
    readonly principalId: string;
    readonly requestId: string;
    readonly displayName: string;
}

async function upsertPrincipal(harness: RetentionHarness, upsert: PrincipalUpsert) {
    const { authority, principalId, requestId } = upsert;
    const result = await harness.short.runUntilCompletion(() =>
        harness.short.client.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                resourceId: requestId,
                contextId: toAuthenticatedClientMutationContextId({
                    scope: harness.scope,
                    principalId,
                    callerClientId: authority.clientId,
                    callerSessionId: authority.sessionId
                }),
                senderId: authority.clientId,
                data: {
                    scope: harness.scope,
                    principalId,
                    request: {
                        username: principalId,
                        displayName: upsert.displayName,
                        actorPrincipalId: authority.clientId,
                        actorSessionId: authority.sessionId,
                        requestId
                    }
                }
            },
            authority
        )
    );
    if (result.right === undefined) {
        throw new Error(`Principal upsert ${requestId} failed: ${result.left?.message}`);
    }
    return result.right;
}

async function readDisplayName(harness: RetentionHarness, principalId: string): Promise<string | null | undefined> {
    const snapshot = await harness.short.client.clientStateService.readSnapshot({ ...harness.scope, principalId });
    return snapshot?.principal.displayName;
}

interface GroupRename {
    readonly authority: IssuedAuthSession;
    readonly groupId: string;
    readonly requestId: string;
}

async function renameGroup(
    harness: RetentionHarness,
    rename: GroupRename,
    displayName: string
): Promise<GroupStateInboxDurableResult> {
    const { authority, groupId, requestId } = rename;
    return await runGroupAppInbox({
        runtime: harness.short,
        authority,
        type: AppInboxType.GROUP_UPDATE,
        data: {
            scope: harness.scope,
            groupId,
            request: {
                displayName,
                actorPrincipalId: authority.clientId,
                actorSessionId: authority.sessionId,
                requestId
            }
        }
    });
}

async function readGroupDisplayName(harness: RetentionHarness, groupId: string): Promise<string | undefined> {
    const snapshot = await harness.short.group.groupStateService.readSnapshot({ ...harness.scope, groupId });
    return snapshot?.group.displayName;
}

async function countGroupIdempotencyRecords(sql: PSqlSql, runId: string): Promise<number> {
    const [row] = await sql<{ count: number; }[]>`
        select count(*)::int as count from runtime_state_store
        where store_namespace = ${IDEMPOTENT_NAMESPACE} and store_key like ${`%${runId}%`}
    `;
    return row?.count ?? 0;
}

/** Enqueues one tick and settles once a worker pass has finished it. */
async function finishTick(harness: RetentionHarness, atEpochMs: number): Promise<void> {
    await harness.short.client.enqueueExpiredSessions(atEpochMs);
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
        if ((await readTickStatuses(harness.sql, atEpochMs)).includes(EntityStatus.COMPLETED)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`The expired-sessions tick at ${atEpochMs} never finished`);
}

async function waitOutShortRetention(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, SHORT_RETENTION_MS + 250));
}

/** The statements the 15 s resource-inbox sweep and the runtime-state expiry worker run. */
async function sweepExpiredRows(sql: PSqlSql): Promise<void> {
    await new PSqlResourceInboxMaintenance(sql).deleteExpired();
    await new ResourceInboxResultsRepository(sql).deleteExpired();
    await evictExpiredRuntimeStateRows({ repository: new PSqlRuntimeStateRepository(sql) });
}

async function readFactExpiries(sql: PSqlSql, sessionId: string): Promise<readonly StoredRowExpiry[]> {
    return await sql<StoredRowExpiry[]>`
        select ri_status as status,
               round(extract(epoch from (expire_ts - end_ts)) * 1000)::int as "retainedMs"
        from resource_inbox
        where ri_type_id = ${EnqueuedType.APP_INBOX} and ri_resource like ${`%${sessionId}%`}
    `;
}

async function countResultRows(sql: PSqlSql, sessionId: string): Promise<number> {
    const [row] = await sql<{ count: number; }[]>`
        select count(*)::int as count from resource_inbox_results
        where ris_type_id = ${EnqueuedType.APP_INBOX} and ris_resource like ${`%${sessionId}%`}
    `;
    return row?.count ?? 0;
}

async function countOutboxRows(sql: PSqlSql, sessionId: string): Promise<number> {
    const [row] = await sql<{ count: number; }[]>`
        select count(*)::int as count from resource_inbox
        where ri_type_id = ${EnqueuedType.WS_OUTBOX} and ri_resource like ${`%${sessionId}%`}
    `;
    return row?.count ?? 0;
}

async function countIdempotencyRecords(sql: PSqlSql, principalId: string): Promise<number> {
    const [row] = await sql<{ count: number; }[]>`
        select count(*)::int as count from runtime_state_store
        where store_namespace = ${CLIENT_STATE_IDEMPOTENT_NAMESPACE} and store_key like ${`%${principalId}%`}
    `;
    return row?.count ?? 0;
}

async function readTickStatuses(sql: PSqlSql, atEpochMs: number): Promise<readonly string[]> {
    const rows = await sql<{ ri_status: string; }[]>`
        select ri_status from resource_inbox
        where ri_type_id = ${EnqueuedType.APP_INBOX}
          and ri_resource like ${`%${AppInboxType.CLIENT_EXPIRED_SESSIONS}%`}
          and ri_resource like ${`%${atEpochMs}%`}
    `;
    return rows.map((row) => row.ri_status);
}

/** The attempt count of every AppInbox fact the request id keys. */
async function readFactAttempts(sql: PSqlSql, requestId: string): Promise<readonly number[]> {
    const rows = await sql<{ ri_attempts: number; }[]>`
        select ri_attempts from resource_inbox
        where ri_type_id = ${EnqueuedType.APP_INBOX} and ri_resource like ${`%${requestId}%`}
    `;
    return rows.map((row) => Number(row.ri_attempts));
}

async function countTickResults(sql: PSqlSql, atEpochMs: number): Promise<number> {
    const [row] = await sql<{ count: number; }[]>`
        select count(*)::int as count from resource_inbox_results
        where ris_type_id = ${EnqueuedType.APP_INBOX}
          and ris_resource like ${`%${AppInboxType.CLIENT_EXPIRED_SESSIONS}%`}
          and ris_resource like ${`%${atEpochMs}%`}
    `;
    return row?.count ?? 0;
}

async function deleteTicks(sql: PSqlSql, atEpochMs: number): Promise<void> {
    await sql`
        delete from resource_inbox
        where ri_type_id = ${EnqueuedType.APP_INBOX}
          and ri_resource like ${`%${AppInboxType.CLIENT_EXPIRED_SESSIONS}%`}
          and ri_resource like ${`%${atEpochMs}%`}
    `;
}

/** What `/queues` reports for finished AppInbox facts. */
async function readFinishedFactCount(sql: PSqlSql): Promise<number> {
    const queues = await new PSqlAdminQueueReader(sql, { nowEpochMs: Date.now }).execute({
        adminSession: {
            clientId: 'admin',
            sessionId: 'admin-session',
            accessToken: 'admin-token',
            username: 'admin',
            expiresAtEpochMs: Date.now() + 60_000
        }
    });
    return queues.queueRows.byTypeStatus
        .filter((group) => group.typeId === EnqueuedType.APP_INBOX && group.status === EntityStatus.COMPLETED)
        .reduce((total, group) => total + group.count, 0);
}
