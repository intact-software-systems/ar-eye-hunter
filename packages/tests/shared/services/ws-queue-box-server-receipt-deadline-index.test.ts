import { describe, expect, it } from 'vitest';

import { WsQueueBoxServerReceiptDeadlineIndex } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-deadline-index.ts';

describe('WS server receipt deadline index', () => {
    it('fires the next sweep at the second deadline once the earliest of three aggregates leaves', () => {
        const index = new WsQueueBoxServerReceiptDeadlineIndex();
        index.add('first', 10_000);
        index.add('third', 30_000);
        index.add('second', 20_000);

        index.delete('first');

        expect(index.getNextDeadlineAtMs()).toBe(20_000);
        expect(index.takeDue(25_000)).toEqual(['second']);
        expect(index.getNextDeadlineAtMs()).toBe(30_000);
    });

    it('takes every due deadline in deadline order and leaves the rest', () => {
        const index = new WsQueueBoxServerReceiptDeadlineIndex();
        for (const [key, deadlineAtMs] of [['d', 40], ['b', 20], ['e', 50], ['a', 10], ['c', 30]] as const) {
            index.add(key, deadlineAtMs);
        }
        index.delete('c');
        index.delete('missing');

        expect(index.takeDue(40)).toEqual(['a', 'b', 'd']);
        expect(index.getNextDeadlineAtMs()).toBe(50);
        expect(index.takeDue(Number.MAX_SAFE_INTEGER)).toEqual(['e']);
        expect(index.getNextDeadlineAtMs()).toBeUndefined();
    });
});
