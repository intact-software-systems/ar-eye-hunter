import { Temporal } from '@js-temporal/polyfill';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { NEVER_EXPIRE_TS, toResourceEntry, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
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
                },
                { ttlMs: 30_000 }
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

    it('preserves an absent message deadline without turning queue retention into a delivery TTL', () => {
        const msg = newALUnicastMessage('sender', { topicId: 'chat', contextId: 'room', resourceId: 'message' }, 'peer', 'chat.v1', {});
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox');
        expect(entry.audit.expiryTs.equals(NEVER_EXPIRE_TS)).toBe(true);
        expect(JSON.parse(entry.resource)).not.toHaveProperty('constraints');
    });

    it.each([
        { callerTtlMs: 500, expectedTtlMs: 500 },
        { callerTtlMs: 2_000, expectedTtlMs: 1_000 }
    ])('preserves the earliest caller/freshness bound when caller TTL is $callerTtlMs', ({ callerTtlMs, expectedTtlMs }) => {
        const msg: ALMessage = Object.freeze({
            ...newALUnicastMessage('sender', { topicId: 'chat', contextId: 'room', resourceId: 'message' }, 'peer', 'chat.v1', {}, { ttlMs: callerTtlMs }),
            qos: Object.freeze({ expiry: Object.freeze({ algo: 'fresh-until', opts: Object.freeze({ maxStalenessMs: 1_000 }) }) })
        });
        const serialized = JSON.stringify(msg);
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox');
        expect(entry.audit.expiryTs.epochMilliseconds).toBe(msg.id.ts + expectedTtlMs);
        expect(entry.resource).toBe(serialized);
        expect(JSON.stringify(msg)).toBe(serialized);
    });

    it('short-circuits defaultDequeue when resilience blocks dequeuing', async () => {
        const warnings: string[] = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation((message) => {
            warnings.push(String(message));
        });

        try {
            const queue = new InMemoryQueueBox();
            const entry = toResourceEntry('demo', { ok: true });
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
                { qbox: queue, typesToDequeue: new Set(['demo']), resilience: resilience, onDequeuedDo: onDequeued, options: {} }
            );

            expect(dequeuedEntries).toEqual([]);
            expect(warnings).toHaveLength(1);
        }
        finally {
            warn.mockRestore();
        }
    });
});
