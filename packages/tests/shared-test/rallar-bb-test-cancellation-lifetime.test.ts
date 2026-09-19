import { describe, expect, it } from 'vitest';

import type { RallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

function toCommands(kind: 'recipe.run' | 'loop' | 'parallel'): RallarBlackBoxTestCommand {
    const commands: readonly RallarBlackBoxTestCommand[] = [
        { kind: 'rtc.send', send: 'blocked' },
        { kind: 'rtc.send', send: 'must-not-run' }
    ];
    switch (kind) {
        case 'recipe.run':
            return { kind, recipe: { schemaVersion: 1, recipeId: 'cancelled', commands } };
        case 'loop':
            return { kind, count: 2, commands };
        case 'parallel':
            return { kind, maxConcurrency: 1, groups: [{ commands }, { commands }] };
    }
}

describe('runtime cancellation lifetime', () => {
    it.each(['recipe.run', 'loop', 'parallel'] as const)(
        'keeps %s cancelled while diagnostics arrive and its active adapter drains',
        async (kind) => {
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const effects: unknown[] = [];
            const cleanups: string[] = [];
            const runtime = createRallarBlackBoxTestRuntime({
                cleanup: async (cleanup) => {
                    cleanups.push(cleanup.reason);
                },
                commandExecutor: async (command) => {
                    if (command.kind !== 'rtc.send') {
                        return undefined;
                    }
                    effects.push(command.send);
                    if (command.send === 'blocked') {
                        entered.resolve();
                        await release.promise;
                    }
                    return { status: 'ok', value: { sent: true } };
                }
            });
            const run = runtime.execute(toCommands(kind));
            await entered.promise;
            await runtime.execute({ kind: 'recipe.cancel' });
            await runtime.execute({ kind: 'health' });
            await runtime.execute({ kind: 'stats' });
            release.resolve();
            const result = await run;
            expect.soft(result.status).toBe('cancelled');
            expect.soft(effects).toEqual(['blocked']);
            expect.soft(cleanups).toEqual(['cancelled']);

            const next = await runtime.execute({
                kind: 'recipe.run',
                recipe: { schemaVersion: 1, recipeId: 'next', commands: [{ kind: 'rtc.send', send: 'next' }] }
            });
            expect(next.status).toBe('ok');
            expect(effects.at(-1)).toBe('next');
        }
    );
});
