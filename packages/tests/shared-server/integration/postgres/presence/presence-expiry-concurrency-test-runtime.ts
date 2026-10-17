import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { encodeClientStateStorageKeyPart } from '@shared-server/rallar-system/client-state/persistence/client-state-storage-key-codec.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ClientSessionRef } from '@shared/api/client-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { createPostgresClientPhaseDriver, type PostgresClientPhaseDriver } from '../../../rallar-system/client-state/postgres-client-mutation-test-driver.ts';
import { createTestGroupStateRuntime, type TestGroupStateRuntime } from '../../../rallar-system/group-state/group-state-test-runtime.ts';
import type { PostgresSql } from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { createPostgresTestRequestIdFactory } from '../test-support/create-postgres-test-request-id-factory.ts';

const requestIdFor = createPostgresTestRequestIdFactory();

interface CleanupPostgresPresenceClientsInput {
    readonly sql: PostgresSql;
    readonly applicationIds: readonly string[];
    readonly clients: readonly PostgresSql[];
    readonly hasPrimaryFailure: boolean;
}

export async function cleanupPostgresPresenceClients(input: CleanupPostgresPresenceClientsInput): Promise<void> {
    const cleanupResults = await Promise.allSettled(
        input.applicationIds.map((applicationId) => cleanupRuntimeState(input.sql, applicationId))
    );
    const closeResults = await Promise.allSettled(input.clients.map((client) => client.end()));
    const failures = [...cleanupResults, ...closeResults]
        .flatMap((result) => result.status === 'rejected' ? [toError(result.reason)] : []);
    const firstFailure = failures[0];
    if (!firstFailure) {
        return;
    }
    const secondaryFailures = input.hasPrimaryFailure ? failures : failures.slice(1);
    if (secondaryFailures.length > 0) {
        try {
            console.error(new AggregateError(secondaryFailures, 'Secondary PostgreSQL presence cleanup failures'));
        }
        catch {
            // Cleanup reporting cannot replace the primary failure.
        }
    }
    if (!input.hasPrimaryFailure) {
        throw firstFailure;
    }
}

interface SeedExpiredClientSessionInput {
    readonly sql: PostgresSql;
    readonly scope: StateScope;
    readonly sessionRef: ClientSessionRef;
    readonly atEpochMs: number;
}

export async function seedExpiredClientSession(
    input: SeedExpiredClientSessionInput
): Promise<void> {
    await createPostgresClientPhaseDriver({
        sql: input.sql,
        runtimeRepository: new PSqlRuntimeStateRepository(input.sql),
        atEpochMs: input.atEpochMs - 10_000,
        serviceId: 'postgres-expiry-test-setup'
    }).connectSession(
        {
            scope: input.scope,
            principalId: input.sessionRef.principalId,
            clientInstanceId: input.sessionRef.clientInstanceId,
            sessionId: input.sessionRef.sessionId,
            request: {
                generationId: 'generation-1',
                presenceState: 'online',
                transport: 'ws',
                authenticatedAtEpochMs: input.atEpochMs - 20_000,
                connectedAtEpochMs: input.atEpochMs - 20_000,
                lastHeartbeatAtEpochMs: input.atEpochMs - 10_000,
                expiresAtEpochMs: input.atEpochMs - 1_000,
                actorPrincipalId: input.sessionRef.principalId,
                actorSessionId: input.sessionRef.sessionId,
                requestId: requestIdFor('seed-client-session')
            }
        }
    );
}

interface SeedExpiredGroupPresenceSessionInput {
    readonly sql: PostgresSql;
    readonly scope: StateScope;
    readonly groupRef: GroupRef;
    readonly sessionId: string;
    readonly atEpochMs: number;
}

export async function seedExpiredGroupPresenceSession(
    input: SeedExpiredGroupPresenceSessionInput
): Promise<void> {
    const service = createTestGroupStateRuntime({
        runtimeRepository: new PSqlRuntimeStateRepository(input.sql),
        groupStateEventStoreFor: createPostgresGroupStateEventStore,
        now: () => input.atEpochMs - 10_000,
        serviceId: 'postgres-expiry-test-setup'
    }).service;

    await service.createGroup(input.scope, {
        groupId: input.groupRef.groupId,
        displayName: 'Room 1',
        kind: 'room',
        joinMode: 'open',
        createdByPrincipalId: 'alice',
        actorPrincipalId: 'alice',
        actorSessionId: input.sessionId,
        requestId: requestIdFor('seed-group')
    });
    await service.connectPresenceSession(input.scope, input.groupRef.groupId, input.sessionId, {
        generationId: 'generation-1',
        connectionGenerationId: 'ws-generation-1',
        principalId: 'alice',
        connectedAtEpochMs: input.atEpochMs - 20_000,
        lastHeartbeatAtEpochMs: input.atEpochMs - 10_000,
        expiresAtEpochMs: input.atEpochMs - 1_000,
        actorPrincipalId: 'alice',
        actorSessionId: input.sessionId,
        requestId: requestIdFor('seed-group-presence-session')
    });
}

export async function cleanupRuntimeState(sql: PostgresSql, applicationId: string): Promise<void> {
    await sql`
        delete from client_state_events
        where application_id = ${applicationId}
    `;
    await sql`
        delete from group_state_events
        where application_id = ${applicationId}
    `;
    await sql`
        delete from runtime_state_store
        where store_key like ${`app=${encodeURIComponent(applicationId)}:%`}
    `;
}

interface CreatePostgresClientServiceInput {
    readonly sql: PostgresSql;
    readonly barrier: PrincipalReadBarrier;
    readonly atEpochMs: number;
    readonly applicationId?: string;
}

export function createPostgresClientService(input: CreatePostgresClientServiceInput): PostgresClientPhaseDriver {
    const runtimeRepository = new BarrierPSqlRuntimeStateRepository(
        input.sql,
        input.barrier,
        input.applicationId
    );
    return createPostgresClientPhaseDriver({
        sql: input.sql,
        runtimeRepository,
        atEpochMs: input.atEpochMs,
        serviceId: 'postgres-client-cas-worker'
    });
}

interface CreatePostgresGroupRuntimeInput {
    readonly sql: PostgresSql;
    readonly barrier: GroupPresenceReadBarrier;
    readonly atEpochMs: number;
    readonly barrierNamespace?: string;
    readonly applicationId?: string;
    readonly attemptCount?: number;
}

export function createPostgresGroupRuntime(input: CreatePostgresGroupRuntimeInput): TestGroupStateRuntime {
    return createTestGroupStateRuntime({
        runtimeRepository: new BarrierGroupPSqlRuntimeStateRepository({
            sql: input.sql,
            barrier: input.barrier,
            barrierNamespace: input.barrierNamespace,
            applicationId: input.applicationId
        }),
        groupStateEventStoreFor: createPostgresGroupStateEventStore,
        now: () => input.atEpochMs,
        attemptCount: input.attemptCount,
        serviceId: 'postgres-group-cas-worker'
    });
}

function createPostgresGroupStateEventStore(
    runtimeRepository: RuntimeStateOptimisticTransactionalRepositoryLike
): PSqlGroupStateEventRepository {
    if (!(runtimeRepository instanceof PSqlRuntimeStateRepository)) {
        throw new TypeError('PostgreSQL group tests require PSqlRuntimeStateRepository');
    }
    return new PSqlGroupStateEventRepository(runtimeRepository.sql);
}

export class BarrierPSqlRuntimeStateRepository extends PSqlRuntimeStateRepository {
    private readonly barrier: PrincipalReadBarrier;
    private readonly applicationId?: string;

    constructor(sql: PSqlSql, barrier: PrincipalReadBarrier, applicationId?: string) {
        super(sql);
        this.barrier = barrier;
        this.applicationId = applicationId;
    }

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const entry = await super.findEntry(namespace, key);
        if (namespace === 'client-state:principals') {
            await this.barrier.arrive();
        }
        return entry;
    }

    override async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntry[]> {
        const applicationId = this.applicationId;
        if (applicationId === undefined) {
            return await super.findEntriesByPrefixPage(namespace, keyPrefix, options);
        }
        const applicationPrefix = `app=${encodeClientStateStorageKeyPart(applicationId)}:`;
        if (!keyPrefix.startsWith(applicationPrefix) && !applicationPrefix.startsWith(keyPrefix)) {
            return [];
        }
        const scopedKeyPrefix = keyPrefix.length > applicationPrefix.length ? keyPrefix : applicationPrefix;
        return await super.findEntriesByPrefixPage(namespace, scopedKeyPrefix, options);
    }
}

namespace BarrierGroupPSqlRuntimeStateRepository {
    export interface Input {
        readonly sql: PSqlSql;
        readonly barrier: GroupPresenceReadBarrier;
        readonly barrierNamespace?: string;
        readonly applicationId?: string;
    }
}

class BarrierGroupPSqlRuntimeStateRepository extends PSqlRuntimeStateRepository {
    private readonly barrier: GroupPresenceReadBarrier;
    private readonly barrierNamespace: string;
    private readonly applicationId?: string;

    constructor(input: BarrierGroupPSqlRuntimeStateRepository.Input) {
        super(input.sql);
        this.barrier = input.barrier;
        this.barrierNamespace = input.barrierNamespace ?? 'group-state:sessions';
        this.applicationId = input.applicationId;
    }

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const entry = await super.findEntry(namespace, key);
        if (namespace === this.barrierNamespace) {
            await this.barrier.arrive();
        }
        return entry;
    }

    override async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        const entries = await super.findAllEntries(namespace);
        const applicationId = this.applicationId;
        return applicationId === undefined
            ? entries
            : entries.filter((entry) => entry.key.startsWith(`app=${encodeURIComponent(applicationId)}:`));
    }
}

export class PrincipalReadBarrier {
    private arrived = 0;
    private readonly ready = Promise.withResolvers<void>();
    private readonly participants: number;

    constructor(participants: number) {
        this.participants = participants;
    }

    async arrive(): Promise<void> {
        if (this.arrived >= this.participants) {
            return;
        }
        this.arrived += 1;
        if (this.arrived === this.participants) {
            this.ready.resolve();
        }
        await this.ready.promise;
    }
}

export class GroupPresenceReadBarrier extends PrincipalReadBarrier {}

interface SeedConnectedClientSessionInput {
    readonly sql: PostgresSql;
    readonly scope: StateScope;
    readonly sessionRef: ClientSessionRef;
    readonly atEpochMs: number;
}

export async function seedConnectedClientSession(
    input: SeedConnectedClientSessionInput
): Promise<void> {
    await createPostgresClientPhaseDriver({
        sql: input.sql,
        runtimeRepository: new PSqlRuntimeStateRepository(input.sql),
        atEpochMs: input.atEpochMs,
        serviceId: 'postgres-worker-client-setup'
    }).connectSession(
        {
            scope: input.scope,
            principalId: input.sessionRef.principalId,
            clientInstanceId: input.sessionRef.clientInstanceId,
            sessionId: input.sessionRef.sessionId,
            request: {
                generationId: 'generation-1',
                connectionId: 'connection-1',
                connectedAtEpochMs: input.atEpochMs,
                lastHeartbeatAtEpochMs: input.atEpochMs,
                expiresAtEpochMs: input.atEpochMs + 60_000,
                actorPrincipalId: input.sessionRef.principalId,
                actorSessionId: input.sessionRef.sessionId,
                requestId: requestIdFor('worker-client-seed')
            }
        }
    );
}
