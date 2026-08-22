import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar flow', () => {
    it('creates independent command orchestrator flows from the facade', async () => {
        const first = createRallarFacade().flow<string, number>();
        const second = createRallarFacade().flow<string, number>();

        expect(first).not.toBe(second);

        const results = await first
            .sequential(
                first.supplierStep('initial', () => 1),
                first.dynamicStep((existing) => [
                    'derived',
                    (existing.get('initial') ?? 0) + 1
                ])
            )
            .parallel(
                first.supplierStep('parallel', () => 3)
            )
            .run();

        expect(Array.from(results.entries())).toEqual([
            ['initial', 1],
            ['derived', 2],
            ['parallel', 3]
        ]);
    });

    it('passes command policies into command steps', async () => {
        const flow = createRallarFacade().flow<string, number>({
            command: {
                maxAttempts: 1,
                fallback: () => 42
            }
        });

        const results = await flow
            .sequential(
                flow.commandStep('fallback', () => {
                    throw new Error('command failed');
                })
            )
            .run();

        expect(results.get('fallback')).toBe(42);
    });
});
