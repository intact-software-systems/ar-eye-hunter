import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createPSqlCounterScope } from '@shared-server/postgres/create-p-sql-counter-scope.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { AUTH_SESSIONS_BY_SESSION_NAMESPACE } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUP_LIFECYCLE_POLICIES_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    GROUPS_NAMESPACE,
    IDEMPOTENT_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE,
    SESSIONS_NAMESPACE
} from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { WS_SESSION_CLOSE_HIGH_WATER_NAMESPACE } from '@shared-server/rallar-system/websocket/ws-session-generation-computation.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';

import { createTestGroupStateRuntime } from '../../rallar-system/group-state/group-state-test-runtime.ts';
import { createRuntimeStatePostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { createPostgresTestRequestIdFactory } from './test-support/create-postgres-test-request-id-factory.ts';
import {
    createPostgresAppInboxTestAuthority,
    toAuthenticatedGroupAppInboxEnqueue,
    toGroupAppInboxStorageCommandId,
    unwrapAppInboxResult
} from './test-support/postgres-group-app-inbox-mutation.ts';

const POSTGRES_INTEGRATION_ENABLED = process.env.RALLAR_POSTGRES_INTEGRATION === '1';
const postgresIt = POSTGRES_INTEGRATION_ENABLED ? it : it.skip;
const requestIdFor = createPostgresTestRequestIdFactory();
const GROUP_ID = 'join-read-room';

describe('Postgres group join read batch', () => {
    postgresIt('reads a join\'s policy, decision rows and result snapshot in one statement', async () => {
        await withJoinReadHarness('join-read-statements', async (harness) => {
            const reads = await harness.recordReads(async () => {
                await harness.join('bob');
            });

            expect(reads.statements).toBe(reads.calls.length);
            expect(reads.calls.map((call) => call.namespaces)).toEqual([
                // The ingress capture reads the causal revision before the entry is enqueued.
                [GROUPS_NAMESPACE],
                [PRESENCE_SUMMARIES_NAMESPACE],
                // The lane attempt re-checks the session, then reads everything else at once.
                [AUTH_SESSIONS_BY_SESSION_NAMESPACE],
                expect.arrayContaining([
                    GROUP_LIFECYCLE_POLICIES_NAMESPACE,
                    IDEMPOTENT_NAMESPACE,
                    GROUPS_NAMESPACE,
                    MEMBERS_NAMESPACE,
                    PRESENCE_SUMMARIES_NAMESPACE,
                    SESSIONS_NAMESPACE
                ])
            ]);
        });
    }, 30_000);

    postgresIt('applies a join on its first attempt when the presence summary moves during its read', async () => {
        await withJoinReadHarness('join-read-summary-move', async (harness) => {
            harness.probe.interleave = createInterleavedSummaryWrite(harness.sql, harness.groupRef);

            const enqueue = await harness.join('bob');

            expect(harness.probe.interleave.writeCount()).toBe(1);
            const record = await harness.repository.findIdempotentGroupMutationReceipt(
                harness.groupRef,
                toGroupAppInboxStorageCommandId(enqueue, 'bob')
            );
            expect(record?.receipt).toMatchObject({ outcome: 'applied', attemptCount: 1 });
            const snapshot = await harness.repository.readSnapshot(harness.groupRef);
            expect(snapshot?.members.find((member) => member.principalId === 'bob')?.status).toBe('active');
        });
    }, 30_000);

    postgresIt('reads a presence connect\'s session lifecycle and mutation rows together', async () => {
        await withJoinReadHarness('connect-read-overlap', async (harness) => {
            await harness.join('bob');

            const reads = await harness.recordReads(async () => {
                await harness.connect('bob');
            });

            expect(reads.statements).toBe(reads.calls.length);
            const lifecycle = reads.calls.find((call) => call.namespaces.includes(WS_SESSION_CLOSE_HIGH_WATER_NAMESPACE));
            const session = reads.calls.find((call) => call.namespaces.includes(AUTH_SESSIONS_BY_SESSION_NAMESPACE));
            expect(lifecycle?.startedAt).toBeLessThan(session?.endedAt ?? -1);
            expect(session?.startedAt).toBeLessThan(lifecycle?.endedAt ?? -1);
        });
    }, 30_000);
});

interface RuntimeStateReadCall {
    readonly namespaces: readonly string[];
    readonly startedAt: number;
    endedAt: number;
}

interface RecordedReads {
    readonly statements: number;
    readonly calls: readonly RuntimeStateReadCall[];
}

interface InterleavedSummaryWrite {
    readonly written: Promise<void>;
    write(): Promise<void>;
    writeCount(): number;
}

/** Records every runtime-state read and, when armed, writes the presence summary between a join's two old reads. */
class RuntimeStateReadProbe extends PSqlRuntimeStateRepository {
    readonly calls: RuntimeStateReadCall[] = [];
    interleave: InterleavedSummaryWrite | null = null;
    private sequence = 0;

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        return await this.record([namespace], async () => await super.findEntry(namespace, key));
    }

    override async readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const interleave = this.interleave;
        const readsDecisionRows = selectors.some((selector) => selector.namespace === IDEMPOTENT_NAMESPACE);
        const readsRoster = selectors.some((selector) => selector.kind === 'prefix' && selector.namespace === MEMBERS_NAMESPACE);
        if (interleave !== null && readsRoster && !readsDecisionRows) {
            await interleave.written;
        }
        const selections = await this.record(
            [...new Set(selectors.map((selector) => selector.namespace))],
            async () => await super.readRuntimeStateBatch(selectors)
        );
        if (interleave !== null && readsDecisionRows) {
            await interleave.write();
        }
        return selections;
    }

    private async record<T>(namespaces: readonly string[], read: () => Promise<T>): Promise<T> {
        const call: RuntimeStateReadCall = { namespaces, startedAt: this.sequence++, endedAt: Number.NaN };
        this.calls.push(call);
        try {
            return await read();
        }
        finally {
            call.endedAt = this.sequence++;
        }
    }
}

interface JoinReadHarness {
    readonly sql: PSqlSql;
    readonly groupRef: GroupRef;
    readonly probe: RuntimeStateReadProbe;
    readonly repository: GroupStateRepository;
    join(principalId: string): Promise<AuthenticatedGroupMutationEnqueue>;
    connect(principalId: string): Promise<AuthenticatedGroupMutationEnqueue>;
    recordReads(action: () => Promise<void>): Promise<RecordedReads>;
}

async function withJoinReadHarness(
    label: string,
    test: (harness: JoinReadHarness) => Promise<void>
): Promise<void> {
    const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl(), 4);
    const scope: StateScope = { applicationId: `${label}-${crypto.randomUUID()}`, workspaceId: 'workspace-1' };
    const groupRef: GroupRef = { ...scope, groupId: GROUP_ID };
    try {
        await createJoinReadGroup(sql, scope);
        await test(createJoinReadHarness(sql, groupRef));
    }
    finally {
        await cleanupJoinReadState(sql, scope.applicationId);
        await sql.end();
    }
}

async function createJoinReadGroup(sql: PSqlSql, scope: StateScope): Promise<void> {
    await createTestGroupStateRuntime({
        runtimeRepository: new PSqlRuntimeStateRepository(sql),
        groupStateEventStoreFor: () => new PSqlGroupStateEventRepository(sql),
        serviceId: 'join-read-setup'
    }).service.createGroup(scope, {
        groupId: GROUP_ID,
        displayName: 'Join read room',
        kind: 'room',
        joinMode: 'open',
        maxMembers: 10,
        createdByPrincipalId: 'alice',
        requestId: requestIdFor(`${scope.applicationId}:create`)
    });
}

function createJoinReadHarness(sql: PSqlSql, groupRef: GroupRef): JoinReadHarness {
    const countedSql = createPSqlCounterScope(sql);
    const probe = new RuntimeStateReadProbe(countedSql);
    const resourceInbox = createPSqlResourceInboxRepository(sql, () => new Date());
    const inbox = new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant), {
        laneBudgetPolicy: 'adaptive-retry',
        newLaneConcurrency: 1
    });
    const groupEventStore = new PSqlGroupStateEventRepository(sql);
    const authSessions = new AuthSessionRepository(new PSqlRuntimeStateRepository(sql));
    const group = new GroupStateInboxService({
        inboxQueueReader: inbox,
        resourceInboxRepository: resourceInbox.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        database: sql,
        groupStateService: createGroupStateService({
            runtimeRepository: probe,
            groupStateEventStore: groupEventStore,
            authSessionRepository: new AuthSessionRepository(probe),
            serviceId: 'join-read-worker',
            readPlannedLayoutRow: async () => null,
            readAcceptedLayoutRow: async () => null
        }),
        resultReader: createTestGroupStateRepository(probe, groupEventStore)
    }, {
        serviceId: 'join-read-worker',
        options: { nowEpochMs: Date.now, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 5, waitJitterRatio: 0 }
    });
    const run = async (
        authority: IssuedAuthSession,
        enqueue: AuthenticatedGroupMutationEnqueue
    ): Promise<AuthenticatedGroupMutationEnqueue> => {
        await authSessions.putSession(authority);
        let settled = false;
        const pending = group.processAuthenticatedGroupEntryUntilCompletion(enqueue, authority)
            .finally(() => (settled = true));
        while (!settled) {
            await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createWorkerResilience());
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        unwrapAppInboxResult(await pending);
        return enqueue;
    };
    return {
        sql,
        groupRef,
        probe,
        repository: new GroupStateRepository(new PSqlRuntimeStateRepository(sql), groupEventStore),
        join: async (principalId) => {
            const authority = toAuthority(groupRef, principalId);
            return await run(authority, toJoinEnqueue(groupRef, authority));
        },
        connect: async (principalId) => {
            const authority = toAuthority(groupRef, principalId);
            return await run(authority, toConnectEnqueue(groupRef, authority));
        },
        recordReads: async (action) => {
            const statementsBefore = readStatementCount(countedSql);
            const callsBefore = probe.calls.length;
            await action();
            return {
                statements: readStatementCount(countedSql) - statementsBefore,
                calls: probe.calls.slice(callsBefore)
            };
        }
    };
}

function toAuthority(groupRef: GroupRef, principalId: string): IssuedAuthSession {
    return createPostgresAppInboxTestAuthority(principalId, `${groupRef.applicationId}:${principalId}-session`);
}

function toJoinEnqueue(groupRef: GroupRef, authority: IssuedAuthSession): AuthenticatedGroupMutationEnqueue {
    return toAuthenticatedGroupAppInboxEnqueue({
        authority,
        type: AppInboxType.GROUP_JOIN,
        data: {
            scope: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId },
            groupId: groupRef.groupId,
            request: {
                actorPrincipalId: authority.clientId,
                actorSessionId: authority.sessionId,
                requestId: requestIdFor(`${groupRef.applicationId}:join:${authority.clientId}`)
            }
        }
    });
}

function toConnectEnqueue(groupRef: GroupRef, authority: IssuedAuthSession): AuthenticatedGroupMutationEnqueue {
    const nowEpochMs = Date.now();
    return toAuthenticatedGroupAppInboxEnqueue({
        authority,
        type: AppInboxType.GROUP_PRESENCE_CONNECT,
        data: {
            scope: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId },
            groupId: groupRef.groupId,
            sessionId: authority.sessionId,
            request: {
                principalId: authority.clientId,
                generationId: `${authority.clientId}-generation`,
                connectionGenerationId: `${authority.clientId}-ws-generation`,
                connectedAtEpochMs: nowEpochMs,
                lastHeartbeatAtEpochMs: nowEpochMs,
                expiresAtEpochMs: nowEpochMs + 60_000,
                actorPrincipalId: authority.clientId,
                actorSessionId: authority.sessionId,
                requestId: requestIdFor(`${groupRef.applicationId}:connect:${authority.clientId}`)
            }
        }
    });
}

function createInterleavedSummaryWrite(sql: PSqlSql, groupRef: GroupRef): InterleavedSummaryWrite {
    const repository = new PSqlRuntimeStateRepository(sql);
    let writes = 0;
    let resolveWritten: () => void = () => undefined;
    const written = new Promise<void>((resolve) => (resolveWritten = resolve));
    return {
        written,
        writeCount: () => writes,
        write: async () => {
            if (writes > 0) {
                return;
            }
            writes += 1;
            const key = groupStateGroupStorageKey(groupRef);
            const stored = await repository.findEntry(PRESENCE_SUMMARIES_NAMESPACE, key);
            if (stored === undefined) {
                throw new Error('The group has no presence summary to move');
            }
            const summary = JSON.parse(stored.value);
            const moved = {
                ...summary,
                causalRevision: {
                    ...summary.causalRevision,
                    presenceRevision: summary.causalRevision.presenceRevision + 1
                }
            };
            await repository.upsert(PRESENCE_SUMMARIES_NAMESPACE, key, JSON.stringify(moved), stored.expireAtTimestamp);
            resolveWritten();
        }
    };
}

function readStatementCount(sql: PSqlSql): number {
    const counters = sql.getExecutorCounters?.();
    if (counters === undefined) {
        throw new TypeError('A counter scope reports its statements');
    }
    return counters.statements;
}

function createWorkerResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(100, duration, duration, duration),
        initialRate: 1,
        maxRate: 1,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
}

async function cleanupJoinReadState(sql: PSqlSql, applicationId: string): Promise<void> {
    await sql`delete from group_state_events where application_id = ${applicationId}`;
    await sql`delete from runtime_state_store where store_key like ${`%${encodeURIComponent(applicationId)}%`}`;
}

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}
