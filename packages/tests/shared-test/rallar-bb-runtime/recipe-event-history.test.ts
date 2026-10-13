import {
    describe,
    expect,
    it
} from 'vitest';

import type { RallarBlackBoxTestResult } from '../../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '../../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';

const authored = {
    schemaVersion: 1,
    recipeId: 'authored',
    eventHistory: { mode: 'recent', maxEvents: 3 },
    commands: [{ kind: 'health', commandId: 'child-health' }]
} as const;

describe('recipe event history admission', () => {
    it('applies authored policy on a persistent runtime and restores configured inheritance for the next recipe', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        for (let index = 0; index < 6; index++) {
            runtime.recordEvent({ kind: 'message', topic: 'prior' });
        }
        const first = await runtime.execute({ kind: 'recipe.run', commandId: 'first', recipe: authored });
        expect(first.status).toBe('ok');
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 3 });
        const next = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'next',
            recipe: { schemaVersion: 1, recipeId: 'inherit', commands: [{ kind: 'health' }] }
        });
        expect(next.status).toBe('ok');
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'full' });
        expect(runtime.state().eventHistory.evictedEvents).toBeGreaterThan(0);
    });

    it('gives the run override precedence over authored and initial policies', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime({ eventHistory: { mode: 'recent', maxEvents: 1 } });
        const result = await runtime.execute({ kind: 'recipe.run', commandId: 'override', recipe: authored, eventHistory: { mode: 'full' } });
        expect(result.status).toBe('ok');
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'full' });
        expect(result.value).toMatchObject({ invocation: { eventHistory: { mode: 'full' } } });
    });

    it('rejects malformed run and authored selection before any children execute', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const invalid = await runtime.execute({ kind: 'recipe.run', commandId: 'invalid', recipe: authored, eventHistory: { mode: 'recent', maxEvents: 0 } });
        expect(invalid.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_INVALID');
        expect(runtime.state().resultCache['child-health']).toBeUndefined();
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'full' });
    });

    it('keeps the outer run override above conflicting nested authored selection', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const result = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'outer',
            eventHistory: { mode: 'recent', maxEvents: 2 },
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                commands: [{
                    kind: 'recipe.run',
                    recipe: { schemaVersion: 1, recipeId: 'nested', eventHistory: { mode: 'full' }, commands: [{ kind: 'health' }] }
                }]
            }
        });
        expect(result.status).toBe('ok');
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 2 });
    });

    it.each(['run', 'authored'] as const)('refuses a conflicting nested %s policy before earlier children produce effects', async (source) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const nested = {
            schemaVersion: 1,
            recipeId: 'nested',
            commands: [{ kind: 'health' }],
            ...(source === 'authored' ? { eventHistory: { mode: 'full' as const } } : {})
        } as const;
        const result = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'outer',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                eventHistory: { mode: 'recent', maxEvents: 2 },
                commands: [{ kind: 'health', commandId: 'first-effect' }, {
                    kind: 'recipe.run',
                    recipe: nested,
                    ...(source === 'run' ? { eventHistory: { mode: 'full' } } : {})
                }]
            }
        });
        expect(result.status).toBe('failed');
        expect(runtime.state().resultCache['first-effect']).toBeUndefined();
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'full' });
    });

    it('rejects a conflicting loaded nested body before outer child effects', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const result = await runtime.execute({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                eventHistory: { mode: 'recent', maxEvents: 2 },
                commands: [{ kind: 'health', commandId: 'earlier' }, {
                    kind: 'recipe.load',
                    recipe: { schemaVersion: 1, recipeId: 'loaded', eventHistory: { mode: 'full' }, commands: [{ kind: 'health' }] }
                }, { kind: 'recipe.run' }]
            }
        });
        expect(result.status).toBe('failed');
        expect(runtime.state().resultCache['earlier']).toBeUndefined();
    });

    it('refuses a previously loaded conflicting body before earlier effects or retained coverage loss', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        await runtime.execute({
            kind: 'recipe.load',
            recipe: {
                schemaVersion: 1,
                recipeId: 'previous-full',
                eventHistory: { mode: 'full' },
                commands: [{ kind: 'health' }]
            }
        });
        for (let index = 0; index < 6; index++) {
            runtime.recordEvent({ kind: 'message', topic: `prior.${index}` });
        }
        const result = await runtime.execute({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                eventHistory: { mode: 'recent', maxEvents: 2 },
                commands: [{ kind: 'health', commandId: 'earlier-effect' }, { kind: 'recipe.run' }]
            }
        });
        expect(result.status).toBe('failed');
        expect(runtime.state().resultCache['earlier-effect']).toBeUndefined();
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'full' });
        expect(runtime.state().eventHistory.evictedEvents).toBe(0);
        expect(runtime.state().events.filter((event) => event.topic.startsWith('prior.')).length).toBe(6);
    });

    it('validates the body selected by an explicit load transition instead of the previous loaded body', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        await runtime.execute({
            kind: 'recipe.load',
            recipe: {
                schemaVersion: 1,
                recipeId: 'previous-full',
                eventHistory: { mode: 'full' },
                commands: [{ kind: 'health' }]
            }
        });
        const result = await runtime.execute({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                eventHistory: { mode: 'recent', maxEvents: 2 },
                commands: [{
                    kind: 'recipe.load',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'replacement',
                        eventHistory: { mode: 'recent', maxEvents: 2 },
                        commands: [{ kind: 'health', commandId: 'replacement-effect' }]
                    }
                }, { kind: 'recipe.run' }]
            }
        });
        expect(result.status).toBe('ok');
        expect(runtime.state().resultCache['replacement-effect']?.status).toBe('ok');
    });

    it('binds a bodyless child to the admitted body despite a competing later load', async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            sleep: async () => {
                entered.resolve();
                await release.promise;
            }
        });
        const loaded = await runtime.execute({
            kind: 'recipe.load',
            recipe: {
                schemaVersion: 1,
                recipeId: 'accepted-body',
                commands: [{ kind: 'health', commandId: 'accepted-effect' }]
            }
        });
        const run = runtime.execute({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                commands: [
                    { kind: 'wait', absent: true, timeoutMs: 1, match: { topic: 'forbidden' } },
                    { kind: 'recipe.run' }
                ]
            }
        });
        await entered.promise;
        await runtime.execute({
            kind: 'recipe.load',
            recipe: {
                schemaVersion: 1,
                recipeId: 'competing-body',
                commands: [{ kind: 'health', commandId: 'competing-effect' }]
            }
        });
        release.resolve();
        expect((await run).status).toBe('ok');
        expect(runtime.state().resultCache['accepted-effect']?.status).toBe('ok');
        expect(runtime.state().resultCache['competing-effect']).toBeUndefined();
        expect(runtime.state().resultCache['accepted-effect']).toBeDefined();
        expect(loaded.value).toMatchObject({ recipeId: 'accepted-body' });
    });

    it('refuses a bodyless child after an explicit reset before outer effects', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        await runtime.execute({ kind: 'recipe.load', recipe: { schemaVersion: 1, recipeId: 'loaded', commands: [{ kind: 'health' }] } });
        const result = await runtime.execute({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                commands: [{ kind: 'health', commandId: 'before-reset' }, { kind: 'reset' }, { kind: 'recipe.run' }]
            }
        });
        expect(result.status).toBe('failed');
        expect(runtime.state().resultCache['before-reset']).toBeUndefined();
        expect(runtime.state().eventHistory.generation).toBe(0);
    });

    it.each([{ start: -1, end: 1, first: true }, { start: 0, end: 0, first: false }, { start: 0, end: 1.5, first: true }])(
        'refuses invalid owned segment %j before effects',
        async (segment) => {
            const runtime = createDefaultRallarBlackBoxTestRuntime();
            const result = await runtime.execute(
                {
                    kind: 'recipe.run',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'outer',
                        commands: [{ kind: 'health', commandId: 'forbidden-segment-effect' }]
                    }
                },
                { recipeExecution: { rootCommandId: 'invalid-range', first: segment.first, last: false, segment } }
            );
            expect(result.status).toBe('failed');
            expect(runtime.state().resultCache['forbidden-segment-effect']).toBeUndefined();
        }
    );

    it.each(['direct', 'subscriber'] as const)('locks the outer policy between ranges against %s Configure', async (source) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const command = {
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'segmented',
                eventHistory: { mode: 'recent', maxEvents: 2 },
                commands: [{ kind: 'health', commandId: 'prefix-health' }, { kind: 'health', commandId: 'suffix-health' }]
            }
        } as const;
        const first = await runtime.execute(command, {
            recipeExecution: {
                rootCommandId: 'outer-owner',
                first: true,
                last: false,
                segment: { start: 0, end: 1, first: true }
            }
        });
        expect(first.status).toBe('ok');
        const configure = { kind: 'configure', commandId: 'inter-range-configure', config: { eventHistory: { mode: 'recent', maxEvents: 1 } } } as const;
        const attempted = Promise.withResolvers<RallarBlackBoxTestResult>();
        let started = false;
        const unsubscribe = source === 'subscriber'
            ? runtime.subscribe(() => {
                if (!started) {
                    started = true;
                    void runtime.execute(configure).then(attempted.resolve);
                }
            })
            : () => {};
        try {
            const refused = source === 'direct' ? await runtime.execute(configure) : await attempted.promise;
            expect(refused.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_ACTIVE');
            expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 2 });
            const suffix = await runtime.execute(command, {
                eventHistorySelection: { policy: { mode: 'recent', maxEvents: 2 }, runOverride: false },
                recipeExecution: {
                    rootCommandId: 'outer-owner',
                    first: false,
                    last: true,
                    segment: { start: 1, end: 2, first: false }
                }
            });
            expect(suffix.value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 2 }, segment: { start: 1, end: 2, first: false } } });
            expect((await runtime.execute({ kind: 'configure', config: { eventHistory: { mode: 'full' } } })).status).toBe('ok');
            const inherited = await runtime.execute({ kind: 'recipe.run', recipe: { schemaVersion: 1, recipeId: 'later', commands: [{ kind: 'health' }] } });
            expect(inherited.value).toMatchObject({ invocation: { eventHistory: { mode: 'full' } } });
        }
        finally {
            unsubscribe();
        }
    });

    it('preflights intermediate accepted loads observable by a concurrent bodyless child', async () => {
        const safe = { schemaVersion: 1, recipeId: 'safe', commands: [{ kind: 'health' }] } as const;
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        await runtime.execute({ kind: 'recipe.load', recipe: safe });
        const result = await runtime.execute({
            kind: 'recipe.run',
            eventHistory: { mode: 'recent', maxEvents: 2 },
            recipe: {
                schemaVersion: 1,
                recipeId: 'outer',
                commands: [{ kind: 'health', commandId: 'before-parallel' }, {
                    kind: 'parallel',
                    maxConcurrency: 2,
                    groups: [
                        {
                            commands: [{
                                kind: 'recipe.load',
                                recipe: {
                                    schemaVersion: 1,
                                    recipeId: 'intermediate',
                                    commands: [{ kind: 'recipe.run', eventHistory: { mode: 'full' }, recipe: safe }]
                                }
                            }, { kind: 'recipe.load', recipe: safe }]
                        },
                        { commands: [{ kind: 'recipe.run' }] }
                    ]
                }]
            }
        });
        expect(result.status).toBe('failed');
        expect(runtime.state().resultCache['before-parallel']).toBeUndefined();
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'full' });
    });

    it.each(['missing', 'false-provenance'] as const)('refuses a fresh continuing range with %s admission', async (source) => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const selection = source === 'missing' ? undefined : { policy: { mode: 'recent', maxEvents: 2 } as const, runOverride: true };
        const result = await runtime.execute(
            {
                kind: 'recipe.run',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'outer',
                    eventHistory: { mode: 'recent', maxEvents: 2 },
                    commands: [
                        { kind: 'health' },
                        ...(source === 'missing'
                            ? [{ kind: 'health' as const, commandId: 'forbidden-resume-effect' }]
                            : [{
                                kind: 'recipe.run' as const,
                                recipe: {
                                    schemaVersion: 1 as const,
                                    recipeId: 'nested',
                                    eventHistory: { mode: 'full' as const },
                                    commands: [{ kind: 'health' as const, commandId: 'forbidden-resume-effect' }]
                                }
                            }])
                    ]
                }
            },
            {
                eventHistorySelection: selection,
                recipeExecution: { rootCommandId: 'unknown-owner', first: false, last: true, segment: { start: 1, end: 2, first: false } }
            }
        );
        expect(result.status).toBe('failed');
        expect(runtime.state().resultCache['forbidden-resume-effect']).toBeUndefined();
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'full' });
    });

    it('accepts named execution facts and runs only the admitted continuing range', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const result = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'named-continuation',
            recipe: {
                schemaVersion: 1,
                recipeId: 'named',
                commands: [{ kind: 'health', commandId: 'skipped-prefix' }, { kind: 'health', commandId: 'actual-suffix' }]
            }
        }, {
            controlIdentity: { runId: 'named-run', agentId: 'named-agent' },
            eventHistorySelection: { policy: { mode: 'recent', maxEvents: 2 }, runOverride: false },
            recipeExecution: { rootCommandId: 'named-root', first: false, last: true, segment: { start: 1, end: 2, first: false } }
        });
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 2 }, segment: { start: 1, end: 2, first: false } } });
        expect(runtime.state().resultCache['skipped-prefix']).toBeUndefined();
        expect(runtime.state().resultCache['actual-suffix'].ok).toBe(true);
        expect(runtime.state().events.at(-1)?.control).toMatchObject({ runId: 'named-run', agentId: 'named-agent' });
    });

    it('snapshots named execution facts before a command-id callback mutates the caller input', async () => {
        const selection = { policy: { mode: 'recent' as const, maxEvents: 2 }, runOverride: false };
        const segment = { start: 1, end: 2, first: false };
        let sequence = 0;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            idFactory: (prefix) => {
                if (prefix === 'command') {
                    selection.policy.maxEvents = 1;
                    segment.end = 1;
                }
                return `${prefix}-${sequence++}`;
            }
        });
        const result = await runtime.execute({
            kind: 'recipe.run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'snapshot',
                commands: [{ kind: 'health', commandId: 'skipped' }, { kind: 'health', commandId: 'accepted' }]
            }
        }, {
            eventHistorySelection: selection,
            recipeExecution: { rootCommandId: 'snapshot-root', first: false, last: true, segment }
        });
        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 2 }, segment: { start: 1, end: 2, first: false } } });
        expect(runtime.state().resultCache.skipped).toBeUndefined();
        expect(runtime.state().resultCache.accepted.ok).toBe(true);
    });

    it('keeps the successor lease when a retired last range settles with the same root id', async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            commandExecutor: async (command) => {
                if (command.commandId === 'held-A') {
                    entered.resolve();
                    await release.promise;
                }
                return command.kind === 'health' ? { status: 'ok' } : undefined;
            }
        });
        const original = runtime.execute({
            kind: 'recipe.run',
            commandId: 'range-A',
            eventHistory: { mode: 'recent', maxEvents: 2 },
            recipe: {
                schemaVersion: 1,
                recipeId: 'A',
                commands: [{ kind: 'health', commandId: 'held-A' }]
            }
        }, {
            controlIdentity: { runId: 'A', agentId: 'agent' },
            recipeExecution: { rootCommandId: 'shared-root', first: true, last: true, segment: { start: 0, end: 1, first: true } }
        });
        await entered.promise;
        try {
            const successor = await runtime.execute({
                kind: 'recipe.run',
                commandId: 'range-B',
                eventHistory: { mode: 'recent', maxEvents: 2 },
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'B',
                    commands: [{ kind: 'health', commandId: 'actual-B' }, { kind: 'health', commandId: 'pending-B' }]
                }
            }, {
                controlIdentity: { runId: 'B', agentId: 'agent' },
                recipeExecution: { rootCommandId: 'shared-root', first: true, last: false, segment: { start: 0, end: 1, first: true } }
            });
            expect(successor.ok).toBe(true);
            release.resolve();
            await original;
            const configured = await runtime.execute({ kind: 'configure', config: { eventHistory: { mode: 'full' } } }, {
                controlIdentity: { runId: 'B', agentId: 'agent' }
            });
            expect(configured.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_ACTIVE');
            expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 2 });
        }
        finally {
            release.resolve();
            await original;
            runtime.releaseRecipeExecution('shared-root', { runId: 'B', agentId: 'agent' });
        }
    });

    it('owns authored policy accepted by load and carries it across explicit reset generation', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const policy = { mode: 'recent', maxEvents: 2 } as const;
        await runtime.execute({ kind: 'recipe.load', recipe: { ...authored, eventHistory: policy } });
        Object.assign(policy, { maxEvents: 100 });
        const result = await runtime.execute({ kind: 'recipe.run' });
        expect(result.value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 2 } } });
        await runtime.execute({ kind: 'reset' });
        expect(runtime.state().eventHistory).toMatchObject({ generation: 1, policy: { mode: 'recent', maxEvents: 2 }, evictedEvents: 0 });
    });

    it('preserves the current view when no recipe is available for admission', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        await runtime.execute({ kind: 'recipe.run', commandId: 'recent', recipe: authored });
        const failed = await runtime.execute({ kind: 'recipe.run', commandId: 'missing' });
        expect(failed.status).toBe('failed');
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 3 });
    });

    it('locks the admitted choice before a policy-change subscriber can reconfigure it', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const attempted = Promise.withResolvers<string | undefined>();
        let changed = false;
        const unsubscribe = runtime.subscribe((state) => {
            if (!changed && state.eventHistory.policy.mode === 'recent') {
                changed = true;
                void runtime.execute({ kind: 'configure', commandId: 'reentrant-change', config: { eventHistory: { mode: 'full' } } }).then((result) =>
                    attempted.resolve(result.error?.code)
                );
            }
        });
        try {
            const result = await runtime.execute({ kind: 'recipe.run', recipe: authored });
            expect(result.status).toBe('ok');
            expect(await attempted.promise).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_ACTIVE');
            expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 3 });
        }
        finally {
            unsubscribe();
        }
    });

    it('freezes admitted run selection against caller mutation and competing configure', async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const policy = { mode: 'recent', maxEvents: 4 } as const;
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            sleep: async () => {
                entered.resolve();
                await release.promise;
            }
        });
        const run = runtime.execute({
            kind: 'recipe.run',
            commandId: 'pending',
            eventHistory: policy,
            recipe: { schemaVersion: 1, recipeId: 'pending', commands: [{ kind: 'wait', absent: true, timeoutMs: 1, match: { topic: 'forbidden' } }] }
        });
        await entered.promise;
        Object.assign(policy, { maxEvents: 50 });
        const refused = await runtime.execute({ kind: 'configure', commandId: 'change', config: { eventHistory: { mode: 'full' } } });
        expect(refused.error?.code).toBe('RALLAR_BLACK_BOX_HISTORY_POLICY_ACTIVE');
        expect(runtime.state().eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 4 });
        release.resolve();
        expect((await run).value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 4 } } });
    });
});
