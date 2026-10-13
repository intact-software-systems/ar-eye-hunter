import { Temporal } from '@js-temporal/polyfill';

import {
    newALRoute,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { toAppQueueCreatedBy } from '@shared/queuebox/AppQueueIdentity.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import type { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import type { RallarTimingSink } from '../../observability/timing.ts';
import { normalizeAppInboxOptions, type AppInboxOptions } from '../app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../app-inbox-persistence-ports.ts';
import type {
    AppInboxQueueMessageCreationDto,
    AppInboxQueueMessageFactory
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
            creationNow,
            newResourceId,
            createMessage,
            inboxQueueReader: input.inboxQueueReader,
            repository: input.resourceInboxRepository
        },
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
        { repository: input.resourceInboxRepository, creationNow, createMessage },
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

function createDefaultAppInboxQueueMessage(creation: AppInboxQueueMessageCreationDto): ALMessage {
    return newALUntargetedMessage(
        toAppQueueCreatedBy(creation.serviceId),
        newALRoute(creation.key.topicId, creation.key.contextId, creation.key.resourceId),
        creation.enqueue.type,
        creation.enqueue
    );
}
