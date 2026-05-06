import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservableLatestValue, type ObservableValueEvent, } from '@shared/cache/ObservableLatestValue.ts';

describe('ObservableLatestValue', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('emits created, updated, refreshed, and deleted events', async () => {
        const latest = new ObservableLatestValue<number>();
        const events: Array<ObservableValueEvent<number>> = [];

        latest.onChangeDo((event) => {
            events.push(event);
        });

        latest.accept(1);
        latest.accept(2);
        latest.accept(2);
        latest.clear();
        await latest.whenIdle();

        expect(events.map((event) => event.type)).toEqual([
            'created',
            'updated',
            'refreshed',
            'deleted',
        ]);
        expect(events[0]).toMatchObject({
            type: 'created',
            value: 1,
        });
        expect(events[1]).toMatchObject({
            type: 'updated',
            value: 2,
            previous: 1,
        });
        expect(events[2]).toMatchObject({
            type: 'refreshed',
            value: 2,
            previous: 2,
        });
        expect(events[3]).toMatchObject({
            type: 'deleted',
            previous: 2,
        });
    });

    it('uses custom equality to classify refreshed writes', async () => {
        const latest = new ObservableLatestValue<{ version: number; name: string }>({
            equals: (left, right) => left.version === right.version,
        });
        const events: string[] = [];

        latest.onChangeDo((event) => {
            events.push(event.type);
        });

        latest.accept({ version: 1, name: 'Alpha' });
        latest.accept({ version: 1, name: 'Beta' });
        latest.accept({ version: 2, name: 'Beta' });
        await latest.whenIdle();

        expect(events).toEqual(['created', 'refreshed', 'updated']);
    });

    it('emits refreshed from touch and deleted from takeIfExpired', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const latest = new ObservableLatestValue<number>({
            ttlMs: 100,
        });
        const events: string[] = [];

        latest.onChangeDo((event) => {
            events.push(event.type);
        });

        latest.accept(1);
        expect(latest.touch()).toBe(true);

        vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
        expect(latest.takeIfExpired()).toBe(1);
        await latest.whenIdle();

        expect(events).toEqual(['created', 'refreshed', 'deleted']);
    });

    it('supports type-specific subscriptions and idempotent unsubscribe', async () => {
        const latest = new ObservableLatestValue<number>();
        const created = vi.fn();
        const updated = vi.fn();
        const subscription = latest.onCreatedDo(created);

        latest.onUpdatedDo(updated);
        latest.accept(1);
        subscription.unsubscribe();
        subscription.unsubscribe();
        latest.accept(2);
        await latest.whenIdle();

        expect(created).toHaveBeenCalledTimes(1);
        expect(updated).toHaveBeenCalledTimes(1);
        expect(updated.mock.calls[0]?.[0]).toMatchObject({
            type: 'updated',
            value: 2,
            previous: 1,
        });
    });

    it('runs async observers in event order without blocking writes', async () => {
        vi.useFakeTimers();

        const latest = new ObservableLatestValue<number>();
        const events: string[] = [];

        latest.onChangeDo(async (event) => {
            events.push(`start-${event.type}-${event.value ?? event.previous}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
            events.push(`end-${event.type}-${event.value ?? event.previous}`);
        });

        latest.accept(1);
        latest.accept(2);

        expect(latest.read()).toBe(2);
        expect(events).toEqual([]);

        const idle = latest.whenIdle();
        await vi.advanceTimersByTimeAsync(10);
        expect(events).toEqual([
            'start-created-1',
            'end-created-1',
            'start-updated-2',
        ]);

        await vi.advanceTimersByTimeAsync(10);
        await idle;
        expect(events).toEqual([
            'start-created-1',
            'end-created-1',
            'start-updated-2',
            'end-updated-2',
        ]);
    });

    it('isolates observer failures and reports them', async () => {
        const errors: string[] = [];
        const latest = new ObservableLatestValue<number>({
            onObserverError: (error) => {
                errors.push(error instanceof Error ? error.message : String(error));
            },
        });
        const successful = vi.fn();

        latest.onCreatedDo(() => {
            throw new Error('observer failed');
        });
        latest.onCreatedDo(successful);

        latest.accept(1);
        await latest.whenIdle();

        expect(errors).toEqual(['observer failed']);
        expect(successful).toHaveBeenCalledTimes(1);
    });

    it('waits for events enqueued by observers before becoming idle', async () => {
        const latest = new ObservableLatestValue<number>();
        const events: string[] = [];

        latest.onCreatedDo((event) => {
            events.push(event.type);
            latest.accept(2);
        });
        latest.onUpdatedDo((event) => {
            events.push(event.type);
        });

        latest.accept(1);
        await latest.whenIdle();

        expect(events).toEqual(['created', 'updated']);
        expect(latest.read()).toBe(2);
    });
});
