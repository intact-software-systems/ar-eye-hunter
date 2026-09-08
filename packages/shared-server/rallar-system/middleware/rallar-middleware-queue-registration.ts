import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';

export interface RegisterRallarMiddlewareQueueTasksInput {
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly wsOutboxResilience: ResourceInboxResilience;
    readonly appInboxResilience: ResourceInboxResilience;
    readonly appOutboxResilience: ResourceInboxResilience;
}

export interface RegisterApplicationQueueReaderTasksInput {
    readonly engine: Pick<InboxOutboxEngine, 'includeTask'>;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResourceInboxResilience;
    readonly appOutboxResilience: ResourceInboxResilience;
}

export class RegisteredRallarMiddlewareQueueHandle {
    readonly #owner: RallarMiddlewareQueueRegistration;
    #consumed = false;

    constructor(owner: RallarMiddlewareQueueRegistration) {
        this.#owner = owner;
    }

    static consume(
        registeredQueue: RegisteredRallarMiddlewareQueueHandle,
        owner: RallarMiddlewareQueueRegistration
    ): void {
        if (!(#owner in registeredQueue) || registeredQueue.#owner !== owner) {
            throw new Error(
                'Rallar middleware queue task registration belongs to another queue runtime'
            );
        }
        if (registeredQueue.#consumed) {
            throw new Error(
                'Rallar middleware queue task registration has already been consumed'
            );
        }
        registeredQueue.#consumed = true;
    }
}

export class RallarMiddlewareQueueRegistration {
    readonly #engine: InboxOutboxEngine;
    #state: 'unregistered' | 'registered' | 'finalised' = 'unregistered';

    constructor(engine: InboxOutboxEngine) {
        this.#engine = engine;
    }

    registerExactTasks(
        input: RegisterRallarMiddlewareQueueTasksInput
    ): RegisteredRallarMiddlewareQueueHandle {
        if (this.#state !== 'unregistered') {
            throw new Error('Rallar middleware queue tasks have already been registered');
        }
        registerWsQueueBoxOutboxTask(this.#engine, input);
        registerApplicationQueueReaderTasks({
            engine: this.#engine,
            inboxQueueReader: input.inboxQueueReader,
            outboxQueueReader: input.outboxQueueReader,
            appInboxResilience: input.appInboxResilience,
            appOutboxResilience: input.appOutboxResilience
        });
        this.#state = 'registered';
        return new RegisteredRallarMiddlewareQueueHandle(this);
    }

    finalise(registration: RegisteredRallarMiddlewareQueueHandle): InboxOutboxEngine {
        RegisteredRallarMiddlewareQueueHandle.consume(registration, this);
        if (this.#state !== 'registered') {
            throw new Error('Rallar middleware queue task registration is incomplete');
        }
        this.#state = 'finalised';
        return this.#engine;
    }
}

export function createRallarMiddlewareQueueRegistration(
    engine: InboxOutboxEngine = new InboxOutboxEngine()
): RallarMiddlewareQueueRegistration {
    return new RallarMiddlewareQueueRegistration(engine);
}

export function registerApplicationQueueReaderTasks(
    input: RegisterApplicationQueueReaderTasksInput
): void {
    input.engine.includeTask(InboxQueueReader.INBOX_ENQUEUE_TYPE, {
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
    input.engine.includeTask(OutboxQueueReader.OUTBOX_ENQUEUE_TYPE, {
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

function registerWsQueueBoxOutboxTask(
    engine: Pick<InboxOutboxEngine, 'includeTask'>,
    input: RegisterRallarMiddlewareQueueTasksInput
): void {
    engine.includeTask(WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            input.wsQBoxServerService.outbox.isAnyEntryToLock(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                input.wsOutboxResilience.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            input.wsQBoxServerService.dequeueOutbox(
                WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
                input.wsOutboxResilience
            ),
        ongoingTasks: []
    });
}
