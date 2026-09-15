import { describe, expect, it } from 'vitest';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-test-runtime.ts';
import type { RallarBlackBoxTestRecipe } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
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
        expect.soft(validateRallarBlackBoxTestCommand(command)).toEqual({ ok: false, error: `${kind}.recipe.schemaVersion must be 1.` });
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
