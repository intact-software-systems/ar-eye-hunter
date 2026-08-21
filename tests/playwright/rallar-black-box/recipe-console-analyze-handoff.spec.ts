import { expect, test } from '@playwright/test';
import { createAnalyzeEnvelopeFile, createAnalyzeLooseFiles } from './recipe-console-analyze-artifacts.ts';
import { installRecipeConsoleAnalyzeFixture } from './recipe-console-analyze-fixture.ts';
import {
    analyzeLegacyRunsLink,
    analyzeSource,
    analyzeVerdict,
    chooseAnalyzeFiles,
    dropAnalyzeFiles
} from './recipe-console-analyze-helpers.ts';
import {
    ANALYZE_CONTROL_RUN_ID,
    ANALYZE_DISTRIBUTED_RUN_ID,
    ANALYZE_FAILURE_MESSAGE,
    ANALYZE_ROUTE
} from './recipe-console-analyze-run-data.ts';

test('keyboard-activates the Choose files import trigger', async ({ context, page }) => {
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    const trigger = analyzeSource(page).getByText('Choose files', { exact: true });
    await trigger.focus();
    const focusWasOnTrigger = await trigger.evaluate(
        (element) => element === document.activeElement
    );
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 2_000 });
    await page.keyboard.press('Enter');
    const chooser = await chooserPromise;
    expect(focusWasOnTrigger).toBe(true);
    await chooser.setFiles([createAnalyzeEnvelopeFile()]);
    await expect(analyzeSource(page).locator('[data-artifact-status]'))
        .toHaveText('Artifact ready');
    await expect(analyzeVerdict(page)).toContainText(ANALYZE_FAILURE_MESSAGE);
});

test('imports an idle loose bundle through a DataTransfer drop', async ({ context, page }) => {
    const fixture = await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await dropAnalyzeFiles(page, createAnalyzeLooseFiles());
    await expect(analyzeSource(page).locator('[data-artifact-status]'))
        .toHaveText('Artifact ready');
    await expect(analyzeVerdict(page)).toContainText('First actionable failure');
    await expect(analyzeVerdict(page)).toContainText(ANALYZE_FAILURE_MESSAGE);
    expect(fixture.artifactRequestCount()).toBe(0);
});

test('opens the selected Analyze run in the exact legacy Runs context', async ({ context, page }) => {
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, [createAnalyzeEnvelopeFile()]);
    await analyzeLegacyRunsLink(page).click();
    await expect(page).toHaveURL(/experience=legacy/);
    await expect(page).toHaveURL(/workspace=black-box-runner/);
    await expect(page).toHaveURL(/tab=runs/);
    await expect(page.getByRole('tab', { name: 'Runs', exact: true }))
        .toHaveAttribute('aria-selected', 'true');
    const runs = page.locator('#panel-runs');
    await expect(runs).toBeVisible();
    await expect(runs.getByRole('combobox', { name: 'Distributed Run' }))
        .toHaveValue(ANALYZE_DISTRIBUTED_RUN_ID);
    await expect(runs.locator('.runner-distributed-freshness'))
        .toContainText(ANALYZE_CONTROL_RUN_ID);
});

test('opens the generic exporter on the exact legacy Shared Test surface', async ({ context, page }) => {
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await analyzeSource(page).getByRole('link', {
        name: 'Open generic export in legacy Shared Test'
    }).click();
    await expect(page).toHaveURL(/experience=legacy/);
    await expect(page).toHaveURL(/workspace=black-box-runner/);
    await expect(page).toHaveURL(/tab=advanced/);
    await expect(page).toHaveURL(/advancedSurface=shared-test/);
    await expect(page.getByRole('tab', { name: 'Advanced', exact: true }))
        .toHaveAttribute('aria-selected', 'true');
    const advanced = page.locator('#panel-advanced');
    await expect(advanced).toBeVisible();
    await expect(advanced.getByRole('button', { name: 'Shared Test', exact: true }))
        .toHaveClass(/selected/);
    const sharedTest = advanced.locator('#panel-shared-test');
    await expect(sharedTest).toBeVisible();
    await expect(sharedTest.getByRole('heading', { name: 'Recipe Catalog' }))
        .toBeVisible();
    await expect(sharedTest.getByRole('heading', { name: 'Artifact Import' }))
        .toBeVisible();
});
