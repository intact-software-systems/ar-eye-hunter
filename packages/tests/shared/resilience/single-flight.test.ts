import { describe, expect, it } from 'vitest';

import { SingleFlight } from '@shared/resilience/single-flight.ts';

describe('single flight', () => {
    it('joins a second call for a running key to the in-flight promise and starts once', async () => {
        const flights = new SingleFlight<string, string>();
        const started: string[] = [];
        const first = Promise.withResolvers<string>();

        const a = flights.run('k', () => {
            started.push('a');
            return first.promise;
        });
        const b = flights.run('k', () => {
            started.push('b');
            return Promise.resolve('never');
        });
        expect(flights.isInFlight('k')).toBe(true);
        first.resolve('result');

        expect(await Promise.all([a, b])).toEqual(['result', 'result']);
        expect(started).toEqual(['a']);
    });

    it('forgets a key once its promise settles, so the next call starts anew, after success or failure', async () => {
        const flights = new SingleFlight<string, number>();
        let starts = 0;

        await flights.run('k', () => {
            starts += 1;
            return Promise.resolve(starts);
        });
        expect(flights.isInFlight('k')).toBe(false);
        await expect(flights.run('k', () => {
            starts += 1;
            return Promise.reject(new Error('failed'));
        })).rejects.toThrow('failed');
        expect(flights.isInFlight('k')).toBe(false);

        expect(
            await flights.run('k', () => {
                starts += 1;
                return Promise.resolve(starts);
            })
        ).toBe(3);
    });

    it('lists a completion per flight in progress that resolves when the flight settles, even by failure', async () => {
        const flights = new SingleFlight<string, string>();
        const held = Promise.withResolvers<string>();
        const failing = Promise.withResolvers<string>();

        const result = flights.run('held', () => held.promise);
        const failed = flights.run('failing', () => failing.promise);
        const completions = flights.completions();
        expect(completions).toHaveLength(2);

        held.resolve('done');
        failing.reject(new Error('open failed'));
        await expect(Promise.all(completions)).resolves.toEqual([undefined, undefined]);
        expect(await result).toBe('done');
        await expect(failed).rejects.toThrow('open failed');
        expect(flights.completions()).toHaveLength(0);
    });

    it('keeps keys apart', async () => {
        const flights = new SingleFlight<number, string>();
        const one = Promise.withResolvers<string>();

        const a = flights.run(1, () => one.promise);
        const b = flights.run(2, () => Promise.resolve('two'));

        expect(await b).toBe('two');
        expect(flights.isInFlight(1)).toBe(true);
        expect(flights.isInFlight(2)).toBe(false);
        one.resolve('one');
        expect(await a).toBe('one');
    });

    it('clear forgets every running key, and an old flight settling does not forget its replacement', async () => {
        const flights = new SingleFlight<string, string>();
        const old = Promise.withResolvers<string>();
        const replacement = Promise.withResolvers<string>();

        const first = flights.run('k', () => old.promise);
        flights.clear();
        expect(flights.isInFlight('k')).toBe(false);
        const second = flights.run('k', () => replacement.promise);
        old.resolve('old');
        expect(await first).toBe('old');
        await Promise.resolve();

        expect(flights.isInFlight('k')).toBe(true);
        replacement.resolve('new');
        expect(await second).toBe('new');
        expect(flights.isInFlight('k')).toBe(false);
    });
});
