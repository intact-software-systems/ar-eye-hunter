import { describe, expect, it } from 'vitest';
import { parseControlServerMessage } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestRecipe } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

describe('explicit browser recipe format', () => {
    it('rejects an omitted version with a path-specific schema error', () => {
        const validation = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, {
            recipeId: 'unversioned',
            commands: [{ kind: 'health' }]
        });
        expect(validation).toMatchObject({ ok: false, errors: [{ path: '$', message: 'Missing required property schemaVersion.' }] });
    });

    it.each(['recipe.load', 'recipe.run'] as const)('rejects unversioned %s at both command boundaries', async (kind) => {
        const recipe = { schemaVersion: 1 as const, recipeId: 'unversioned', commands: [{ kind: 'health' as const }] };
        Reflect.deleteProperty(recipe, 'schemaVersion');
        const command = { kind, recipe };
        expect.soft(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
        expect.soft(validateRallarBlackBoxTestCommand(command)).toEqual({
            ok: false,
            error: `${kind}.recipe.schemaVersion must be 1.`,
            messages: [`${kind}.recipe.schemaVersion must be 1.`]
        });
        const runtime = createRallarBlackBoxTestRuntime();
        const result = await runtime.execute(command);
        expect.soft(result.ok).toBe(false);
        expect.soft(result.error?.message).toContain('schemaVersion must be 1');
        expect(runtime.state().loadedRecipe).toBeUndefined();
    });

    it.each([1, 2, 4])('rejects an unversioned inline recipe at depth %s before loading or running', async (depth) => {
        let recipe: RallarBlackBoxTestRecipe = { schemaVersion: 1, recipeId: 'missing-version', commands: [{ kind: 'health' }] };
        Reflect.deleteProperty(recipe, 'schemaVersion');
        for (let level = 0; level < depth; level += 1) {
            recipe = { schemaVersion: 1, recipeId: `parent-${level}`, commands: [{ kind: 'recipe.run', recipe }] };
        }
        expect.soft(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe).ok).toBe(false);
        for (const kind of ['recipe.load', 'recipe.run'] as const) {
            const command = { kind, recipe };
            expect.soft(validateRallarBlackBoxTestCommand(command).ok).toBe(false);
            const runtime = createRallarBlackBoxTestRuntime();
            const result = await runtime.execute(command);
            expect.soft(result.ok).toBe(false);
            expect.soft(result.error?.message).toContain('schemaVersion must be 1');
            expect.soft(runtime.state().loadedRecipe).toBeUndefined();
        }
    });

    it('accepts explicit v1 and rejects unsupported versions without rewriting input', () => {
        const recipe = { schemaVersion: 1, recipeId: 'canonical', commands: [{ kind: 'health' }] };
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe).ok).toBe(true);
        const unsupported = { ...recipe, schemaVersion: 2 };
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, unsupported).ok).toBe(false);
        expect(unsupported.schemaVersion).toBe(2);
    });
});

describe('recipe field admission', () => {
    it.each(['recipe.load', 'recipe.run'] as const)('rejects malformed fields throughout %s before effects', async (kind) => {
        const malformed: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'malformed',
            commands: [{ kind: 'health' }]
        };
        Object.assign(malformed, { name: 1, description: false, continueOnFailure: 'true', metadata: [] });
        for (
            const recipe of [malformed, {
                schemaVersion: 1 as const,
                recipeId: 'outer',
                commands: [{
                    kind: 'loop' as const,
                    count: 1,
                    commands: [{
                        kind: 'parallel' as const,
                        groups: [{ commands: [{ kind, recipe: malformed }] }]
                    }]
                }]
            }]
        ) {
            const command = { kind, recipe };
            expect.soft(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
            const parsed = parseControlServerMessage(
                JSON.stringify({
                    kind: 'command',
                    protocolVersion: 1,
                    runId: 'run',
                    agentId: 'agent',
                    commandId: 'invalid',
                    command
                }),
                { runId: 'run', agentId: 'agent' }
            );
            expect.soft(parsed.ok).toBe(false);
            if (!parsed.ok) {
                for (const field of ['name', 'description', 'continueOnFailure', 'metadata']) {
                    expect.soft(parsed.error).toContain(`.${field} must be`);
                }
            }
            const effects: string[] = [];
            const runtime = createRallarBlackBoxTestRuntime({
                commandExecutor: async (child) => {
                    effects.push(child.kind);
                    return undefined;
                }
            });
            const result = await runtime.execute(command);
            expect.soft(result.status).toBe('failed');
            for (const field of ['name', 'description', 'continueOnFailure', 'metadata']) {
                expect.soft(result.error?.message).toContain(`.${field} must be`);
            }
            expect.soft(runtime.state().loadedRecipe).toBeUndefined();
            expect.soft(effects).toEqual([]);
        }
    });

    it.each([false, true])('preserves boolean continuation %s and opaque payloads through the wire', async (continueOnFailure) => {
        const payload = { recipe: { schemaVersion: 'opaque', continueOnFailure: 'payload' } };
        const parsed = parseControlServerMessage(
            JSON.stringify({
                kind: 'command',
                protocolVersion: 1,
                runId: 'run',
                agentId: 'agent',
                commandId: 'valid',
                command: {
                    kind: 'recipe.run',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'valid',
                        name: '',
                        description: '',
                        continueOnFailure,
                        metadata: { recipe: { schemaVersion: 'opaque' } },
                        commands: [{ kind: 'rtc.send', send: 'fail' }, { kind: 'rtc.send', send: payload }]
                    }
                }
            }),
            { runId: 'run', agentId: 'agent' }
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        const effects: unknown[] = [];
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: async (command) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }
                effects.push(command.send);
                return { status: command.send === 'fail' ? 'failed' : 'ok' };
            }
        });
        const result = await runtime.execute(parsed.envelope.command);
        expect(result.status).toBe(continueOnFailure ? 'ok' : 'failed');
        expect(effects).toEqual(continueOnFailure ? ['fail', payload] : ['fail']);
    });
});
