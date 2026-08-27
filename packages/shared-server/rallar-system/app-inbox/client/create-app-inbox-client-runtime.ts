import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { RallarTimingSink } from '../../observability/timing.ts';
import type { AppInboxOptions } from '../app-inbox-options.ts';
import { normalizeAppInboxOptions } from '../app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../app-inbox-persistence-ports.ts';
import { AppInboxCommandClient } from './app-inbox-command-client.ts';
import { AppInboxQueueEntryWriter } from './app-inbox-queue-entry-writer.ts';
import { AppInboxReservationClient } from './app-inbox-reservation-client.ts';
import { AppInboxResultWaiter } from './app-inbox-result-waiter.ts';

export interface CreateAppInboxClientRuntimeInput {
    readonly inboxQueueReader: InboxQueueReader;
    readonly resourceInboxRepository: AppInboxEntryRepository;
    readonly resourceInboxResultsRepository: AppInboxResultRepository;
    readonly serviceId: string;
    readonly defaultTopicId: string;
    readonly timing?: RallarTimingSink;
    readonly options?: AppInboxOptions;
    readonly wakeOwningQueue?: () => void;
}

export interface AppInboxClientRuntime {
    readonly commandClient: AppInboxCommandClient;
    readonly queueEntryWriter: AppInboxQueueEntryWriter;
    readonly reservationClient: AppInboxReservationClient;
    readonly resultWaiter: AppInboxResultWaiter;
}

export function createAppInboxClientRuntime(
    input: CreateAppInboxClientRuntimeInput
): AppInboxClientRuntime {
    const options = normalizeAppInboxOptions(input.options ?? {});
    const queueEntryWriter = new AppInboxQueueEntryWriter(
        { inboxQueueReader: input.inboxQueueReader },
        {
            serviceId: input.serviceId,
            defaultTopicId: input.defaultTopicId,
            wakeOwningQueue: input.wakeOwningQueue
        }
    );
    const resultWaiter = new AppInboxResultWaiter(
        {
            statusRepository: input.resourceInboxRepository,
            resultRepository: input.resourceInboxResultsRepository
        },
        {
            serviceId: input.serviceId,
            timing: input.timing,
            options,
            wakeOwningQueue: input.wakeOwningQueue
        }
    );
    const reservationClient = new AppInboxReservationClient(
        {
            inboxQueueReader: input.inboxQueueReader,
            repository: input.resourceInboxRepository
        },
        { serviceId: input.serviceId }
    );
    const commandClient = new AppInboxCommandClient(
        { queueEntryWriter, resultWaiter },
        {
            serviceId: input.serviceId,
            timing: input.timing,
            options
        }
    );

    return {
        commandClient,
        queueEntryWriter,
        reservationClient,
        resultWaiter
    };
}
