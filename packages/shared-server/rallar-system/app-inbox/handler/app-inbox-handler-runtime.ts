import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';

import { nowMs, type RallarTimingSink } from '../../observability/timing.ts';
import type { AppInboxOptions } from '../app-inbox-options.ts';
import type { AppInboxResultRepository } from '../app-inbox-persistence-ports.ts';
import { AppInboxDequeuePassTiming } from './app-inbox-dequeue-pass-timing.ts';
import { AppInboxHandlerExecutor } from './app-inbox-handler-executor.ts';
import { AppInboxHandlerRegistry } from './app-inbox-handler-registry.ts';
import { AppInboxTransactionWriter } from './app-inbox-transaction-writer.ts';

export interface AppInboxHandlerRuntime {
    readonly registry: AppInboxHandlerRegistry;
    readonly transactionWriter: AppInboxTransactionWriter;
}

export interface CreateAppInboxHandlerRuntimeInput {
    readonly inboxQueueReader: InboxQueueReader;
    readonly resultRepository: AppInboxResultRepository;
    readonly database: PSqlSql;
    readonly serviceId: string;
    readonly timing?: RallarTimingSink;
    readonly options?: AppInboxOptions;
}

export function createAppInboxHandlerRuntime(
    input: CreateAppInboxHandlerRuntimeInput
): AppInboxHandlerRuntime {
    const nowEpochMs = input.options?.nowEpochMs ?? Date.now;
    const transactionWriter = new AppInboxTransactionWriter(
        {
            database: input.database,
            nowEpochMs,
            completionNotifications: input.inboxQueueReader.completionNotifications
        },
        {
            serviceId: input.serviceId,
            timing: input.timing
        }
    );
    const handlerExecutor = new AppInboxHandlerExecutor(
        {
            resultRepository: input.resultRepository,
            transactionWriter,
            database: input.database,
            nowEpochMs
        },
        {
            serviceId: input.serviceId,
            timing: input.timing,
            options: input.options
        }
    );
    const registry = new AppInboxHandlerRegistry(
        {
            inboxQueueReader: input.inboxQueueReader,
            handlerExecutor
        },
        { serviceId: input.serviceId }
    );
    if (input.timing !== undefined && (input.options?.phaseTiming ?? false)) {
        input.inboxQueueReader.onDequeuePassDo(
            new AppInboxDequeuePassTiming(
                { database: input.database, nowMs },
                { serviceId: input.serviceId, sink: input.timing }
            )
        );
    }
    return { registry, transactionWriter };
}
