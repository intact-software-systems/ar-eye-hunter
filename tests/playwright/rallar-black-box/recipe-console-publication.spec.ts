import { expect, test } from '@playwright/test';
import { installRecipeConsoleAnalyzeFixture } from './recipe-console-analyze-fixture.ts';
import { analyzeSearch, analyzeSource, analyzeVerdict, chooseAnalyzeFiles } from './recipe-console-analyze-helpers.ts';
import {
    createPublicationLooseFiles,
    PUBLICATION_AGENT_ID,
    PUBLICATION_DIAGNOSTIC_ROWS,
    PUBLICATION_ROUTE,
    PUBLICATION_WARNING_COUNT
} from './recipe-console-publication-artifacts.ts';

test('shows a paced cell as staging and opportunity evidence rows with their identity', async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(PUBLICATION_ROUTE);
    await chooseAnalyzeFiles(page, createPublicationLooseFiles());
    await expect(analyzeSource(page).locator('[data-artifact-status]'))
        .toHaveText('Artifact ready');
    await expect.poll(fixture.artifactRequestCount).toBe(0);
    await expect(analyzeVerdict(page)).toHaveAttribute('data-run-state', 'passed');

    const performance = page.locator('[data-analyze-section="performance"]');
    await expect(performance.getByText('Diagnostics', { exact: true }).locator('..'))
        .toContainText(String(PUBLICATION_WARNING_COUNT));

    const search = analyzeSearch(page);
    await expect(search.locator('[data-analyze-matching-truth]'))
        .toContainText(`${PUBLICATION_DIAGNOSTIC_ROWS.length + 1} retained matches.`);
    await expect(search.locator('[data-evidence-result][data-evidence-kind="result"]')).toHaveCount(1);
    const rows = search.locator('[data-evidence-result][data-evidence-kind="diagnostic"]');
    await expect(rows).toHaveCount(PUBLICATION_DIAGNOSTIC_ROWS.length);
    for (const [index, expected] of PUBLICATION_DIAGNOSTIC_ROWS.entries()) {
        const row = rows.nth(index);
        await expect(row).toContainText(expected.message);
        await expect(row).toContainText('events.jsonl');
    }
});

test('names the displaced value in the Inspector identity summary', async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(PUBLICATION_ROUTE);
    await chooseAnalyzeFiles(page, createPublicationLooseFiles());

    const superseded = PUBLICATION_DIAGNOSTIC_ROWS.find((row) => row.outcome === 'superseded');
    if (!superseded) {
        throw new Error('The publication fixture has no superseded row.');
    }
    const row = analyzeSearch(page).locator('[data-evidence-result][data-evidence-kind="diagnostic"]', {
        hasText: superseded.message
    });
    await expect(row).toHaveCount(1);
    await row.focus();
    await page.keyboard.press('Enter');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector.locator('[data-analyze-inspector]'))
        .toHaveAttribute('data-selection-kind', 'diagnostic');
    await expect(inspector).toContainText(superseded.message);
    const identity = inspector.locator('[data-analyze-inspector] pre');
    await expect(identity).toContainText(`msgId=${superseded.msgId}`);
    await expect(identity).toContainText(`traceId=${superseded.traceId}`);
    await expect(inspector).toContainText(PUBLICATION_AGENT_ID);
});
