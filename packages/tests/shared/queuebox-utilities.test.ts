import { Temporal } from '@js-temporal/polyfill';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
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
        const warnings: string[] = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation((message) => {
            warnings.push(String(message));
        });

        try {
            const queue = new InMemoryQueueBox();
            const entry = QueueBoxUtilities.toResourceEntry('demo', { ok: true });
            const dequeuedEntries: ResourceEntry[] = [];
            const onDequeued = async (dequeued: ResourceEntry) => {
                dequeuedEntries.push(dequeued);
            };

            await queue.enqueue(entry);
            const duration = Temporal.Duration.from({ seconds: 10 });
            const resilience = ResilienceDto.toResilienceDto(
                new CircuitBreakerPolicy(1, duration, duration, duration),
                1,
                1,
                1,
                1
            );
            resilience.circuitBreaker.failureCount(2);

            await QueueBoxUtilities.defaultDequeue(
                queue,
                new Set(['demo']),
                resilience,
                onDequeued
            );

            expect(dequeuedEntries).toEqual([]);
            expect(warnings).toHaveLength(1);
        }
        finally {
            warn.mockRestore();
        }
    });
});
