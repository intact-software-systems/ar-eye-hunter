import {
    describe,
    expect,
    it
} from 'vitest';

import { KeyedSerialRuns } from '@shared/resilience/keyed-serial-runs.ts';

describe('keyed serial runs', () => {
    it('runs the tasks of one key one at a time, in the order they were given', async () => {
        const runs = new KeyedSerialRuns<string>();
        const steps: string[] = [];
        const first = Promise.withResolvers<void>();

        const a = runs.run('k', async () => {
            steps.push('start a');
            await first.promise;
            steps.push('end a');
        });
        const b = runs.run('k', () => {
            steps.push('b');
        });
        await Promise.resolve();
        expect(steps).toEqual(['start a']);

        first.resolve();
        await Promise.all([a, b]);
        expect(steps).toEqual(['start a', 'end a', 'b']);
    });

    it('runs another key while one key waits on a task that never settles', async () => {
        const runs = new KeyedSerialRuns<string>();
        const ran: string[] = [];
        void runs.run('stuck', () => new Promise<void>(() => {}));
        void runs.run('stuck', () => {
            ran.push('behind the stuck task');
        });

        await runs.run('free', () => {
            ran.push('free');
        });

        expect(ran).toEqual(['free']);
    });

    it('gives a failed task\'s error to its own caller, and runs the next task of the key all the same', async () => {
        const runs = new KeyedSerialRuns<string>();
        const ran: string[] = [];

        const failed = runs.run('k', () => {
            throw new Error('the task failed');
        });
        const next = runs.run('k', () => {
            ran.push('next');
        });

        await expect(failed).rejects.toThrow('the task failed');
        await next;
        expect(ran).toEqual(['next']);
    });

    it('settles whenIdle once everything given for the key so far has run, and at once for an idle key', async () => {
        const runs = new KeyedSerialRuns<string>();
        const steps: string[] = [];
        const first = Promise.withResolvers<void>();
        void runs.run('k', async () => {
            await first.promise;
            steps.push('first');
        });
        void runs.run('k', () => Promise.reject(new Error('a failure whenIdle does not carry'))).catch(() => {});

        const idle = runs.whenIdle('k').then(() => steps.push('idle'));
        await runs.whenIdle('other');
        expect(steps).toEqual([]);

        first.resolve();
        await idle;
        expect(steps).toEqual(['first', 'idle']);
    });
});
