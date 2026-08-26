import { Temporal } from '@js-temporal/polyfill';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { PSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import type { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import type { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import type { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';

import type { PersistedAppInboxAttempt } from './postgres-app-inbox-attempt-observation.ts';
import { createPostgresAppInboxWorkerServices } from './postgres-app-inbox-worker-services.ts';
import { waitForPostgresWorkerBarrier, type WorkerBarrier } from './postgres-worker-barrier.ts';
import { createPostgresWorkerTransactionGate } from './postgres-worker-transaction-gate.ts';

export interface PostgresAppInboxWorkerTrace {
    barrierWaitCount: number;
    attempts: PersistedAppInboxAttempt[];
}

export type TopologyReadBarrierPrimitive = 'readRuntimeStateBatch';

export interface PostgresAppInboxWorkerRuntime {
    readonly client: AppClientInboxService;
    readonly group: GroupStateInboxService;
    readonly topology: TopologyInboxService;
    readonly authSessions: AuthSessionRepository;
    readonly resourceInbox: PSqlResourceInboxRepository;
    readonly resourceInboxResults: ResourceInboxResultsRepository;
    armBarrier(): void;
    runUntilCompletion<R>(start: () => Promise<R>): Promise<R>;
    runUntilAllCompletion<R>(starts: readonly (() => Promise<R>)[]): Promise<readonly R[]>;
}

export function createPostgresAppInboxWorkerTrace(): PostgresAppInboxWorkerTrace {
    return { barrierWaitCount: 0, attempts: [] };
}

export function createPostgresAppInboxWorkerRuntime(
    input: Readonly<{
        sql: PSqlSql;
        serviceId: string;
        atEpochMs: number;
        barrier?: WorkerBarrier;
        beforeTopologyConfigRead?: (primitive: TopologyReadBarrierPrimitive) => Promise<void>;
        beforeMutationTransaction?: () => Promise<void>;
        trace: PostgresAppInboxWorkerTrace;
    }>
): PostgresAppInboxWorkerRuntime {
    const barrier = input.barrier;
    const beforeMutationTransaction = input.beforeMutationTransaction ??
        (barrier
            ? async () => await waitForPostgresWorkerBarrier(barrier, input.serviceId)
            : undefined);
    const transactionGate = createPostgresWorkerTransactionGate({
        sql: input.sql,
        beforeMutationTransaction,
        trace: input.trace
    });
    const services = createPostgresAppInboxWorkerServices({
        ...input,
        transactionSql: transactionGate.sql
    });

    const runUntilAllCompletion = async <R>(
        starts: readonly (() => Promise<R>)[]
    ): Promise<readonly R[]> => {
        let settled = false;
        const pending = Promise.all(starts.map((start) => start())).finally(() => (settled = true));
        while (!settled) {
            await services.inbox.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createWorkerResilience()
            );
            await yieldEventLoop();
        }
        return await pending;
    };

    return {
        client: services.client,
        group: services.group,
        topology: services.topology,
        authSessions: services.authSessions,
        resourceInbox: services.resourceInbox,
        resourceInboxResults: services.resourceInboxResults,
        armBarrier: transactionGate.arm,
        runUntilCompletion: async <R>(start: () => Promise<R>) => {
            const [result] = await runUntilAllCompletion([start]);
            if (result === undefined) {
                throw new TypeError('AppInbox worker completed without a result');
            }
            return result;
        },
        runUntilAllCompletion
    };
}

function createWorkerResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(100, duration, duration, duration),
        1,
        1,
        1,
        1
    );
}

function yieldEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
