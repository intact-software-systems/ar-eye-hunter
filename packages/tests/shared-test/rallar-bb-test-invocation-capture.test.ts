import { describe, expect, it } from 'vitest';

import { parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestCommandContext } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

function decode(command: object): RallarBlackBoxTestCommand {
    const decoded = parseControlServerMessage(
        JSON.stringify({ kind: 'command', protocolVersion: 1, runId: 'run', agentId: 'agent', commandId: 'wire', command }),
        { runId: 'run', agentId: 'agent' }
    );
    expect(decoded.ok, JSON.stringify(decoded)).toBe(true);
    if (!decoded.ok) {
        throw new Error(decoded.error);
    }
    return decoded.envelope.command;
}

function captureRuntime() {
    const observations: RallarBlackBoxTestCommandContext[] = [];
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: async (command, context) => {
            if (command.kind === 'rtc.connect') {
                observations.push(context);
                return { status: 'ok', value: { connected: true } };
            }
            return undefined;
        }
    });
    return { runtime, observations };
}

describe('recipe invocation capture authority', () => {
    it('decodes run and recipe selection and keeps run authority across Configure', async () => {
        const { runtime, observations } = captureRuntime();
        const result = await runtime.execute(decode({
            kind: 'recipe.run',
            rtcCaptureMode: 'off',
            recipe: {
                schemaVersion: 1,
                recipeId: 'authored',
                rtcCaptureMode: 'native',
                commands: [
                    { kind: 'configure', config: { rallar: { rtcCaptureMode: 'signaling' } } },
                    { kind: 'rtc.connect' },
                    { kind: 'configure', config: {} },
                    { kind: 'rtc.connect' }
                ]
            }
        }));
        expect(result.ok).toBe(true);
        expect(observations).toMatchObject([
            { rtcCapture: { run: 'off', recipe: 'native', step: 'signaling' } },
            { rtcCapture: { run: 'off', recipe: 'native', step: undefined } }
        ]);
    });

    it('keeps parallel Configure state in its own sequence and nested runs retain outer authority', async () => {
        const { runtime, observations } = captureRuntime();
        const result = await runtime.execute(decode({
            kind: 'recipe.run',
            rtcCaptureMode: 'off',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                rtcCaptureMode: 'signaling',
                commands: [
                    {
                        kind: 'parallel',
                        groups: [
                            { commands: [{ kind: 'configure', config: { rallar: { rtcCaptureMode: 'native' } } }, { kind: 'rtc.connect' }] },
                            { commands: [{ kind: 'rtc.connect' }] }
                        ]
                    },
                    { kind: 'recipe.run', rtcCaptureMode: 'native', recipe: { schemaVersion: 1, recipeId: 'inner', commands: [{ kind: 'rtc.connect' }] } },
                    { kind: 'rtc.connect' }
                ]
            }
        }));
        expect(result.ok).toBe(true);
        expect(observations.map((context) => 'rtcCapture' in context ? context.rtcCapture : undefined)).toEqual(expect.arrayContaining([
            expect.objectContaining({ run: 'off', recipe: 'signaling', step: 'native' }),
            expect.objectContaining({ run: 'off', recipe: 'signaling', step: undefined })
        ]));
        expect(observations.at(-1)).toMatchObject({ rtcCapture: { run: 'off', recipe: 'signaling', step: undefined } });
        expect(observations.at(-2)).toMatchObject({ rtcCapture: { run: 'off', recipe: 'signaling' } });
    });

    it.each(['run', 'recipe', 'configure', 'step'] as const)('rejects invalid %s capture before executing any connection', async (position) => {
        const { runtime, observations } = captureRuntime();
        const command = {
            kind: 'recipe.run' as const,
            ...(position === 'run' ? { rtcCaptureMode: 'invalid' } : {}),
            recipe: {
                schemaVersion: 1 as const,
                recipeId: 'invalid',
                ...(position === 'recipe' ? { rtcCaptureMode: 'invalid' } : {}),
                commands: [
                    ...(position === 'configure' ? [{ kind: 'configure' as const, config: { rallar: { rtcCaptureMode: 'invalid' } } }] : []),
                    { kind: 'rtc.connect' as const, ...(position === 'step' ? { rallar: { rtcCaptureMode: 'invalid' } } : {}) }
                ]
            }
        };
        const result = await runtime.execute(JSON.parse(JSON.stringify(command)));
        expect(result.ok).toBe(false);
        expect(observations).toEqual([]);
    });
    it('does not carry a completed recipe Configure into an independent invocation', async () => {
        const { runtime, observations } = captureRuntime();
        await runtime.execute(decode({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'one',
                commands: [
                    { kind: 'configure', config: { rallar: { rtcCaptureMode: 'native' } } },
                    { kind: 'rtc.connect' }
                ]
            }
        }));
        await runtime.execute(
            decode({ kind: 'recipe.run', recipe: { schemaVersion: 1, recipeId: 'two', rtcCaptureMode: 'off', commands: [{ kind: 'rtc.connect' }] } })
        );
        expect(observations.at(-1)).toMatchObject({ rtcCapture: { run: undefined, recipe: 'off', step: undefined } });
    });

    it.each(['run', 'recipe', 'configure', 'step'] as const)('rejects invalid %s capture on the wire', (position) => {
        const command = {
            kind: 'recipe.run',
            rtcCaptureMode: position === 'run' ? true : undefined,
            recipe: {
                schemaVersion: 1,
                recipeId: 'invalid',
                rtcCaptureMode: position === 'recipe' ? null : undefined,
                commands: [
                    { kind: 'configure', config: { rallar: { rtcCaptureMode: position === 'configure' ? 1 : undefined } } },
                    { kind: 'rtc.connect', rallar: { rtcCaptureMode: position === 'step' ? {} : undefined } }
                ]
            }
        };
        const decoded = parseControlServerMessage(
            JSON.stringify({ kind: 'command', protocolVersion: 1, runId: 'run', agentId: 'agent', commandId: 'invalid', command }),
            { runId: 'run', agentId: 'agent' }
        );
        expect(decoded.ok).toBe(false);
    });
    it('isolates interleaved invocations and executes repeated loop child IDs', async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const observed: RallarBlackBoxTestCommandContext[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: async (command, context) => {
                if (command.kind === 'health') {
                    entered.resolve();
                    await release.promise;
                    return { status: 'ok' };
                }
                if (command.kind === 'rtc.connect') {
                    observed.push(context);
                    return { status: 'ok' };
                }
                return undefined;
            }
        });
        const first = runtime.execute(decode({
            kind: 'recipe.run',
            rtcCaptureMode: 'off',
            recipe: {
                schemaVersion: 1,
                recipeId: 'first',
                commands: [
                    { kind: 'configure', config: { rallar: { rtcCaptureMode: 'native' } } },
                    { kind: 'health' },
                    { kind: 'loop', count: 2, commands: [{ kind: 'rtc.connect', commandId: 'repeated' }] }
                ]
            }
        }));
        try {
            await entered.promise;
            await runtime.execute(decode({
                kind: 'recipe.run',
                rtcCaptureMode: 'native',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'second',
                    commands: [
                        { kind: 'configure', config: { rallar: { rtcCaptureMode: 'off' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            }));
        }
        finally {
            release.resolve();
            await first;
        }
        expect(observed.map((context) => context.rtcCapture)).toEqual([
            { run: 'native', recipe: undefined, step: 'off' },
            { run: 'off', recipe: undefined, step: 'native' },
            { run: 'off', recipe: undefined, step: 'native' }
        ]);
    });
    describe.each(['loop', 'parallel'] as const)('direct %s admission', (kind) => {
        it.each([
            { position: 'configure', invalid: { kind: 'configure', config: { rallar: { rtcCaptureMode: 'invalid' } } } },
            { position: 'step', invalid: { kind: 'rtc.connect', rallar: { rtcCaptureMode: 'invalid' } } },
            {
                position: 'run',
                invalid: {
                    kind: 'recipe.run',
                    rtcCaptureMode: 'invalid',
                    recipe: { schemaVersion: 1, recipeId: 'nested', commands: [{ kind: 'rtc.connect' }] }
                }
            },
            {
                position: 'recipe',
                invalid: {
                    kind: 'recipe.run',
                    recipe: { schemaVersion: 1, recipeId: 'nested', rtcCaptureMode: 'invalid', commands: [{ kind: 'rtc.connect' }] }
                }
            }
        ])('rejects later $position capture before any child effect', async ({ invalid }) => {
            const effects: string[] = [];
            const runtime = createDefaultRallarBlackBoxTestRuntime({
                commandExecutor: async (command) => {
                    if (command.kind === 'loop' || command.kind === 'parallel') {
                        return undefined;
                    }
                    effects.push(command.kind);
                    return { status: 'ok' };
                }
            });
            const first = { kind: 'rtc.connect' };
            const command = kind === 'loop'
                ? { kind, count: 1, commands: [first, invalid] }
                : { kind, groups: [{ commands: [first] }, { commands: [{ kind: 'loop', count: 1, commands: [invalid] }] }] };
            const result = await runtime.execute(JSON.parse(JSON.stringify(command)));
            expect(result.ok).toBe(false);
            expect(effects).toEqual([]);
        });

        it('keeps opaque lookalike command payloads outside executable validation', async () => {
            const lookalike = { kind: 'configure', config: { rallar: { rtcCaptureMode: 'invalid' } } };
            const opaque = kind === 'loop' ? { application: lookalike } : new Map([['application', lookalike]]);
            const received: RallarBlackBoxTestCommand[] = [];
            const runtime = createDefaultRallarBlackBoxTestRuntime({
                commandExecutor: async (command) => {
                    if (command.kind === 'ws.send') {
                        received.push(command);
                        return { status: 'ok' };
                    }
                    return undefined;
                }
            });
            const child: RallarBlackBoxTestCommand = { kind: 'ws.send', data: opaque };
            const command: RallarBlackBoxTestCommand = kind === 'loop'
                ? { kind, count: 1, commands: [child] }
                : { kind, groups: [{ commands: [child] }] };
            expect((await runtime.execute(command)).ok).toBe(true);
            expect(received).toHaveLength(1);
            const payload = received[0].kind === 'ws.send' && received[0].data;
            expect(payload).toEqual(opaque);
            if (kind === 'parallel') {
                expect(payload).toBe(opaque);
            }
        });
    });
});
