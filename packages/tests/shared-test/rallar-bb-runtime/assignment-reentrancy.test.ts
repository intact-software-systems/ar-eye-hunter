import { describe, expect, it } from 'vitest';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

const ORIGINAL = { runId: 'original', agentId: 'agent' };
const REPLACEMENT = { runId: 'replacement', agentId: 'agent' };
const RECIPE = { schemaVersion: 1, recipeId: 'replacement', commands: [{ kind: 'rtc.connect', connection: 'replacement' }] } as const;

// A retired command must refuse before effects; a command that already dispatched still owns its caller outcome.
describe('runtime assignment during synchronous admission callbacks', () => {
    it.each(['configure', 'recipe.load', 'rtc.connect'] as const)('fences %s after active-command publication', async (kind) => {
        const effects: string[] = [];
        const capture: RallarBlackBoxTestCommandContext[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind === 'rtc.connect') {
                    effects.push(command.connection ?? 'missing');
                    capture.push(context);
                    return { status: 'ok' };
                }
                return undefined;
            }
        });
        const replacements: Promise<RallarBlackBoxTestResult>[] = [];
        let replaced = false;
        runtime.subscribe((state) => {
            if (!replaced && state.activeCommand?.commandId === 'original-command') {
                replaced = true;
                replacements.push(
                    runtime.execute({ kind: 'configure', commandId: 'replacement-config', config: { rallar: { rtcCaptureMode: 'native' } } }, REPLACEMENT)
                );
                replacements.push(runtime.execute({ kind: 'recipe.load', commandId: 'replacement-load', recipe: RECIPE }, REPLACEMENT));
            }
        });
        const command: RallarBlackBoxTestCommand = kind === 'configure'
            ? { kind, config: { rallar: { rtcCaptureMode: 'off' } } }
            : kind === 'recipe.load'
            ? { kind, recipe: { schemaVersion: 1, recipeId: 'original', commands: [{ kind: 'rtc.connect', connection: 'original' }] } }
            : { kind, connection: 'original' };
        const original = await runtime.execute({ ...command, commandId: 'original-command' }, ORIGINAL);
        await Promise.all(replacements);
        expect.soft(original.ok).toBe(false);
        expect.soft(runtime.state().currentConfig).toMatchObject({ rallar: { rtcCaptureMode: 'native' } });
        expect.soft(runtime.state().loadedRecipe?.recipeId).toBe('replacement');
        expect.soft(runtime.state().resultCache['original-command']).toBeUndefined();
        expect.soft(effects).toEqual([]);
        expect((await runtime.execute({ kind: 'recipe.run', commandId: 'replacement-run' }, REPLACEMENT)).ok).toBe(true);
        expect(effects).toEqual(['replacement']);
        expect(capture.at(-1)?.rtcCapture).toEqual({ run: undefined, recipe: undefined, step: 'native' });
    });

    it.each(['start-clock', 'recipe-body-id', 'recipe-invocation-id'] as const)('fences writes and effects after %s reassigns', async (edge) => {
        let onCallback = (): void => {};
        let sequence = 0;
        const effects: string[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            now: () => {
                if (edge === 'start-clock') {
                    onCallback();
                }
                return 100;
            },
            idFactory: (prefix) => {
                if ((edge === 'recipe-body-id' && prefix === 'recipe-body') || (edge === 'recipe-invocation-id' && prefix === 'recipe-invocation')) {
                    onCallback();
                }
                return `${prefix}-${++sequence}`;
            },
            commandExecutor: async (command) => {
                effects.push(command.kind);
                return { status: 'ok' };
            }
        });
        const replacements: Promise<RallarBlackBoxTestResult>[] = [];
        onCallback = () => {
            onCallback = () => {};
            replacements.push(
                runtime.execute({ kind: 'configure', commandId: 'replacement-config', config: { rallar: { rtcCaptureMode: 'native' } } }, REPLACEMENT)
            );
            replacements.push(runtime.execute({ kind: 'recipe.load', commandId: 'replacement-load', recipe: RECIPE }, REPLACEMENT));
        };
        const command: RallarBlackBoxTestCommand = edge === 'start-clock'
            ? { kind: 'configure', commandId: 'original-command', config: { rallar: { rtcCaptureMode: 'off' } } }
            : edge === 'recipe-body-id'
            ? { kind: 'recipe.load', commandId: 'original-command', recipe: { schemaVersion: 1, recipeId: 'original', commands: [{ kind: 'health' }] } }
            : { kind: 'recipe.run', commandId: 'original-command', recipe: { schemaVersion: 1, recipeId: 'original', commands: [{ kind: 'rtc.connect' }] } };
        const original = await runtime.execute(command, ORIGINAL);
        await Promise.all(replacements);
        expect.soft(original.ok).toBe(false);
        expect.soft(effects).toEqual([]);
        expect.soft(runtime.state().currentConfig).toMatchObject({ rallar: { rtcCaptureMode: 'native' } });
        expect.soft(runtime.state().loadedRecipe?.recipeId).toBe('replacement');
        expect.soft(runtime.state().events.some((event) => event.commandId === 'original-command')).toBe(false);
        expect.soft(runtime.state().resultCache['original-command']).toBeUndefined();
    });
    it('does not execute built-in fallback after an external port reassigns without an outcome', async () => {
        let onDispatch = (): void => {};
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: async () => {
                onDispatch();
                return undefined;
            }
        });
        const replacements: Promise<RallarBlackBoxTestResult>[] = [];
        onDispatch = () => {
            onDispatch = () => {};
            replacements.push(runtime.execute({ kind: 'configure', commandId: 'new-config', config: { rallar: { rtcCaptureMode: 'native' } } }, REPLACEMENT));
        };
        const original = await runtime.execute({ kind: 'health', commandId: 'old-health' }, ORIGINAL);
        await Promise.all(replacements);
        expect(original.ok).toBe(false);
        expect(runtime.state().resultCache['old-health']).toBeUndefined();
        expect(runtime.state().currentConfig).toMatchObject({ rallar: { rtcCaptureMode: 'native' } });
    });
});

describe('reset caller completion after assignment changes', () => {
    it.each(['unhandled', 'ok', 'failed'] as const)('preserves successor state and reports only the actual %s external outcome', async (disposition) => {
        let onReset = (): void => {};
        const captures: RallarBlackBoxTestCommandContext[] = [];
        const outcome: RallarBlackBoxTestCommandOutcome | undefined = disposition === 'unhandled'
            ? undefined
            : disposition === 'ok'
            ? { status: 'ok', value: { externallyReset: 'original' }, nextStatus: 'idle' }
            : { status: 'failed', error: { code: 'RESET_DECLINED', message: 'The executor declined reset.' }, nextStatus: 'failed' };
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind === 'reset') {
                    onReset();
                    return outcome;
                }
                if (command.kind === 'rtc.connect') {
                    captures.push(context);
                    return { status: 'ok' };
                }
                return undefined;
            }
        });
        const replacements: Promise<RallarBlackBoxTestResult>[] = [];
        onReset = () => {
            replacements.push(
                runtime.execute({ kind: 'configure', commandId: 'successor-config', config: { rallar: { rtcCaptureMode: 'native' } } }, REPLACEMENT)
            );
            replacements.push(runtime.execute({ kind: 'recipe.load', commandId: 'successor-load', recipe: RECIPE }, REPLACEMENT));
        };
        const result = await runtime.execute({ kind: 'reset', commandId: 'old-reset' }, ORIGINAL);
        await Promise.all(replacements);
        if (disposition === 'unhandled') {
            expect.soft(result.ok).toBe(false);
            expect.soft(result.status).toBe('failed');
            expect.soft(result.value).toBeUndefined();
            expect.soft(result.error?.message).toBe('Control assignment changed before this command could execute.');
        }
        else if (disposition === 'ok') {
            expect.soft(result.ok).toBe(true);
            expect.soft(result.status).toBe('ok');
            expect.soft(result.value).toEqual({ externallyReset: 'original' });
            expect.soft(result.error).toBeUndefined();
        }
        else {
            expect.soft(result.ok).toBe(false);
            expect.soft(result.status).toBe('failed');
            expect.soft(result.value).toBeUndefined();
            expect.soft(result.error).toEqual({ code: 'RESET_DECLINED', message: 'The executor declined reset.' });
        }
        expect.soft(runtime.state().currentConfig).toMatchObject({ rallar: { rtcCaptureMode: 'native' } });
        expect.soft(runtime.state().loadedRecipe?.recipeId).toBe('replacement');
        expect.soft(Object.keys(runtime.state().resultCache).sort()).toEqual(['successor-config', 'successor-load']);
        expect.soft(runtime.state().status).toBe('loaded');
        expect.soft(runtime.state().events.some((event) => event.commandId === 'old-reset')).toBe(false);
        expect((await runtime.execute({ kind: 'recipe.run', commandId: 'successor-run' }, REPLACEMENT)).ok).toBe(true);
        expect(captures.at(-1)?.rtcCapture).toEqual({ run: undefined, recipe: undefined, step: 'native' });
    });

    it('completes current-owner unhandled reset and clears configuration, loaded body, capture defaults and cached state', async () => {
        const captures: RallarBlackBoxTestCommandContext[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind === 'rtc.connect') {
                    captures.push(context);
                    return { status: 'ok' };
                }
                return undefined;
            }
        });
        await runtime.execute({ kind: 'configure', commandId: 'config', config: { rallar: { rtcCaptureMode: 'native' } } }, ORIGINAL);
        await runtime.execute({ kind: 'recipe.load', commandId: 'load', recipe: RECIPE }, ORIGINAL);
        runtime.recordEvent({ kind: 'event', topic: 'before-reset' });
        const result = await runtime.execute({ kind: 'reset', commandId: 'reset' }, ORIGINAL);
        expect(result.ok).toBe(true);
        expect(result.value).toEqual({ reset: true });
        expect.soft(runtime.state().status).toBe('idle');
        expect.soft(runtime.state().currentConfig).toBeUndefined();
        expect.soft(runtime.state().loadedRecipe).toBeUndefined();
        expect.soft(Object.keys(runtime.state().resultCache)).toEqual(['reset']);
        expect.soft(runtime.state().commandHistory.map((entry) => entry.commandId)).toEqual(['reset']);
        expect.soft(runtime.state().events.map((event) => event.topic)).toEqual(['rallar.bb.command.result']);
        expect((await runtime.execute({ kind: 'recipe.run', commandId: 'missing-body' }, ORIGINAL)).ok).toBe(false);
        expect((await runtime.execute({ kind: 'rtc.connect', commandId: 'current-connect' }, ORIGINAL)).ok).toBe(true);
        expect(captures.at(-1)?.rtcCapture).toEqual({ run: undefined, recipe: undefined, step: undefined });
    });
});
