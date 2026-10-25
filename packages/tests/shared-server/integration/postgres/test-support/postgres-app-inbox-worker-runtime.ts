import { Temporal } from '@js-temporal/polyfill';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { PSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import type { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import type { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import type { TopologyInboxService } from '@shared-server/rallar-system/topology/inbox/topology-inbox-service.ts';

import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../../rallar-system/app-inbox/test-support/test-app-inbox-finished-retention.ts';
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
    /** Runs AppInbox passes until the given work settles, for work enqueued before the first pass. */
    dequeueUntilSettled<R>(pending: Promise<R>): Promise<R>;
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
        /** Absent: the committed default window, for tests that do not exercise retention. */
        finishedRetentionMs?: number;
        /** Absent: one head per NEW round, so the in-process exclusion keys never meet. */
        newLaneConcurrency?: number;
        /** The rows a standing NEW-lane flight holds across passes; undefined drains what each pass claims. */
        newLaneHeldRows: number | undefined;
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
    const flightSettlements: Promise<void>[] = [];
    const services = createPostgresAppInboxWorkerServices({
        ...input,
        finishedRetentionMs: input.finishedRetentionMs ?? TEST_APP_INBOX_FINISHED_RETENTION_MS,
        newLaneConcurrency: input.newLaneConcurrency ?? 1,
        flightEntryListener: (settlement) => flightSettlements.push(settlement),
        transactionSql: transactionGate.sql
    });

    // A standing flight's pass returns while its rows run, so an empty top-up waits briefly before it claims again.
    const dequeueUntilSettled = async <R>(pending: Promise<R>): Promise<R> => {
        let settled = false;
        const observed = pending.finally(() => (settled = true));
        while (!settled) {
            const claimed = await services.inbox.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createWorkerResilience()
            );
            await (claimed === 0 && input.newLaneHeldRows !== undefined ? waitMs(2) : yieldEventLoop());
        }
        await Promise.all(flightSettlements);
        return await observed;
    };
    const runUntilAllCompletion = async <R>(
        starts: readonly (() => Promise<R>)[]
    ): Promise<readonly R[]> => await dequeueUntilSettled(Promise.all(starts.map((start) => start())));

    return {
        client: services.client,
        group: services.group,
        topology: services.topology,
        authSessions: services.authSessions,
        resourceInbox: services.resourceInbox,
        resourceInboxResults: services.resourceInboxResults,
        armBarrier: transactionGate.arm,
        dequeueUntilSettled,
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

function createWorkerResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(100, duration, duration, duration));
}

function yieldEventLoop(): Promise<void> {
    return waitMs(0);
}

function waitMs(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
