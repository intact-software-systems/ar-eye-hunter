import { hasAdvertisedDequeueWork, type DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { FailureBackoff } from '@shared/resilience/failure-backoff.ts';
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
    readonly engine: Pick<
        InboxOutboxEngine,
        'includeTask' | 'includeWakeListener' | 'wake' | 'wakeAt' | 'retainSettlingWork'
    >;
    readonly nowEpochMs: () => number;
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResourceInboxResilience;
    readonly appOutboxResilience: ResourceInboxResilience;
}

/** Consecutive failed probes or batches wait 1, 2, 4, 8 and then 16 seconds before the task advertises work again. */
const QUEUE_READER_FAILURE_BACKOFF: FailureBackoff.Config = { baseMs: 1_000, maxMs: 16_000 };

interface QueueReaderTask {
    readonly taskId: string;
    readonly resilience: ResourceInboxResilience;
    /** True while the next pass could claim nothing before a row the reader holds in flight settles. */
    readonly isAwaitingFlightSettlement: () => boolean;
    readonly readWorkAdvertisement: () => Promise<DequeueController.WorkAdvertisement>;
    readonly dequeue: (workAdvertisement: DequeueController.WorkAdvertisement | undefined) => Promise<number>;
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

/**
 * The AppInbox reader's flight rows outlive the pass that claimed them: the engine joins each on stop, and each
 * settlement wakes it, so the next pass tops the flight up at once instead of probing while it is full. Another
 * writer's AppInbox rows end a wait on the flight's own contexts, since they may belong to a context it does not hold.
 */
export function registerApplicationQueueReaderTasks(
    input: RegisterApplicationQueueReaderTasksInput
): void {
    input.inboxQueueReader.onFlightEntryDo((settlement) =>
        input.engine.retainSettlingWork(InboxQueueReader.INBOX_ENQUEUE_TYPE, settlement)
    );
    input.engine.includeWakeListener(
        `${InboxQueueReader.INBOX_ENQUEUE_TYPE}:flight`,
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        () => input.inboxQueueReader.resetFlightSettlementWait()
    );
    includeQueueReaderTask(input, {
        taskId: InboxQueueReader.INBOX_ENQUEUE_TYPE,
        resilience: input.appInboxResilience,
        isAwaitingFlightSettlement: () => input.inboxQueueReader.isAwaitingFlightSettlement(),
        readWorkAdvertisement: () =>
            input.inboxQueueReader.readWorkAdvertisement(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                input.appInboxResilience
            ),
        dequeue: (workAdvertisement) =>
            input.inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                input.appInboxResilience,
                workAdvertisement
            )
    });
    includeQueueReaderTask(input, {
        taskId: OutboxQueueReader.OUTBOX_ENQUEUE_TYPE,
        resilience: input.appOutboxResilience,
        isAwaitingFlightSettlement: () => false,
        readWorkAdvertisement: () =>
            input.outboxQueueReader.readWorkAdvertisement(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                input.appOutboxResilience
            ),
        dequeue: (workAdvertisement) =>
            input.outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                input.appOutboxResilience,
                workAdvertisement
            )
    });
}

/**
 * The probe that advertises work is one storage read naming the lanes with a claimable row, and the
 * batch the engine runs for it offers reservations to those lanes only: the engine runs a task's probe
 * and then its batch within one pass on the task's single slot, so the advertisement carries over.
 * A batch that claimed work wakes the engine, so the next claim does not wait out the idle backoff.
 * An open circuit, a failed readiness probe or a failed batch advertises no work and wakes the task
 * when it may run again, so none of them probes storage on every pass nor holds the task's only slot
 * while it waits. A failed probe still rethrows, so the engine reports it once for that pass. A reader
 * awaiting a flight settlement advertises no work either: the settlement wakes the engine.
 */
function includeQueueReaderTask(
    input: RegisterApplicationQueueReaderTasksInput,
    task: QueueReaderTask
): void {
    const failureBackoff = new FailureBackoff(QUEUE_READER_FAILURE_BACKOFF);
    let advertisedLanes: DequeueController.WorkAdvertisement | undefined;
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
            if (task.isAwaitingFlightSettlement()) {
                return false;
            }
            try {
                advertisedLanes = await task.readWorkAdvertisement();
                return hasAdvertisedDequeueWork(advertisedLanes);
            }
            catch (error) {
                input.engine.wakeAt(task.taskId, failureBackoff.recordFailure(input.nowEpochMs()));
                throw error;
            }
        },
        runnable: async () => {
            const workAdvertisement = advertisedLanes;
            advertisedLanes = undefined;
            let claimedCount: number;
            try {
                claimedCount = await task.dequeue(workAdvertisement);
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
