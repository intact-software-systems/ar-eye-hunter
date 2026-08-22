import { RtcDataChannelSendQueue } from '@shared/webrtc/RtcDataChannelSendQueue.ts';
import { describe, expect, it } from 'vitest';

type TestPayload = Readonly<{
    seq: number;
}>;

describe('RtcDataChannelSendQueue', () => {
    it('queues and shifts payloads in FIFO order', () => {
        const queue = new RtcDataChannelSendQueue<TestPayload>();

        expect(queue.offer(queued(1), queuePolicy(2))).toMatchObject({
            status: 'queued',
            reason: 'Queued payload'
        });
        expect(queue.offer(queued(2), queuePolicy(2))).toMatchObject({
            status: 'queued',
            reason: 'Queued payload'
        });

        expect(queue.size).toBe(2);
        expect(queue.shift()?.payload.seq).toBe(1);
        expect(queue.shift()?.payload.seq).toBe(2);
        expect(queue.shift()).toBeUndefined();
        expect(queue.size).toBe(0);
    });

    it('replaces a queued payload by key without changing queue order', () => {
        const queue = new RtcDataChannelSendQueue<TestPayload>();
        const policy = replaceByKeyPolicy(3);

        queue.offer(queued(1, 'a'), policy);
        queue.offer(queued(2, 'b'), policy);
        queue.offer(queued(3, 'c'), policy);

        expect(queue.offer(queued(4, 'b'), policy)).toMatchObject({
            status: 'replaced',
            reason: 'Replaced queued payload',
            key: 'b'
        });

        expect(queue.shift()?.payload.seq).toBe(1);
        expect(queue.shift()?.payload.seq).toBe(4);
        expect(queue.shift()?.payload.seq).toBe(3);
        expect(queue.shift()).toBeUndefined();
    });

    it('drops the oldest queued payload before enqueueing a newer payload', () => {
        const queue = new RtcDataChannelSendQueue<TestPayload>();
        const policy = dropOldPolicy(1);

        expect(queue.offer(queued(1), policy)).toMatchObject({
            status: 'queued',
            reason: 'Queued payload after dropping oldest',
            droppedOldest: false
        });
        expect(queue.offer(queued(2), policy)).toMatchObject({
            status: 'queued',
            reason: 'Queued payload after dropping oldest',
            droppedOldest: true
        });

        expect(queue.size).toBe(1);
        expect(queue.shift()?.payload.seq).toBe(2);
        expect(queue.shift()).toBeUndefined();
    });

    it('drops a new payload without mutating the queue when the queue is full', () => {
        const queue = new RtcDataChannelSendQueue<TestPayload>();
        const policy = queuePolicy(1);

        queue.offer(queued(1), policy);

        expect(queue.offer(queued(2), policy)).toMatchObject({
            status: 'dropped',
            reason: 'Queue full'
        });

        expect(queue.size).toBe(1);
        expect(queue.shift()?.payload.seq).toBe(1);
        expect(queue.shift()).toBeUndefined();
    });

    it('updates key lookup after shifting queued payloads', () => {
        const queue = new RtcDataChannelSendQueue<TestPayload>();
        const policy = replaceByKeyPolicy(3);

        queue.offer(queued(1, 'a'), policy);
        queue.offer(queued(2, 'b'), policy);

        expect(queue.shift()?.payload.seq).toBe(1);
        expect(queue.offer(queued(3, 'b'), policy)).toMatchObject({
            status: 'replaced',
            reason: 'Replaced queued payload',
            key: 'b'
        });

        expect(queue.size).toBe(1);
        expect(queue.shift()?.payload.seq).toBe(3);
        expect(queue.shift()).toBeUndefined();
    });
});

function queued(
    seq: number,
    key?: string
) {
    return {
        payload: { seq },
        key,
        createdAtEpochMs: seq
    };
}

function queuePolicy(maxQueueItems: number) {
    return {
        overflow: 'queue' as const,
        maxQueueItems
    };
}

function replaceByKeyPolicy(maxQueueItems: number) {
    return {
        overflow: 'replace-by-key' as const,
        maxQueueItems
    };
}

function dropOldPolicy(maxQueueItems: number) {
    return {
        overflow: 'drop-old' as const,
        maxQueueItems
    };
}
