import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

export interface RegisterRallarMiddlewareQueueTasksInput {
    readonly nowEpochMs: () => number;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResourceInboxResilience;
    readonly appOutboxResilience: ResourceInboxResilience;
}

export interface RegisterApplicationQueueReaderTasksInput {
    readonly engine: Pick<InboxOutboxEngine, 'includeTask' | 'wake' | 'wakeAt'>;
    readonly nowEpochMs: () => number;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResourceInboxResilience;
    readonly appOutboxResilience: ResourceInboxResilience;
}

interface QueueReaderTask {
    readonly taskId: string;
    readonly resilience: ResourceInboxResilience;
    readonly readIsWork: () => Promise<boolean>;
    readonly dequeue: () => Promise<number>;
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
        registerApplicationQueueReaderTasks({
            engine: this.#engine,
            nowEpochMs: input.nowEpochMs,
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
    includeQueueReaderTask(input, {
        taskId: InboxQueueReader.INBOX_ENQUEUE_TYPE,
        resilience: input.appInboxResilience,
        readIsWork: () =>
            input.inboxQueueReader.inbox.isAnyEntryToLock(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                input.appInboxResilience.toWorkAdvertisementOptions()
            ),
        dequeue: () =>
            input.inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                input.appInboxResilience
            )
    });
    includeQueueReaderTask(input, {
        taskId: OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
        resilience: input.appOutboxResilience,
        readIsWork: () =>
            input.outboxQueueReader.outbox.isAnyEntryToLock(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                input.appOutboxResilience.toWorkAdvertisementOptions()
            ),
        dequeue: () =>
            input.outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                input.appOutboxResilience
            )
    });
}

/**
 * A batch that claimed work wakes the engine, so the next claim does not wait out the idle backoff.
 * An open circuit, a failed readiness probe or a failed batch advertises no work and wakes the task
 * when it may run again, so none of them probes storage on every pass nor holds the task's only slot
 * while it waits. A failed probe still rethrows, so the engine reports it once for that pass.
 */
function includeQueueReaderTask(
    input: RegisterApplicationQueueReaderTasksInput,
    task: QueueReaderTask
): void {
    const failureBackoff = new QueueReaderFailureBackoff();
    input.engine.includeTask(task.taskId, {
        name: task.taskId,
        maxConcurrency: () => 1,
        isWork: async () => {
            const nowMs = input.nowEpochMs();
            const deferredUntilMs = task.resilience.getDequeueReopenAtMs(nowMs) ?? failureBackoff.getRetryAtMs(nowMs);
            if (deferredUntilMs !== undefined) {
                input.engine.wakeAt(task.taskId, deferredUntilMs);
                return false;
            }
            try {
                return await task.readIsWork();
            }
            catch (error) {
                input.engine.wakeAt(task.taskId, failureBackoff.recordFailure(input.nowEpochMs()));
                throw error;
            }
        },
        runnable: async () => {
            let claimedCount: number;
            try {
                claimedCount = await task.dequeue();
            }
            catch (error) {
                input.engine.wakeAt(task.taskId, failureBackoff.recordFailure(input.nowEpochMs()));
                throw error;
            }
            failureBackoff.recordSuccess();
            if (claimedCount > 0) {
                input.engine.wake();
            }
        },
        ongoingTasks: []
    });
}

/** Consecutive failed probes or batches wait 1, 2, 4, 8 and then 16 seconds before the task advertises work again. */
class QueueReaderFailureBackoff {
    static readonly BASE_DELAY_MS = 1_000;
    static readonly MAX_DELAY_MS = 16_000;

    #consecutiveFailures = 0;
    #retryAtMs: number | undefined;

    getRetryAtMs(nowMs: number): number | undefined {
        return this.#retryAtMs !== undefined && this.#retryAtMs > nowMs ? this.#retryAtMs : undefined;
    }

    recordFailure(nowMs: number): number {
        this.#consecutiveFailures += 1;
        const delayMs = Math.min(
            QueueReaderFailureBackoff.BASE_DELAY_MS * 2 ** (this.#consecutiveFailures - 1),
            QueueReaderFailureBackoff.MAX_DELAY_MS
        );
        this.#retryAtMs = nowMs + delayMs;
        return this.#retryAtMs;
    }

    recordSuccess(): void {
        this.#consecutiveFailures = 0;
        this.#retryAtMs = undefined;
    }
}
