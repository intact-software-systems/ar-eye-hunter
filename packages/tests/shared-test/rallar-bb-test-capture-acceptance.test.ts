import { describe, expect, it } from 'vitest';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

describe('accepted recipe capture structure', () => {
    it('captures loaded commands and capture fields without traversing opaque payloads', async () => {
        const opaque = new Map([['application', 'opaque']]);
        const step = { kind: 'rtc.connect' as const, rallar: { rtcCaptureMode: 'off' } };
        const commands: RallarBlackBoxTestCommand[] = [step, { kind: 'ws.send', data: opaque }];
        const recipe = { schemaVersion: 1 as const, recipeId: 'same', rtcCaptureMode: 'signaling' as const, commands };
        const observed: RallarBlackBoxTestCommand[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: async (command) => {
                observed.push(command);
                return { status: 'ok' };
            }
        });
        await runtime.execute({ kind: 'recipe.load', recipe });
        step.rallar.rtcCaptureMode = 'native';
        commands.pop();
        await runtime.execute({ kind: 'recipe.run' });
        expect(observed).toHaveLength(2);
        expect(observed[0]).toMatchObject({ rallar: { rtcCaptureMode: 'off' } });
        expect(observed[1]).toMatchObject({ data: opaque });
        expect(observed[1].kind === 'ws.send' && observed[1].data).toBe(opaque);
    });

    it('retains original body and invocation attribution on replay and distinguishes a new body with the same ID', async () => {
        let effects = 0;
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: async () => {
                effects += 1;
                return { status: 'ok' };
            }
        });
        const recipe: RallarBlackBoxTestRecipe = { schemaVersion: 1, recipeId: 'same', commands: [{ kind: 'rtc.connect', commandId: 'child' }] };
        await runtime.execute({ kind: 'recipe.load', recipe });
        const first = await runtime.execute({ kind: 'recipe.run', commandId: 'run-one', rtcCaptureMode: 'off' });
        await runtime.execute({ kind: 'recipe.load', recipe: { ...recipe, rtcCaptureMode: 'native' } });
        const replay = await runtime.execute({ kind: 'recipe.run', commandId: 'run-one', rtcCaptureMode: 'native' });
        const second = await runtime.execute({ kind: 'recipe.run', commandId: 'run-two' });
        expect(first.value).toMatchObject({ invocation: { invocationId: expect.any(String), recipeBodyId: expect.any(String), run: 'off' } });
        expect(replay).toMatchObject({ value: first.value, replayed: true });
        expect(second.value).toMatchObject({ invocation: { recipe: 'native' } });
        expect(second.value).not.toMatchObject({ invocation: Reflect.get(Object(first.value), 'invocation') });
        expect(effects).toBe(2);
    });
    it('captures Configure selection for a later implicit CRDT step before an earlier command yields', async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const rallar = { rtcCaptureMode: 'off' };
        const observed: RallarBlackBoxTestCommandContext[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind === 'health') {
                    entered.resolve();
                    await release.promise;
                }
                if (command.kind === 'crdt.open') {
                    observed.push(context);
                }
                return command.kind === 'configure' ? undefined : { status: 'ok' };
            }
        });
        const running = runtime.execute({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'mutable',
                commands: [
                    { kind: 'health' },
                    { kind: 'configure', config: { rallar } },
                    { kind: 'crdt.open', name: 'test' }
                ]
            }
        });
        await entered.promise;
        rallar.rtcCaptureMode = 'native';
        release.resolve();
        await running;
        expect(observed.map((context) => context.rtcCapture)).toEqual([{ run: undefined, recipe: undefined, step: 'off' }]);
    });

    it('keeps each accepted body identity when a load notification accepts another recipe', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        let replaced = false;
        let second: ReturnType<typeof runtime.execute> | undefined;
        runtime.subscribe((state) => {
            if (state.loadedRecipe?.recipeId === 'first' && !replaced) {
                replaced = true;
                second = runtime.execute({ kind: 'recipe.load', recipe: { schemaVersion: 1, recipeId: 'second', commands: [{ kind: 'health' }] } });
            }
        });
        const first = await runtime.execute({ kind: 'recipe.load', recipe: { schemaVersion: 1, recipeId: 'first', commands: [{ kind: 'health' }] } });
        const other = await second;
        expect(first.value).toMatchObject({ recipeId: 'first', recipeBodyId: expect.any(String) });
        expect(other?.value).toMatchObject({ recipeId: 'second', recipeBodyId: expect.any(String) });
        expect(Reflect.get(Object(first.value), 'recipeBodyId')).not.toBe(Reflect.get(Object(other?.value), 'recipeBodyId'));
    });
    it.each(['running', 'command-id', 'invocation-id'] as const)(
        'binds a reference run before a reentrant %s callback replaces the loaded body',
        async (edge) => {
            const observed: RallarBlackBoxTestCommandContext[] = [];
            const effects: string[] = [];
            let sequence = 0;
            let onId = (_prefix: string): void => {};
            const runtime = createRallarBlackBoxTestRuntime({
                idFactory: (prefix) => {
                    onId(prefix);
                    return `${prefix}-${++sequence}`;
                },
                commandExecutor: async (command, context) => {
                    if (command.kind === 'rtc.connect') {
                        effects.push(command.connection ?? 'missing');
                        observed.push(context);
                    }
                    return { status: 'ok' };
                }
            });
            const loaded = await runtime.execute({
                kind: 'recipe.load',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'first',
                    rtcCaptureMode: 'off',
                    commands: [{ kind: 'rtc.connect', connection: 'first' }]
                }
            });
            let replaced = false;
            let replacement: ReturnType<typeof runtime.execute> | undefined;
            const replace = (): void => {
                if (replaced) {
                    return;
                }
                replaced = true;
                replacement = runtime.execute({
                    kind: 'recipe.load',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'replacement',
                        rtcCaptureMode: 'native',
                        commands: [{ kind: 'rtc.connect', connection: 'replacement' }]
                    }
                });
            };
            runtime.subscribe((state) => {
                if (edge === 'running' && state.status === 'running' && state.activeCommand?.kind === 'recipe.run') {
                    replace();
                }
            });
            onId = (prefix) => {
                if ((edge === 'command-id' && prefix === 'command') || (edge === 'invocation-id' && prefix === 'recipe-invocation')) {
                    replace();
                }
            };
            const first = await runtime.execute({ kind: 'recipe.run' });
            const replacementLoad = await replacement;
            expect(first.value).toMatchObject({
                recipeId: 'first',
                invocation: {
                    recipe: 'off',
                    recipeBodyId: Reflect.get(Object(loaded.value), 'recipeBodyId')
                }
            });
            expect(effects).toEqual(['first']);
            expect(observed[0].rtcCapture?.recipe).toBe('off');
            const later = await runtime.execute({ kind: 'recipe.run' });
            expect(later.value).toMatchObject({
                recipeId: 'replacement',
                invocation: {
                    recipe: 'native',
                    recipeBodyId: Reflect.get(Object(replacementLoad?.value), 'recipeBodyId')
                }
            });
            expect(effects).toEqual(['first', 'replacement']);
        }
    );

    it('captures a nested reference body at its own admission after earlier children change the load', async () => {
        const effects: string[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: async (command) => {
                if (command.kind === 'rtc.connect') {
                    effects.push(command.connection ?? 'missing');
                }
                return command.kind === 'rtc.connect' ? { status: 'ok' } : undefined;
            }
        });
        await runtime.execute({ kind: 'recipe.load', recipe: { schemaVersion: 1, recipeId: 'old', commands: [{ kind: 'rtc.connect', connection: 'old' }] } });
        let replaced = false;
        runtime.subscribe((state) => {
            if (!replaced && state.status === 'running' && state.activeCommand?.commandId === 'nested') {
                replaced = true;
                void runtime.execute({
                    kind: 'recipe.load',
                    recipe: { schemaVersion: 1, recipeId: 'third', commands: [{ kind: 'rtc.connect', connection: 'third' }] }
                });
            }
        });
        const outer = await runtime.execute({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                commands: [
                    {
                        kind: 'recipe.load',
                        recipe: { schemaVersion: 1, recipeId: 'second', rtcCaptureMode: 'off', commands: [{ kind: 'rtc.connect', connection: 'second' }] }
                    },
                    { kind: 'recipe.run', commandId: 'nested' }
                ]
            }
        });
        expect(outer.ok).toBe(true);
        expect(effects).toEqual(['second']);
        expect(runtime.state().commandHistory.find((result) => result.commandId === 'nested')?.value).toMatchObject({
            recipeId: 'second',
            invocation: { recipe: 'off' }
        });
        await runtime.execute({ kind: 'recipe.run' });
        expect(effects).toEqual(['second', 'third']);
    });
});
