import type * as ComputeAsyncTask from '@shared/resilience/ComputeAsyncTask.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';

export interface RallarMiddlewareQueueTaskRegistry {
    includeTask(id: string, task: ComputeAsyncTask.LoopsTaskDto): void;
}

class QueueTaskRegistrationProof {
    readonly #owner: QueueConstruction;

    constructor(owner: QueueConstruction) {
        this.#owner = owner;
    }

    requireOwner(owner: QueueConstruction): void {
        if (this.#owner !== owner) {
            throw new Error('Rallar middleware queue task registration belongs to another queue runtime');
        }
    }
}

class QueueTaskRegistrationSession {
    readonly #owner: QueueConstruction;
    readonly queueTasks: RallarMiddlewareQueueTaskRegistry;

    constructor(owner: QueueConstruction) {
        this.#owner = owner;
        this.queueTasks = {
            includeTask: (id, task) => {
                owner.includeTask(this, id, task);
            }
        };
    }

    complete(): QueueTaskRegistrationProof {
        return this.#owner.completeTaskRegistration(this);
    }
}

class QueueConstruction {
    readonly #engine = new InboxOutboxEngine();
    readonly #registeredTaskIds = new Set<string>();
    #activeRegistration: QueueTaskRegistrationSession | undefined;
    #registrationComplete = false;

    beginTaskRegistration(): QueueTaskRegistrationSession {
        if (this.#activeRegistration || this.#registrationComplete) {
            throw new Error('Rallar middleware queue task registration has already started');
        }
        const registration = new QueueTaskRegistrationSession(this);
        this.#activeRegistration = registration;
        return registration;
    }

    includeTask(
        registration: QueueTaskRegistrationSession,
        id: string,
        task: ComputeAsyncTask.LoopsTaskDto
    ): void {
        this.requireActiveRegistration(registration);
        this.#engine.includeTask(id, task);
        this.#registeredTaskIds.add(id);
    }

    completeTaskRegistration(
        registration: QueueTaskRegistrationSession
    ): QueueTaskRegistrationProof {
        this.requireActiveRegistration(registration);
        const missingTaskIds = REQUIRED_QUEUE_TASK_IDS.filter(
            (id) => !this.#registeredTaskIds.has(id)
        );
        if (missingTaskIds.length > 0) {
            throw new Error(
                `Rallar middleware queue task registration is incomplete: ${missingTaskIds.join(', ')}`
            );
        }
        this.#activeRegistration = undefined;
        this.#registrationComplete = true;
        return new QueueTaskRegistrationProof(this);
    }

    wake(): void {
        this.#engine.wake();
    }

    finalise(registration: QueueTaskRegistrationProof): InboxOutboxEngine {
        registration.requireOwner(this);
        if (!this.#registrationComplete) {
            throw new Error('Rallar middleware queue task registration is incomplete');
        }
        return this.#engine;
    }

    private requireActiveRegistration(registration: QueueTaskRegistrationSession): void {
        if (this.#activeRegistration !== registration || this.#registrationComplete) {
            throw new Error('Rallar middleware queue task registration is not active');
        }
    }
}

const REQUIRED_QUEUE_TASK_IDS = [
    WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
    WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
    InboxQueueReader.INBOX_ENQUEUE_TYPE,
    OutboxQueueReader.OUTBOX_ENQUEUE_TYPE
] as const;

export function createRallarMiddlewareQueueConstruction(): QueueConstruction {
    return new QueueConstruction();
}

export type RallarMiddlewareQueueConstruction = ReturnType<typeof createRallarMiddlewareQueueConstruction>;
export type RallarMiddlewareQueueTaskRegistrationSession = ReturnType<
    RallarMiddlewareQueueConstruction['beginTaskRegistration']
>;
export type RallarMiddlewareQueueTaskRegistration = ReturnType<
    RallarMiddlewareQueueTaskRegistrationSession['complete']
>;
