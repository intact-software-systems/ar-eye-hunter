import {
    describe,
    expect,
    it
} from 'vitest';

import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCleanupInput,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

// A delayed cleanup for a finished control child must never abort this agent's next recipe.
describe('targeted recipe cancellation', () => {
    it('refuses a stale target while preserving the actual active recipe', async () => {
        const cleanup: RallarBlackBoxTestCleanupInput[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            cleanup: (input) => {
                cleanup.push(input);
            }
        });
        const started = Promise.withResolvers<void>();
        const unsubscribe = runtime.subscribe((state) => {
            if (state.activeCommand?.commandId === 'new-wait') {
                started.resolve();
            }
        });
        const running = runtime.execute({
            kind: 'recipe.run',
            commandId: 'new-root',
            recipe: {
                schemaVersion: 1,
                recipeId: 'new-work',
                continueOnFailure: false,
                commands: [{ kind: 'wait', commandId: 'new-wait', match: { topic: 'release' }, timeoutMs: 1_000 }]
            }
        });
        await started.promise;
        try {
            const cancel = { kind: 'recipe.cancel' as const, commandId: 'old-cleanup', targetCommandId: 'old-root' };
            const outcome = await runtime.execute(cancel);
            expect(outcome.value).toMatchObject({ cancelRequested: false, targetCommandId: 'old-root' });
            runtime.recordEvent({ kind: 'event', topic: 'release' });
            expect((await running).status).toBe('ok');
            expect(cleanup).toEqual([]);
        }
        finally {
            await runtime.execute({ kind: 'recipe.cancel', commandId: 'test-cleanup' });
            await running;
            unsubscribe();
        }
    });
});

it.each(
    [
        { sameId: false, firstToFinish: 'a' },
        { sameId: false, firstToFinish: 'b' },
        { sameId: true, firstToFinish: 'a' },
        { sameId: true, firstToFinish: 'b' }
    ] as const
)('refuses ambiguous overlapping invocations: $sameId / $firstToFinish', async ({ sameId, firstToFinish }) => {
    const runtime = createRallarBlackBoxTestRuntime();
    const a = new PendingRecipe(runtime, { rootId: 'a', waitId: 'wait-a', topic: 'a-complete' });
    const b = new PendingRecipe(runtime, { rootId: sameId ? 'a' : 'b', waitId: 'wait-b', topic: 'b-complete' });
    await Promise.all([a.started, b.started]);
    try {
        const refused = await runtime.execute({ kind: 'recipe.cancel', targetCommandId: 'a' });
        expect(refused.value).toMatchObject({ cancelRequested: false });
        runtime.recordEvent({ kind: 'event', topic: `${firstToFinish}-complete` });
        expect((await (firstToFinish === 'a' ? a.result : b.result)).status).toBe('ok');
        const survivorId = firstToFinish === 'a' && !sameId ? 'b' : 'a';
        const survivorCancel = await runtime.execute({ kind: 'recipe.cancel', targetCommandId: survivorId });
        expect(survivorCancel.value).toMatchObject({ cancelRequested: false });
        runtime.recordEvent({ kind: 'event', topic: firstToFinish === 'a' ? 'b-complete' : 'a-complete' });
        expect((await (firstToFinish === 'a' ? b.result : a.result)).status).toBe('ok');
        for (const targetCommandId of ['a', 'b']) {
            expect((await runtime.execute({ kind: 'close', targetCommandId })).value).toMatchObject({ closed: false });
        }
        const next = new PendingRecipe(runtime, { rootId: 'next', waitId: 'wait-next', topic: 'never' });
        await next.started;
        const accepted = await runtime.execute({ kind: 'recipe.cancel', targetCommandId: 'next' });
        expect(accepted.value).toMatchObject({ cancelRequested: true });
        expect((await next.result).status).toBe('cancelled');
        next.stopWatching();
    }
    finally {
        await runtime.execute({ kind: 'recipe.cancel' });
        await Promise.all([a.result, b.result]);
        a.stopWatching();
        b.stopWatching();
    }
});

namespace PendingRecipe {
    export interface Input {
        readonly rootId: string;
        readonly waitId: string;
        readonly topic: string;
    }
}

class PendingRecipe {
    readonly started: Promise<void>;
    readonly result: Promise<RallarBlackBoxTestResult>;
    readonly stopWatching: () => void;

    constructor(runtime: RallarBlackBoxTestRuntime, input: PendingRecipe.Input) {
        const started = Promise.withResolvers<void>();
        this.started = started.promise;
        this.stopWatching = runtime.subscribe((state) => {
            if (state.activeCommand?.commandId === input.waitId) {
                started.resolve();
            }
        });
        this.result = runtime.execute({
            kind: 'recipe.run',
            commandId: input.rootId,
            recipe: {
                schemaVersion: 1,
                recipeId: input.rootId,
                continueOnFailure: false,
                commands: [{ kind: 'wait', commandId: input.waitId, match: { topic: input.topic }, timeoutMs: 1_000 }]
            }
        });
    }
}

it('keeps ownership at the top-level through nested composites and cached replays', async () => {
    const runtime = createRallarBlackBoxTestRuntime();
    const cached = await runtime.execute({ kind: 'stats', commandId: 'cached-stats' });
    expect(cached.ok).toBe(true);
    const entered = Promise.withResolvers<void>();
    const unsubscribe = runtime.subscribe((state) => {
        if (state.activeCommand?.commandId === 'nested-wait') {
            entered.resolve();
        }
    });
    const running = runtime.execute({
        kind: 'recipe.run',
        commandId: 'outer',
        recipe: {
            schemaVersion: 1,
            recipeId: 'outer',
            continueOnFailure: false,
            commands: [{
                kind: 'parallel',
                groups: [{
                    commands: [{
                        kind: 'loop',
                        count: 1,
                        commands: [{
                            kind: 'recipe.run',
                            commandId: 'nested-recipe',
                            recipe: {
                                schemaVersion: 1,
                                recipeId: 'nested',
                                continueOnFailure: false,
                                commands: [{ kind: 'stats', commandId: 'nested-stats' }, {
                                    kind: 'wait',
                                    commandId: 'nested-wait',
                                    match: { topic: 'never' },
                                    timeoutMs: 1_000
                                }]
                            }
                        }]
                    }]
                }]
            }]
        }
    });
    await entered.promise;
    try {
        const nested = await runtime.execute({ kind: 'recipe.cancel', targetCommandId: 'nested-recipe' });
        expect(nested.value).toMatchObject({ cancelRequested: false });
        expect((await runtime.execute({ kind: 'stats', commandId: 'cached-stats' })).replayed).toBe(true);
        const outer = await runtime.execute({ kind: 'recipe.cancel', targetCommandId: 'outer' });
        expect(outer.value).toMatchObject({ cancelRequested: true });
        expect((await running).status).toBe('cancelled');
    }
    finally {
        await runtime.execute({ kind: 'recipe.cancel' });
        await running;
        unsubscribe();
    }
});

it.each(['recipe.cancel', 'close'] as const)('decodes the optional exact %s target at both canonical ingress boundaries', (kind) => {
    for (const command of [{ kind }, { kind, targetCommandId: 'actual-control-child' }]) {
        expect(validateRallarBlackBoxTestCommand(command).ok).toBe(true);
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
    }
    for (const targetCommandId of [null, 7, ['actual-control-child']]) {
        const command = { kind, targetCommandId };
        expect(validateRallarBlackBoxTestCommand(command).ok).toBe(false);
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
    }
});
