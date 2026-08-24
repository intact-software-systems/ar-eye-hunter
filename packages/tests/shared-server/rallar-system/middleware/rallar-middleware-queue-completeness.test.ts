import { createRallarMiddlewareQueueConstruction } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-construction.ts';
import type * as ComputeAsyncTask from '@shared/resilience/ComputeAsyncTask.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { describe, expect, it } from 'vitest';

const NO_WORK_TASK: ComputeAsyncTask.LoopsTaskDto = {
    name: 'registration-proof',
    maxConcurrency: () => 1,
    isWork: async () => false,
    runnable: async () => undefined,
    ongoingTasks: []
};

describe('Rallar middleware queue registration completeness', () => {
    it('releases the worker only after all four queue responsibilities are registered', () => {
        const queueConstruction = createRallarMiddlewareQueueConstruction();
        const registration = queueConstruction.beginTaskRegistration();
        for (
            const taskId of [
                WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
                WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
                InboxQueueReader.INBOX_ENQUEUE_TYPE,
                OutboxQueueReader.OUTBOX_ENQUEUE_TYPE
            ]
        ) {
            registration.queueTasks.includeTask(taskId, NO_WORK_TASK);
        }

        const completedRegistration = registration.complete();
        const worker = queueConstruction.finalise(completedRegistration);

        expect(worker.start).toBeTypeOf('function');
        expect(worker.stop).toBeTypeOf('function');
    });

    it('rejects registration evidence issued by another queue construction', () => {
        const first = createRallarMiddlewareQueueConstruction();
        const registration = first.beginTaskRegistration();
        for (
            const taskId of [
                WsQueueBoxServerService.INBOX_ENQUEUE_TYPE,
                WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE,
                InboxQueueReader.INBOX_ENQUEUE_TYPE,
                OutboxQueueReader.OUTBOX_ENQUEUE_TYPE
            ]
        ) {
            registration.queueTasks.includeTask(taskId, NO_WORK_TASK);
        }

        const completedRegistration = registration.complete();
        const second = createRallarMiddlewareQueueConstruction();

        expect(() => second.finalise(completedRegistration)).toThrow(
            'Rallar middleware queue task registration belongs to another queue runtime'
        );
    });
});
