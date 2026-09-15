import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inventoryDistributedRunTuningKnobs } from '../../../packages/shared-test/rallar-bb-test/distributed-run-tuning.ts';
import { validateDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run-validation.ts';
import {
    createRecipeConsoleTuneScaleFixture,
    RECIPE_CONSOLE_TUNE_SCALE_DEFAULT_COMMAND_COUNT,
    RECIPE_CONSOLE_TUNE_SCALE_KNOBS_PER_COMMAND
} from '../../../packages/shared-test/rallar-bb-test/recipe-console-tune-scale-fixture.ts';

describe('Recipe Console Tune scale fixture', () => {
    it('keeps the deterministic builder within its focused module budget', () => {
        const source = readFileSync(
            new URL(
                '../../../packages/shared-test/rallar-bb-test/recipe-console-tune-scale-fixture.ts',
                import.meta.url
            ),
            'utf8'
        );

        expect(source.trimEnd().split(/\r?\n/u).length).toBeLessThanOrEqual(220);
    });

    it('creates a valid 2,000-command stream recipe with 24,002 unique editable knobs', () => {
        const fixture = createRecipeConsoleTuneScaleFixture();
        const second = createRecipeConsoleTuneScaleFixture();
        const validation = validateDistributedRunManifest(fixture.manifest);
        const inventory = inventoryDistributedRunTuningKnobs(fixture.manifest);

        expect(RECIPE_CONSOLE_TUNE_SCALE_DEFAULT_COMMAND_COUNT).toBe(2_000);
        expect(RECIPE_CONSOLE_TUNE_SCALE_KNOBS_PER_COMMAND).toBe(12);
        expect(fixture.counts).toEqual({
            commands: 2_000,
            expectedKnobs: 24_002,
            expectedEditableKnobs: 24_002
        });
        expect(fixture.recipe.commands).toHaveLength(2_000);
        expect(validation.ok, JSON.stringify(validation.errors, null, 2)).toBe(true);
        expect(inventory.limitations).toEqual([]);
        expect(inventory.knobs).toHaveLength(24_002);
        expect(new Set(inventory.knobs.map((knob) => knob.pointer)).size).toBe(24_002);
        expect(inventory.knobs.every((knob) => knob.effective && knob.availability !== 'blocked')).toBe(true);
        expect(second).toEqual(fixture);
        expect(second).not.toBe(fixture);
        expect(second.manifest).not.toBe(fixture.manifest);

        const commandIds = fixture.recipe.commands.map((command) => command.commandId);
        for (const position of ['first', 'middle', 'last', 'longBidi'] as const) {
            const index = fixture.positions[position];
            expect(commandIds[index]).toBe(fixture.needles.commandIds[position]);
            expect(commandIds.filter((id) => id === fixture.needles.commandIds[position])).toHaveLength(1);
        }
        expect(fixture.needles.commandIds.longBidi).toMatch(/[界\u202e\u2066]/u);
        expect(fixture.needles.commandIds.longBidi.length).toBeGreaterThan(120);
    });

    it('scales the exact knob formula for a smaller deterministic recipe', () => {
        const fixture = createRecipeConsoleTuneScaleFixture({ commandCount: 8 });
        const inventory = inventoryDistributedRunTuningKnobs(fixture.manifest);

        expect(fixture.counts).toEqual({
            commands: 8,
            expectedKnobs: 98,
            expectedEditableKnobs: 98
        });
        expect(inventory.knobs).toHaveLength(98);
        expect(inventory.limitations).toEqual([]);
        expect(validateDistributedRunManifest(fixture.manifest).ok).toBe(true);
    });
});
