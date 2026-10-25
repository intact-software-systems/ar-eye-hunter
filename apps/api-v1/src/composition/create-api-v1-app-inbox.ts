import { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/rallar-middleware-runtime.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';

import type { ApiV1MutationRuntime } from './create-api-v1-mutation-runtime.ts';

export interface CreateApiV1AppInboxInput {
    readonly mutation: ApiV1MutationRuntime;
    readonly runtime: Pick<RallarMiddlewareRuntime, 'inboxQueueReader' | 'qboxEngine'>;
    readonly timing: RallarTimingSink;
}

export function createApiV1AppInbox(input: CreateApiV1AppInboxInput): RallarServerAppInbox {
    return new RallarServerAppInbox({
        inboxQueueReader: input.runtime.inboxQueueReader,
        resourceInboxRepository: input.mutation.resourceInboxRepository.entries,
        resourceInboxResultsRepository: input.mutation.resourceInboxResultsRepository,
        database: input.mutation.database,
        wakeOwningQueue: () => input.runtime.qboxEngine.wake()
    }, {
        serviceId: input.mutation.serviceId,
        finishedRetentionMs: input.mutation.appInboxFinishedRetentionMs,
        options: input.mutation.appInboxOptions,
        timing: input.timing
    });
}
