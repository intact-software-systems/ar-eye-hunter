import type { Sql } from 'postgres';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { toAuthenticatedClientMutationContextId } from '@shared-server/rallar-system/client-state/inbox/authenticated-client-mutation-ingress.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { toApiV1PostgresClient } from '../../../src/db/api-v1-database-lifecycle.ts';
import {
    createStateWriteServiceRuntime,
    type StateWriteServiceRuntime
} from '../create-state-write-service-runtime.ts';
import { mapWithConcurrency } from '../map-with-concurrency.ts';
import { toStateWriteBenchmarkGroupContextId } from './api-v1-state-write-app-inbox-evidence.ts';
import { STATE_WRITE_REQUIRED_CONCURRENCY } from './api-v1-state-write-benchmark-options.ts';
import { newRunContext } from './state-write-measurement.ts';
import {
    CLIENT_COUNT,
    createBenchmarkAuthSession,
    runAppInboxMutation,
    WORKLOADS
} from './state-write-workload.ts';

interface BenchmarkSeedContext {
    readonly runtime: StateWriteServiceRuntime;
    readonly scope: StateScope;
    readonly authSessionRepository: AuthSessionRepository;
}

interface BenchmarkSeedClient {
    readonly runtime: StateWriteServiceRuntime;
    readonly scope: StateScope;
    readonly authority: IssuedAuthSession;
    readonly principalId: string;
    readonly clientIndex: number;
    readonly contextId: string;
}

export async function seedCompleteState(
    sql: Sql,
    scope: StateScope,
    workload: (typeof WORKLOADS)[number]
): Promise<void> {
    const pgSql = toApiV1PostgresClient(sql);
    const runtimeRepository = new PSqlRuntimeStateRepository(pgSql);
    const authSessionRepository = new AuthSessionRepository(runtimeRepository);
    const runtime = createStateWriteServiceRuntime({
        sql,
        serviceId: 'state-write-bench-seed',
        context: newRunContext(),
        timing: () => undefined
    });

    await mapWithConcurrency(
        Array.from({ length: workload.groups }, (_, groupIndex) => groupIndex),
        STATE_WRITE_REQUIRED_CONCURRENCY,
        async (groupIndex) => await seedBenchmarkGroup({ runtime, scope, authSessionRepository }, groupIndex)
    );

    await mapWithConcurrency(
        Array.from({ length: workload.clients }, (_, clientIndex) => clientIndex),
        STATE_WRITE_REQUIRED_CONCURRENCY,
        async (clientIndex) => await seedBenchmarkClient({ runtime, scope, authSessionRepository }, clientIndex)
    );
}

async function seedBenchmarkGroup(context: BenchmarkSeedContext, groupIndex: number): Promise<void> {
    const { runtime, scope, authSessionRepository } = context;
    const ownerId = `owner-${groupIndex}`;
    const authority = createBenchmarkAuthSession(
        scope,
        ownerId,
        `owner-session-${groupIndex}`
    );
    await authSessionRepository.putSession(authority);
    const groupId = `group-${groupIndex}`;
    await runAppInboxMutation(
        runtime,
        runtime.group.processAuthenticatedGroupEntryUntilCompletion(
            {
                type: AppInboxType.GROUP_CREATE,
                topicId: AppInboxType.GROUP_CREATE,
                resourceId: `seed-group-${groupIndex}`,
                contextId: toStateWriteBenchmarkGroupContextId(scope, groupId),
                senderId: ownerId,
                data: {
                    scope,
                    request: {
                        groupId,
                        displayName: `State Write Benchmark Group ${groupIndex}`,
                        kind: 'room',
                        joinMode: 'open',
                        maxMembers: CLIENT_COUNT + 1,
                        maxSessionsPerMember: 4,
                        metadata: { benchmark: true },
                        createdByPrincipalId: ownerId,
                        actorPrincipalId: ownerId,
                        actorSessionId: authority.sessionId,
                        requestId: `seed-group-${groupIndex}`
                    }
                }
            },
            authority
        )
    );
}

async function seedBenchmarkClient(context: BenchmarkSeedContext, clientIndex: number): Promise<void> {
    const { runtime, scope, authSessionRepository } = context;
    const principalId = `client-${clientIndex}`;
    const authority = createBenchmarkAuthSession(
        scope,
        principalId,
        `client-session-${clientIndex}`
    );
    await authSessionRepository.putSession(authority);
    const contextId = toAuthenticatedClientMutationContextId({
        scope,
        principalId,
        callerClientId: authority.clientId,
        callerSessionId: authority.sessionId
    });
    await seedClientPrincipal({ runtime, scope, authority, principalId, clientIndex, contextId });
    await seedClientInstance({ runtime, scope, authority, principalId, clientIndex, contextId });
}

async function seedClientPrincipal(input: BenchmarkSeedClient): Promise<void> {
    const { runtime, scope, authority, principalId, clientIndex, contextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.client.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                topicId: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
                resourceId: `seed-principal-${clientIndex}`,
                contextId,
                senderId: principalId,
                data: {
                    scope,
                    principalId,
                    request: {
                        username: principalId,
                        displayName: `Seed Client ${clientIndex}`,
                        status: 'active',
                        actorPrincipalId: principalId,
                        requestId: `seed-principal-${clientIndex}`
                    }
                }
            },
            authority
        )
    );
}

async function seedClientInstance(input: BenchmarkSeedClient): Promise<void> {
    const { runtime, scope, authority, principalId, clientIndex, contextId } = input;
    await runAppInboxMutation(
        runtime,
        runtime.client.processAuthenticatedEntryUntilCompletion(
            {
                type: AppInboxType.CLIENT_INSTANCE_UPSERT,
                topicId: AppInboxType.CLIENT_INSTANCE_UPSERT,
                resourceId: `seed-instance-${clientIndex}`,
                contextId,
                senderId: principalId,
                data: {
                    scope,
                    principalId,
                    clientInstanceId: `instance-${clientIndex}`,
                    request: {
                        status: 'active',
                        platform: 'web',
                        appVersion: 'seed',
                        actorPrincipalId: principalId,
                        requestId: `seed-instance-${clientIndex}`
                    }
                }
            },
            authority
        )
    );
}
