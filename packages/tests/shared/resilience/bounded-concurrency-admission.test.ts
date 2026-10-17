import { describe, expect, it, vi } from 'vitest';

import { BoundedConcurrencyAdmission } from '@shared/resilience/bounded-concurrency-admission.ts';

interface GatedRun {
    readonly id: number;
    readonly release: () => void;
}

describe('bounded concurrency admission', () => {
    it('runs at most the bound at once and admits waiting runs in arrival order', async () => {
        const admission = new BoundedConcurrencyAdmission({ maxConcurrent: 2 });
        const started: GatedRun[] = [];
        const completed: number[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const runs = Array.from({ length: 6 }, (_, id) =>
            admission.admit(() => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                return new Promise<number>((resolve) => {
                    started.push({
                        id,
                        release: () => {
                            inFlight -= 1;
                            resolve(id);
                        }
                    });
                });
            }).then((id) => {
                completed.push(id);
                return id;
            }));

        await Promise.resolve();
        expect(started.map((run) => run.id)).toEqual([0, 1]);

        for (let released = 0; released < 6; released += 1) {
            started[released]!.release();
            await vi.waitFor(() => expect(started.length).toBe(Math.min(6, released + 3)));
        }

        expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(maxInFlight).toBe(2);
        expect(completed).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('releases the slot of a run that throws and admits the next waiting run', async () => {
        const admission = new BoundedConcurrencyAdmission({ maxConcurrent: 1 });
        const failed = admission.admit(() => Promise.reject(new Error('derivation failed')));
        const next = admission.admit(() => Promise.resolve('next'));

        await expect(failed).rejects.toThrow('derivation failed');
        await expect(next).resolves.toBe('next');
    });

    it('rejects a bound below one at construction', () => {
        expect(() => new BoundedConcurrencyAdmission({ maxConcurrent: 0 })).toThrow(TypeError);
        expect(() => new BoundedConcurrencyAdmission({ maxConcurrent: 1.5 })).toThrow(TypeError);
    });
});
