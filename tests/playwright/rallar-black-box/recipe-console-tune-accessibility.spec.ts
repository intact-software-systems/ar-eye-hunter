import { expect, test, type Locator } from '@playwright/test';
import { installRecipeConsoleTuneFixture } from './recipe-console-tune-fixture.ts';
import { chooseTuneListboxOptionWithKeyboard } from
    './recipe-console-tune-listbox-helpers.ts';
import {
    TUNE_COMPARE_ROUTE,
    TUNE_LEFT_RUN_ID,
} from './recipe-console-tune-run-data.ts';

const CANDIDATE_POINTER = '/recipes/0/recipe/commands/0/rateHz';

async function expectMinimumTarget(locator: Locator, label: string): Promise<void> {
    await expect(locator, `${label} should be visible`).toBeVisible();
    const bounds = await locator.boundingBox();
    expect(bounds, `${label} should have rendered bounds`).not.toBeNull();
    if (!bounds) return;
    expect(bounds.width, `${label} target width`).toBeGreaterThanOrEqual(44);
    expect(bounds.height, `${label} target height`).toBeGreaterThanOrEqual(44);
}

test('previews and reads an exact candidate diff from the portrait keyboard path', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 430, height: 932 });
    const fixture = await installRecipeConsoleTuneFixture(context);
    await page.goto(TUNE_COMPARE_ROUTE);

    const candidate = page.locator('[data-tune-candidate]');
    const input = candidate.getByLabel('Candidate value');
    await input.focus();
    await expect(input).toBeFocused();
    await input.press('ControlOrMeta+A');
    await input.pressSequentially('24');
    await expect(input).toHaveValue('24');
    await expectMinimumTarget(input, 'candidate value input');

    const preview = candidate.getByRole('button', { name: 'Preview candidate' });
    await preview.focus();
    await expect(preview).toBeFocused();
    await expectMinimumTarget(preview, 'candidate preview button');
    await page.keyboard.press('Enter');
    await expect(candidate.getByRole('status'))
        .toHaveText('Candidate preview ready; source manifest unchanged.');

    const disclosure = candidate.locator('details');
    const summary = disclosure.locator('summary', { hasText: 'Readable diff' });
    await expectMinimumTarget(summary, 'readable diff summary');
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(disclosure.locator('pre')).toBeVisible();
    await expect(disclosure.locator('pre'))
        .toHaveText(`${CANDIDATE_POINTER}: 30 -> 24`);

    await page.keyboard.press('Space');
    await expect(disclosure).not.toHaveAttribute('open', '');
    await expect(summary).toBeFocused();
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('announces keyboard-selected same-run comparison state and its issue atomically', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 430, height: 932 });
    const fixture = await installRecipeConsoleTuneFixture(context);
    await page.goto(TUNE_COMPARE_ROUTE);

    const comparison = page.locator('[data-tune-comparison]');
    const announcement = comparison.getByRole('status');
    await expect(announcement).toBeVisible();
    await expect(announcement).toHaveAttribute('aria-live', 'polite');
    await expect(announcement).toHaveAttribute('aria-atomic', 'true');
    await expect(announcement).toHaveText('Comparison state: ready.');

    await chooseTuneListboxOptionWithKeyboard(
        page,
        'Candidate run',
        TUNE_LEFT_RUN_ID,
    );

    await expect(page).toHaveURL(new RegExp(`compareRight=${TUNE_LEFT_RUN_ID}`));
    await expect(announcement).toHaveText(
        'Comparison state: same run. Baseline and candidate must be different runs.',
    );
    await expect(comparison.locator('[data-compare-category]')).toHaveCount(0);
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});
