import { describe, expect, it } from 'vitest';
import {
    DequeueController,
    type FailureDto,
    Reservator,
    type SuccessDto,
} from '@shared/queuebox/DequeueController.ts';

describe('resource inbox fairness precedence', () => {
    it('lets the fairness selector claim an overdue retry before the ordinary retry lane', async () => {
        let available = true;
        const reserveEligibleRetry = async () => {
            if (!available) return new Map<string, string>();
            available = false;
            return new Map([['overdue', 'work']]);
        };
        const controller = DequeueController.create<string, string, string>()
            .withMaxNumToDequeue(1)
            .withMaxNumToReserve(() => 1)
            .withInboxTypesToDequeue(() => new Set(['APP_INBOX']))
            .withReturnDequeuedEntries(true)
            .onCheckIsTypesToDequeueDo(() => available)
            .onNewEntriesReserveDo(async () => new Map())
            .onRetryEntriesReserveDo(reserveEligibleRetry)
            .onFairnessEntriesReserveDo(reserveEligibleRetry)
            .onReleaseEntriesDo(
                async (entries: Map<string, SuccessDto<string, string, string>>) => entries,
                async (entries: Map<string, FailureDto<string, string>>) => entries,
            );

        const dequeued = await controller.dequeueForCompute(async () => 'done');

        expect(dequeued.get(Reservator.FAIRNESS)?.has('overdue')).toBe(true);
        expect(dequeued.get(Reservator.RETRY)?.size).toBe(0);
    });
});
