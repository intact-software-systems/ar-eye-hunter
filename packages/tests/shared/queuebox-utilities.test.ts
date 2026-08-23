import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { describe, expect, it, vi } from 'vitest';

describe('QueueBoxUtilities', () => {
    it('maps AL messages to resource entries using the route as the queue key', () => {
        const expiresAtMs = Date.UTC(2026, 0, 1, 0, 0, 30);
        const msg = {
            ...newALUnicastMessage(
                'sender-1',
                {
                    topicId: 'chat',
                    resourceId: 'msg-1',
                    contextId: 'conversation-1'
                },
                'peer-1',
                'chat.private-text.v1',
                {
                    text: 'hello'
                }
            ),
            constraints: {
                expiresAtMs
            },
            audit: {
                createdBy: 'alice',
                createdTs: 123
            }
        };

        const entry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'ws.outbox');

        expect(entry.key).toEqual(msg.route);
        expect(entry.typeId).toBe('ws.outbox');
        expect(entry.audit.createdBy).toBe('alice');
        expect(entry.audit.expiryTs.epochMilliseconds).toBe(expiresAtMs);
        expect(JSON.parse(entry.resource)).toMatchObject({
            id: {
                msgId: msg.id.msgId
            },
            route: msg.route
        });
    });

    it('throws the retry sentinel error when the dequeue callback requests retry', async () => {
        const onDequeued = QueueBoxUtilities.withRetryDisposition(
            async () => 'retry'
        );

        await expect(
            onDequeued(QueueBoxUtilities.toResourceEntry('demo', { ok: true }))
        ).rejects.toThrow(QueueBoxUtilities.RETRY_DISPOSITION_ERROR);
    });

    it('returns normally when the dequeue callback reports completion', async () => {
        const onDequeued = QueueBoxUtilities.withRetryDisposition(
            async () => 'completed'
        );

        await expect(
            onDequeued(QueueBoxUtilities.toResourceEntry('demo', { ok: true }))
        ).resolves.toBeUndefined();
    });

    it('short-circuits defaultDequeue when resilience blocks dequeuing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        });

        try {
            const queue = new InMemoryQueueBox();
            const entry = QueueBoxUtilities.toResourceEntry('demo', { ok: true });
            const onDequeued = vi.fn<(entry: ResourceEntry) => Promise<void>>();

            await queue.enqueue(entry);

            await QueueBoxUtilities.defaultDequeue(
                queue,
                new Set(['demo']),
                {
                    isNotAllowedThroughToDequeue: () => true,
                    circuitBreaker: {
                        state: {
                            get: () => 'OPEN'
                        }
                    }
                } as unknown as ResilienceDto,
                onDequeued
            );

            expect(onDequeued).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledOnce();
        }
        finally {
            warn.mockRestore();
        }
    });
});
