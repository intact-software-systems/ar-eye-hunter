import { expect, test } from '@playwright/test';
import { installRecipeConsoleTuneFixture } from
    './recipe-console-tune-fixture.ts';
import { verifyTuneScalePressure } from
    './recipe-console-tune-scale-proof.ts';
import { TUNE_COMPARE_ROUTE } from './recipe-console-tune-run-data.ts';

test.use({
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
    viewport: { width: 932, height: 430 },
});

test('keeps 5,000 Tune runs and 24,002 knobs bounded, responsive, and poll-stable',
    async ({ browser }) => {
        test.setTimeout(120_000);
        await verifyTuneScalePressure(browser);
    });

test('keeps blocked Tune evidence capped and fully browseable by touch',
    async ({ context, page }) => {
        const fixture = await installRecipeConsoleTuneFixture(context, {
            tuneScale: {
                commandCount: 205,
                initial: true,
                runCount: 2,
                shadowedRateHz: true,
            },
        });
        await page.goto(TUNE_COMPARE_ROUTE);
        const inventory = page.locator('[data-tune-blocked-knobs]');
        const rows = inventory.locator('[data-tune-blocked-knob]');
        await expect(inventory).toHaveAttribute('data-tune-blocked-total', '205');
        await expect(rows).toHaveCount(100);
        const controls = inventory.getByRole('group', {
            name: 'Non-editable knob evidence window',
        });
        const range = inventory.locator('[data-tune-blocked-focus-anchor]');
        const values: string[] = [];
        for (const expected of [
            'Showing 1–100 of 205 blocked knobs.',
            'Showing 101–200 of 205 blocked knobs.',
            'Showing 201–205 of 205 blocked knobs.',
        ]) {
            await expect(range).toHaveText(expected);
            values.push(...await rows.locator('bdi').allTextContents());
            if (expected.startsWith('Showing 201')) break;
            await controls.getByRole('button', { name: 'Next' }).tap();
        }
        expect(values).toHaveLength(205);
        expect(new Set(values).size).toBe(205);
        await expect(range).toBeFocused();
        await expect(rows).toHaveCount(5);
        expect(fixture.mutationRequestCount()).toBe(0);
    });
