import { Temporal } from '@js-temporal/polyfill';

import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createPSqlCounterScope } from '@shared-server/postgres/create-p-sql-counter-scope.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { GroupStateInboxDurableResult } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-result.ts';
import { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    GROUPS_NAMESPACE,
    IDEMPOTENT_NAMESPACE,
    MEMBERS_NAMESPACE,
    PRESENCE_SUMMARIES_NAMESPACE
} from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';

import { createTestGroupStateRuntime } from '../../../rallar-system/group-state/group-state-test-runtime.ts';
import { createRuntimeStatePostgresSql } from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { createPostgresTestRequestIdFactory } from './create-postgres-test-request-id-factory.ts';
import {
    createPostgresAppInboxTestAuthority,
    toAuthenticatedGroupAppInboxEnqueue,
    unwrapAppInboxResult
} from './postgres-group-app-inbox-mutation.ts';

const requestIdFor = createPostgresTestRequestIdFactory();
const GROUP_ID = 'join-read-room';

export interface RuntimeStateReadCall {
    readonly namespaces: readonly string[];
    readonly startedAt: number;
    endedAt: number;
}

export interface RecordedReads {
    readonly statements: number;
    readonly calls: readonly RuntimeStateReadCall[];
}

/** A write armed once between a join's reads: it waits on `written` before the roster read and fires after the decision read. */
export interface InterleavedRowWrite {
    readonly written: Promise<void>;
    write(): Promise<void>;
    writeCount(): number;
}

/** One join the harness drives to completion: the session the route verified and the session row the lane finds. */
export interface GroupJoinAttempt {
    readonly authority: IssuedAuthSession;
    readonly storedSession: IssuedAuthSession | null;
}

/** Records every runtime-state read; an armed interleave writes a row between a join's reads, a clock jump before them. */
export class RuntimeStateReadProbe extends PSqlRuntimeStateRepository {
    readonly calls: RuntimeStateReadCall[] = [];
    interleave: InterleavedRowWrite | null = null;
    beforeDecisionRead: (() => void) | null = null;
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
        if (readsDecisionRows) {
            this.beforeDecisionRead?.();
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

/** Counts the queue-row replacements a handler issues outside its transaction, such as persisting a lane capture. */
export class ReplacementCountingEntryRepository extends PSqlResourceInboxEntryRepository {
    replacementCount = 0;
    readonly reservations: ResourceEntry[] = [];

    override async replaceIfObserved(expected: ResourceEntry, replacement: ResourceEntry): Promise<ResourceEntry | null> {
        this.replacementCount += 1;
        return await super.replaceIfObserved(expected, replacement);
    }

    override async writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const entry = await super.writeMaterializedIfAbsentOrReplaceExpired(placeholder, materialize);
        this.reservations.push(entry);
        return entry;
    }
}

export interface PostgresGroupJoinHarness {
    readonly sql: PSqlSql;
    readonly groupRef: GroupRef;
    readonly probe: RuntimeStateReadProbe;
    readonly repository: GroupStateRepository;
    readonly queueEntries: ReplacementCountingEntryRepository;
    /** Moves the lane's clock; the route's authorization and the enqueue-time capture keep the wall clock. */
    advanceLaneClock(offsetMs: number): void;
    join(principalId: string): Promise<AuthenticatedGroupMutationEnqueue>;
    attemptJoin(attempt: GroupJoinAttempt): Promise<Either<AppInboxFailure, GroupStateInboxDurableResult>>;
    connect(principalId: string): Promise<AuthenticatedGroupMutationEnqueue>;
    recordReads(action: () => Promise<void>): Promise<RecordedReads>;
}

export async function withPostgresGroupJoinHarness(
    label: string,
    test: (harness: PostgresGroupJoinHarness) => Promise<void>
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

export function toGroupJoinAuthority(groupRef: GroupRef, principalId: string): IssuedAuthSession {
    return createPostgresAppInboxTestAuthority(principalId, `${groupRef.applicationId}:${principalId}-session`);
}

export function toGroupJoinEnqueue(groupRef: GroupRef, authority: IssuedAuthSession): AuthenticatedGroupMutationEnqueue {
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

/** Moves the group row's revision once, after a join's decision read, so that join's compare-and-set conflicts. */
export function createInterleavedGroupWrite(sql: PSqlSql, groupRef: GroupRef): InterleavedRowWrite {
    return createInterleavedRowWrite<object>(sql, GROUPS_NAMESPACE, groupRef, (group) => group);
}

/** Moves the presence summary's revision once, after a join's decision read; the join does not guard on it. */
export function createInterleavedSummaryWrite(sql: PSqlSql, groupRef: GroupRef): InterleavedRowWrite {
    return createInterleavedRowWrite<StoredPresenceSummary>(sql, PRESENCE_SUMMARIES_NAMESPACE, groupRef, (summary) => ({
        ...summary,
        causalRevision: {
            ...summary.causalRevision,
            presenceRevision: summary.causalRevision.presenceRevision + 1
        }
    }));
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

function createJoinReadHarness(sql: PSqlSql, groupRef: GroupRef): PostgresGroupJoinHarness {
    const countedSql = createPSqlCounterScope(sql, { timesBeginWait: true });
    const probe = new RuntimeStateReadProbe(countedSql);
    const resourceInbox = createPSqlResourceInboxRepository(sql, () => new Date());
    const queueEntries = new ReplacementCountingEntryRepository(sql, () => new Date());
    const inbox = new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant), {
        laneBudgetPolicy: 'adaptive-retry',
        newLaneConcurrency: 1
    });
    const groupEventStore = new PSqlGroupStateEventRepository(sql);
    const authSessions = new AuthSessionRepository(new PSqlRuntimeStateRepository(sql));
    let laneClockOffsetMs = 0;
    const group = new GroupStateInboxService({
        inboxQueueReader: inbox,
        resourceInboxRepository: queueEntries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        database: sql,
        groupStateService: createGroupStateService({
            runtimeRepository: probe,
            groupStateEventStore: groupEventStore,
            authSessionRepository: new AuthSessionRepository(probe),
            serviceId: 'join-read-worker',
            now: () => Date.now() + laneClockOffsetMs,
            readPlannedLayoutRow: async () => null,
            readAcceptedLayoutRow: async () => null
        }),
        resultReader: createTestGroupStateRepository(probe, groupEventStore)
    }, {
        serviceId: 'join-read-worker',
        options: { nowEpochMs: Date.now, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 5, waitJitterRatio: 0 }
    });
    const run = async (
        attempt: GroupJoinAttempt,
        enqueue: AuthenticatedGroupMutationEnqueue
    ): Promise<Either<AppInboxFailure, GroupStateInboxDurableResult>> => {
        if (attempt.storedSession !== null) {
            await authSessions.putSession(attempt.storedSession);
        }
        let settled = false;
        const pending = group.processAuthenticatedGroupEntryUntilCompletion(enqueue, attempt.authority)
            .finally(() => (settled = true));
        while (!settled) {
            await inbox.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createWorkerResilience());
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return await pending;
    };
    const runAs = async (
        principalId: string,
        toEnqueue: (groupRef: GroupRef, authority: IssuedAuthSession) => AuthenticatedGroupMutationEnqueue
    ): Promise<AuthenticatedGroupMutationEnqueue> => {
        const authority = toGroupJoinAuthority(groupRef, principalId);
        const enqueue = toEnqueue(groupRef, authority);
        unwrapAppInboxResult(await run({ authority, storedSession: authority }, enqueue));
        return enqueue;
    };
    return {
        sql,
        groupRef,
        probe,
        repository: new GroupStateRepository(new PSqlRuntimeStateRepository(sql), groupEventStore),
        queueEntries,
        advanceLaneClock: (offsetMs) => {
            laneClockOffsetMs = offsetMs;
        },
        join: async (principalId) => await runAs(principalId, toGroupJoinEnqueue),
        attemptJoin: async (attempt) => await run(attempt, toGroupJoinEnqueue(groupRef, attempt.authority)),
        connect: async (principalId) => await runAs(principalId, toConnectEnqueue),
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

interface StoredPresenceSummary {
    readonly causalRevision: Readonly<{ presenceRevision: number; }>;
}

function createInterleavedRowWrite<Row>(
    sql: PSqlSql,
    namespace: string,
    groupRef: GroupRef,
    move: (stored: Row) => Row
): InterleavedRowWrite {
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
            const stored = await repository.findEntry(namespace, key);
            if (stored === undefined) {
                throw new Error(`The group has no ${namespace} row to move`);
            }
            const moved = move(JSON.parse(stored.value) as Row);
            await repository.upsert(namespace, key, JSON.stringify(moved), stored.expireAtTimestamp);
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
