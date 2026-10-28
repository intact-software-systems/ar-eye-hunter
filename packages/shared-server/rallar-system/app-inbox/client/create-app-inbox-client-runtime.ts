import { Temporal } from '@js-temporal/polyfill';

import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import type { RallarTimingSink } from '../../observability/timing.ts';
import { normalizeAppInboxOptions, type AppInboxOptions } from '../app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../app-inbox-persistence-ports.ts';
import {
    createDefaultAppInboxQueueMessage,
    type AppInboxQueueMessageFactory
} from '../app-inbox-queue-entry.ts';
import { AppInboxCommandClient } from './app-inbox-command-client.ts';
import { AppInboxQueueEntryWriter } from './app-inbox-queue-entry-writer.ts';
import { AppInboxReservationClient } from './app-inbox-reservation-client.ts';
import { AppInboxResultWaiter } from './app-inbox-result-waiter.ts';

export interface CreateAppInboxClientRuntimeInput {
    readonly creationNow?: QueueBoxUtilities.CreationClock;
    readonly newResourceId?: () => string;
    readonly createMessage?: AppInboxQueueMessageFactory;
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
    const creationNow = input.creationNow ?? Temporal.Now.instant;
    const newResourceId = input.newResourceId ?? crypto.randomUUID.bind(crypto);
    const createMessage = input.createMessage ?? createDefaultAppInboxQueueMessage;
    const options = normalizeAppInboxOptions(input.options ?? {});
    const queueEntryWriter = new AppInboxQueueEntryWriter(
        {
            newResourceId,
            createMessage,
            inboxQueueReader: input.inboxQueueReader
        },
        {
            serviceId: input.serviceId,
            defaultTopicId: input.defaultTopicId,
            wakeOwningQueue: input.wakeOwningQueue
        }
    );
    const resultWaiter = new AppInboxResultWaiter(
        {
            completionNotifications: input.inboxQueueReader.completionNotifications,
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
        { repository: input.resourceInboxRepository, creationNow, createMessage },
        { serviceId: input.serviceId }
    );
    const commandClient = new AppInboxCommandClient(
        { queueEntryWriter, reservationClient, resultWaiter },
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
