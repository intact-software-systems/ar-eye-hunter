import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

export interface RegisterRallarMiddlewareQueueTasksInput {
    readonly wsQBoxServerService: WsQueueBoxServerService;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly wsInboxResilience: ResilienceDto;
    readonly wsOutboxResilience: ResilienceDto;
    readonly appInboxResilience: ResilienceDto;
    readonly appOutboxResilience: ResilienceDto;
}

export interface RegisterApplicationQueueReaderTasksInput {
    readonly engine: Pick<InboxOutboxEngine, 'includeTask'>;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly appOutboxResilience: ResilienceDto;
}

class RegisteredRallarMiddlewareQueue {
    readonly #nominalIdentity = true;
}

interface RegisteredQueueState {
    readonly owner: RallarMiddlewareQueueRegistrationOwner;
    consumed: boolean;
}

const registeredQueueStates = new WeakMap<RegisteredRallarMiddlewareQueue, RegisteredQueueState>();

class RallarMiddlewareQueueRegistrationOwner {
    readonly #engine = new InboxOutboxEngine();
    #state: 'unregistered' | 'registered' | 'finalised' = 'unregistered';

    wake(): void {
        this.#engine.wake();
    }

    registerExactTasks(
        input: RegisterRallarMiddlewareQueueTasksInput
    ): RegisteredRallarMiddlewareQueue {
        if (this.#state !== 'unregistered') {
            throw new Error('Rallar middleware queue tasks have already been registered');
        }
        registerWsQueueBoxTasks(this.#engine, input);
        registerApplicationQueueReaderTasks({
            engine: this.#engine,
            inboxQueueReader: input.inboxQueueReader,
            outboxQueueReader: input.outboxQueueReader,
            appInboxResilience: input.appInboxResilience,
            appOutboxResilience: input.appOutboxResilience
        });
        this.#state = 'registered';
        const registeredQueue = new RegisteredRallarMiddlewareQueue();
        registeredQueueStates.set(registeredQueue, { owner: this, consumed: false });
        return registeredQueue;
    }

    finalise(registration: RegisteredRallarMiddlewareQueue): InboxOutboxEngine {
        consumeRegisteredQueue(registration, this);
        if (this.#state !== 'registered') {
            throw new Error('Rallar middleware queue task registration is incomplete');
        }
        this.#state = 'finalised';
        return this.#engine;
    }
}

function consumeRegisteredQueue(
    registeredQueue: RegisteredRallarMiddlewareQueue,
    owner: RallarMiddlewareQueueRegistrationOwner
): void {
    const state = registeredQueueStates.get(registeredQueue);
    if (!state || state.owner !== owner) {
        throw new Error('Rallar middleware queue task registration belongs to another queue runtime');
    }
    if (state.consumed) {
        throw new Error('Rallar middleware queue task registration has already been consumed');
    }
    state.consumed = true;
}

export function createRallarMiddlewareQueueRegistration(): RallarMiddlewareQueueRegistrationOwner {
    return new RallarMiddlewareQueueRegistrationOwner();
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

function registerWsQueueBoxTasks(
    engine: Pick<InboxOutboxEngine, 'includeTask'>,
    input: RegisterRallarMiddlewareQueueTasksInput
): void {
    engine.includeTask(WsQueueBoxServerService.INBOX_ENQUEUE_TYPE, {
        name: WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
        maxConcurrency: () => 1,
        isWork: () =>
            input.wsQBoxServerService.inbox.isAnyEntryToLock(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                input.wsInboxResilience.toWorkAdvertisementOptions()
            ),
        runnable: () =>
            input.wsQBoxServerService.dequeueInbox(
                WsQueueBoxServerService.INBOX_DEQUEUE_TYPES,
                input.wsInboxResilience
            ),
        ongoingTasks: []
    });
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

export type RallarMiddlewareQueueRegistration = ReturnType<typeof createRallarMiddlewareQueueRegistration>;
export type RegisteredRallarMiddlewareQueueHandle = ReturnType<RallarMiddlewareQueueRegistration['registerExactTasks']>;
