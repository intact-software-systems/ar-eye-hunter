import { describe, expect, it } from 'vitest';

import type { ControlClientIdentity } from '@shared-test/rallar-bb-test/control-protocol.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

const CONTROL_A = Object.freeze({ runId: 'callback-A', agentId: 'agent-A' } satisfies ControlClientIdentity);
const CONTROL_B = Object.freeze({ runId: 'callback-B', agentId: 'agent-B' } satisfies ControlClientIdentity);

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

    it.each(['none', 'same', 'other'] as const)(
        'captures the admitted owner before a command-ID callback reenters; owner=%s',
        async (owner) => {
            let sequence = 0;
            let onCommandId = (): void => {};
            const effects: string[] = [];
            const observed: RallarBlackBoxTestCommandContext[] = [];
            const runtime = createRallarBlackBoxTestRuntime({
                idFactory: (prefix) => {
                    if (prefix === 'command') {
                        onCommandId();
                    }
                    return `${prefix}-${++sequence}`;
                },
                commandExecutor: async (command, context) => {
                    if (command.kind === 'rtc.connect') {
                        effects.push(command.connection ?? 'missing');
                        observed.push(context);
                        context.recordEvent({ kind: 'event', topic: command.connection ?? 'missing', commandId: command.commandId });
                    }
                    return { status: 'ok' };
                }
            });
            await runtime.execute({ kind: 'configure', commandId: 'initial-config', config: { rallar: { rtcCaptureMode: 'off' } } }, CONTROL_A);
            const reentered: ReturnType<typeof runtime.execute>[] = [];
            const current = owner === 'other' ? CONTROL_B : CONTROL_A;
            let armed = true;
            onCommandId = () => {
                if (!armed || owner === 'none') {
                    return;
                }
                armed = false;
                if (owner === 'other') {
                    reentered.push(
                        runtime.execute({ kind: 'configure', commandId: 'callback-config', config: { rallar: { rtcCaptureMode: 'native' } } }, current)
                    );
                }
                reentered.push(runtime.execute({ kind: 'rtc.connect', commandId: 'callback-connect', connection: 'callback' }, current));
            };
            const outer = await runtime.execute({ kind: 'rtc.connect', connection: 'outer' }, CONTROL_A);
            const callbackResults = await Promise.all(reentered);
            const state = runtime.state();
            const outerEvents = state.events.filter((event) => event.commandId === outer.commandId);
            expect(callbackResults.every((result) => result.ok)).toBe(true);
            expect.soft(outer.ok).toBe(owner !== 'other');
            expect.soft(effects).toEqual(owner === 'none' ? ['outer'] : owner === 'other' ? ['callback'] : ['callback', 'outer']);
            if (owner === 'other') {
                expect.soft(state.resultCache[outer.commandId]).toBeUndefined();
                expect.soft(outerEvents).toEqual([]);
            }
            else {
                expect(state.resultCache[outer.commandId]).toBe(outer);
                expect(
                    outerEvents.every((event) =>
                        event.control?.runId === CONTROL_A.runId && event.control.agentId === CONTROL_A.agentId &&
                        event.control.rootCommandId === outer.commandId
                    )
                ).toBe(true);
                expect(observed.at(-1)?.rtcCapture?.step).toBe('off');
            }
            if (owner !== 'none') {
                expect(state.resultCache['callback-connect']).toBe(callbackResults.at(-1));
                const callbackEvent = state.events.find((event) => event.topic === 'callback');
                expect(callbackEvent?.control).toEqual({ ...current, rootCommandId: 'callback-connect' });
            }
            const later = await runtime.execute({ kind: 'rtc.connect', commandId: 'later-connect', connection: 'later' }, current);
            expect(later.ok).toBe(true);
            expect(observed.at(-1)?.rtcCapture?.step).toBe(owner === 'other' ? 'native' : 'off');
        }
    );

    it.each([false, true])('captures defaults before a command-ID callback reconfigures the same owner; callback=%s', async (callback) => {
        let sequence = 0;
        let onCommandId = (): void => {};
        const effects: string[] = [];
        const observed: RallarBlackBoxTestCommandContext[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            idFactory: (prefix) => {
                if (prefix === 'command') {
                    onCommandId();
                }
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
        await runtime.execute({ kind: 'configure', commandId: 'initial-defaults', config: { rallar: { rtcCaptureMode: 'off' } } }, CONTROL_A);
        let reconfigured: ReturnType<typeof runtime.execute> | undefined;
        onCommandId = () => {
            if (callback && !reconfigured) {
                reconfigured = runtime.execute(
                    { kind: 'configure', commandId: 'callback-defaults', config: { rallar: { rtcCaptureMode: 'native' } } },
                    CONTROL_A
                );
            }
        };
        const outer = await runtime.execute({ kind: 'rtc.connect', connection: 'first' }, CONTROL_A);
        const configured = await reconfigured;
        const later = await runtime.execute({ kind: 'rtc.connect', commandId: 'later-defaults', connection: 'later' }, CONTROL_A);
        expect(outer.ok).toBe(true);
        expect(later.ok).toBe(true);
        expect(effects).toEqual(['first', 'later']);
        if (callback) {
            expect(configured?.ok).toBe(true);
        }
        expect.soft(observed[0].rtcCapture?.step).toBe('off');
        expect(observed[1].rtcCapture?.step).toBe(callback ? 'native' : 'off');
    });

    it.each([false, true])('fences an owned context event after its event-ID callback changes the owner; reassigned=%s', async (reassigned) => {
        let sequence = 0;
        let eventArmed = false;
        let onEventId = (): void => {};
        const effects: string[] = [];
        const observed: RallarBlackBoxTestCommandContext[] = [];
        const reentered: Promise<RallarBlackBoxTestResult>[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            idFactory: (prefix) => {
                if (prefix === 'event' && eventArmed) {
                    eventArmed = false;
                    onEventId();
                }
                return `${prefix}-${++sequence}`;
            },
            commandExecutor: async (command, context) => {
                if (command.kind === 'rtc.connect') {
                    effects.push(command.connection ?? 'missing');
                    observed.push(context);
                    if (command.connection === 'event-A') {
                        eventArmed = true;
                        context.recordEvent({ kind: 'diagnostic', topic: 'owned-A-event', commandId: command.commandId });
                    }
                    if (command.connection === 'event-B') {
                        context.recordEvent({ kind: 'diagnostic', topic: 'owned-B-event', commandId: command.commandId });
                    }
                }
                return { status: 'ok' };
            }
        });
        await runtime.execute({ kind: 'configure', commandId: 'event-A-config', config: { rallar: { rtcCaptureMode: 'off' } } }, CONTROL_A);
        onEventId = () => {
            if (reassigned) {
                reentered.push(
                    runtime.execute({ kind: 'configure', commandId: 'event-B-config', config: { rallar: { rtcCaptureMode: 'native' } } }, CONTROL_B)
                );
                reentered.push(runtime.execute({ kind: 'rtc.connect', commandId: 'event-B-connect', connection: 'event-B' }, CONTROL_B));
            }
        };
        const outer = await runtime.execute({ kind: 'rtc.connect', commandId: 'event-A-connect', connection: 'event-A' }, CONTROL_A);
        const callbackResults = await Promise.all(reentered);
        const state = runtime.state();
        const owned = state.events.filter((event) => event.topic === 'owned-A-event');
        expect(outer.ok).toBe(true);
        expect(callbackResults.every((result) => result.ok)).toBe(true);
        expect(observed[0].rtcCapture?.step).toBe('off');
        expect.soft(owned).toHaveLength(reassigned ? 0 : 1);
        if (reassigned) {
            expect(effects).toEqual(['event-A', 'event-B']);
            expect(observed[1].rtcCapture?.step).toBe('native');
            expect(state.resultCache['event-B-connect']).toBeDefined();
            expect(state.resultCache[outer.commandId]).toBeUndefined();
            expect(state.events.find((event) => event.topic === 'owned-B-event')?.control).toEqual({ ...CONTROL_B, rootCommandId: 'event-B-connect' });
        }
        else {
            expect(effects).toEqual(['event-A']);
            expect(owned[0].control).toEqual({ ...CONTROL_A, rootCommandId: 'event-A-connect' });
            expect(state.resultCache[outer.commandId]).toBe(outer);
        }
    });
});
