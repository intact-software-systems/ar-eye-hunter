import { Temporal } from '@js-temporal/polyfill';
import {
    createRallarMiddlewareQueueRegistration,
    type RegisterRallarMiddlewareQueueTasksInput
} from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar middleware queue registration completeness', () => {
    it('does not expose caller-supplied task registration', () => {
        const registration = createRallarMiddlewareQueueRegistration();

        expect(registration).not.toHaveProperty('beginTaskRegistration');
        expect(registration).not.toHaveProperty('includeTask');
        expect(registration).not.toHaveProperty('queueTasks');
    });

    it('releases the worker only after its canonical tasks are registered', () => {
        const registration = createRallarMiddlewareQueueRegistration();
        const registeredQueue = registration.registerExactTasks(createQueueTaskInput());

        const worker = registration.finalise(registeredQueue);

        expect(worker.start).toBeTypeOf('function');
        expect(worker.stop).toBeTypeOf('function');
    });

    it('rejects registration evidence issued by another queue owner', () => {
        const first = createRallarMiddlewareQueueRegistration();
        const registeredQueue = first.registerExactTasks(createQueueTaskInput());
        const second = createRallarMiddlewareQueueRegistration();

        expect(() => second.finalise(registeredQueue)).toThrow(
            'Rallar middleware queue task registration belongs to another queue runtime'
        );
    });

    it('rejects caller-forged registration evidence', () => {
        const registration = createRallarMiddlewareQueueRegistration();

        expect(() => Reflect.apply(registration.finalise, registration, [{}])).toThrow(
            'Rallar middleware queue task registration belongs to another queue runtime'
        );
    });

    it('consumes registration evidence during final assembly', () => {
        const registration = createRallarMiddlewareQueueRegistration();
        const registeredQueue = registration.registerExactTasks(createQueueTaskInput());

        registration.finalise(registeredQueue);

        expect(() => registration.finalise(registeredQueue)).toThrow(
            'Rallar middleware queue task registration has already been consumed'
        );
    });
});

function createQueueTaskInput(): RegisterRallarMiddlewareQueueTasksInput {
    const queue = new InMemoryQueueBox();
    const resilience = createResilience();
    return {
        wsQBoxServerService: createDefaultWsQueueBoxServerService({
            inbox: queue,
            outbox: queue,
            socket: new JsonWebSocketServer(),
            name: 'queue-registration-test'
        }),
        inboxQueueReader: new InboxQueueReader(queue),
        outboxQueueReader: new OutboxQueueReader(queue),
        wsInboxResilience: resilience,
        wsOutboxResilience: resilience,
        appInboxResilience: resilience,
        appOutboxResilience: resilience
    };
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
        ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
        DEFAULT_RESOURCE_INBOX_RETRY_POLICY
    );
}
