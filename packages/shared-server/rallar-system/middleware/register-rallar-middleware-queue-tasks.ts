import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

import type {
    CreateRallarMiddlewareOptions,
    RallarMiddlewareInboxServices,
    RallarMiddlewareInfrastructure
} from './rallar-middleware-construction.ts';
import type {
    RallarMiddlewareQueueTaskRegistration,
    RallarMiddlewareQueueTaskRegistrationSession,
    RallarMiddlewareQueueTaskRegistry
} from './rallar-middleware-queue-construction.ts';

export interface RegisterRallarMiddlewareQueueTasksInput {
    readonly options: CreateRallarMiddlewareOptions;
    readonly queueTaskRegistration: RallarMiddlewareQueueTaskRegistrationSession;
    readonly infrastructure: RallarMiddlewareInfrastructure;
    readonly inboxServices: RallarMiddlewareInboxServices;
}

export interface RegisterQueueReaderEngineTasksInput {
    readonly queueTasks: RallarMiddlewareQueueTaskRegistry;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly appOutboxResilience: ResilienceDto;
}

export function registerRallarMiddlewareQueueTasks(
    input: RegisterRallarMiddlewareQueueTasksInput
): RallarMiddlewareQueueTaskRegistration {
    requireConfiguredInboxServices(input.options, input.inboxServices);
    const queueTasks = input.queueTaskRegistration.queueTasks;
    registerWsQueueBoxEngineTasks({
        queueTasks,
        wsQBoxServerService: input.infrastructure.wsQBoxServerService,
        inboxResilience: input.options.resilience.inbox,
        outboxResilience: input.options.resilience.outbox ?? input.options.resilience.inbox
    });
    registerQueueReaderEngineTasks({
        queueTasks,
        inboxQueueReader: input.infrastructure.inboxQueueReader,
        outboxQueueReader: input.infrastructure.outboxQueueReader,
        appInboxResilience: input.infrastructure.appInboxResilience,
        appOutboxResilience: input.infrastructure.appOutboxResilience
    });
    return input.queueTaskRegistration.complete();
}

export function registerQueueReaderEngineTasks(
    input: RegisterQueueReaderEngineTasksInput
): void {
    input.queueTasks.includeTask(InboxQueueReader.INBOX_ENQUEUE_TYPE, {
        name: InboxQueueReader.INBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            input.inboxQueueReader.inbox.isAnyEntryToLock(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                input.appInboxResilience.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            input.inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                input.appInboxResilience
            ),
        ongoingTasks: []
    });
    input.queueTasks.includeTask(OutboxQueueReader.OUTBOX_ENQUEUE_TYPE, {
        name: OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            input.outboxQueueReader.outbox.isAnyEntryToLock(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                input.appOutboxResilience.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            input.outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                input.appOutboxResilience
            ),
        ongoingTasks: []
    });
}

interface RegisterWsQueueBoxEngineTasksInput {
    readonly queueTasks: RallarMiddlewareQueueTaskRegistry;
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly inboxResilience: ResilienceDto;
    readonly outboxResilience: ResilienceDto;
}

function registerWsQueueBoxEngineTasks(input: RegisterWsQueueBoxEngineTasksInput): void {
    input.queueTasks.includeTask(WsQueueBoxServerService.INBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            input.wsQBoxServerService.inbox.isAnyEntryToLock(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                input.inboxResilience.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            input.wsQBoxServerService.dequeueInbox(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                input.inboxResilience
            ),
        ongoingTasks: []
    });
    input.queueTasks.includeTask(WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            input.wsQBoxServerService.outbox.isAnyEntryToLock(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                input.outboxResilience.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            input.wsQBoxServerService.dequeueOutbox(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                input.outboxResilience
            ),
        ongoingTasks: []
    });
}

function requireConfiguredInboxServices(
    options: CreateRallarMiddlewareOptions,
    services: RallarMiddlewareInboxServices
): void {
    if (
        !services.groupStateInboxService ||
        !services.topologyInboxService ||
        !services.rtcRttInboxService ||
        !services.appClientInboxService ||
        (options.createAppAuthInboxService !== undefined && services.appAuthInboxService === undefined) ||
        (options.createAppAdminInboxService !== undefined && services.appAdminInboxService === undefined) ||
        (options.createAppCrdtInboxService !== undefined && services.appCrdtInboxService === undefined)
    ) {
        throw new Error('Rallar middleware inbox service registration is incomplete');
    }
}
