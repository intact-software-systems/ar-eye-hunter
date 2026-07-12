import { expect, test, type Page } from '@playwright/test';

type ConceptCase = Readonly<{
    name: string;
    snapshot: string;
    viewport: Readonly<{ width: number; height: number }>;
    view: 'execute' | 'monitor' | 'tune';
    ready(page: Page): Promise<void>;
}>;

const CONCEPT_CASES: readonly ConceptCase[] = [
    {
        name: 'matches the approved Execute desktop hierarchy',
        snapshot: 'signal-ledger-execute-desktop.png',
        viewport: { width: 1440, height: 900 },
        view: 'execute',
        ready: async page => {
            await expect(page.getByRole('heading', { level: 1, name: 'Execute recipe' }))
                .toBeVisible();
            await expect(page.getByRole('heading', { name: 'Recipe ledger' })).toBeVisible();
            await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
            await expect(page.locator('[data-command-bar]'))
                .toContainText('Execute · Preview · 2/2 targetable · rallar-server/default/seed-room');
            const recipeRegion = page.locator('section[aria-labelledby="recipe-ledger-heading"]');
            const ledgerRegion = page.getByRole('region', { name: 'Recipes' });
            const targetRegion = page.getByRole('region', { name: 'Sample targets and preflight' });
            const recipeBounds = await recipeRegion.boundingBox();
            const ledgerBounds = await ledgerRegion.boundingBox();
            const targetBounds = await targetRegion.boundingBox();
            expect(Math.abs((recipeBounds?.y ?? 0) - (targetBounds?.y ?? 0)))
                .toBeLessThanOrEqual(1);
            for (const label of [
                'RTC Realtime Stability',
                'Provider Parity',
                'Composite Evidence',
                'Expected Failure',
            ]) {
                const rowBounds = await page.getByRole('button', { name: new RegExp(label) })
                    .boundingBox();
                expect(rowBounds?.y ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(
                    ledgerBounds?.y ?? 0,
                );
                expect((rowBounds?.y ?? 0) + (rowBounds?.height ?? 0))
                    .toBeLessThanOrEqual((ledgerBounds?.y ?? 0) + (ledgerBounds?.height ?? 0) + 1);
            }
        },
    },
    {
        name: 'matches the approved failed Monitor desktop hierarchy',
        snapshot: 'signal-ledger-monitor-failed-desktop.png',
        viewport: { width: 1440, height: 900 },
        view: 'monitor',
        ready: async page => {
            await expect(page.getByText('Outcome failed', { exact: true })).toBeVisible();
            await expect(page.locator('[data-command-bar]'))
                .toContainText('Monitor · seed-failed-command · Failed · 1/2 agents failed');
            await expect(page.locator('[data-monitor-section="matrix"] [data-status-shape]'))
                .toHaveCount(6);
            const inspector = page.getByRole('complementary', { name: 'Inspector' });
            await expect(inspector).toBeVisible();
            expect((await inspector.boundingBox())?.width).toBe(360);
        },
    },
    {
        name: 'matches the approved Monitor portrait hierarchy',
        snapshot: 'signal-ledger-monitor-portrait.png',
        viewport: { width: 430, height: 932 },
        view: 'monitor',
        ready: async page => {
            await expect(page.getByText('Outcome failed', { exact: true })).toBeVisible();
            await expect(page.locator('[data-selection-dock]')).toBeVisible();
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
            await expect(page.getByText('Swipe phases', { exact: true })).toBeVisible();
            await expect(page.locator('[data-monitor-section="matrix"] [data-status-shape]'))
                .toHaveCount(6);
        },
    },
    {
        name: 'matches the approved Tune short-landscape hierarchy',
        snapshot: 'signal-ledger-tune-landscape.png',
        viewport: { width: 932, height: 430 },
        view: 'tune',
        ready: async page => {
            const matrix = page.locator('[data-landscape-matrix]');
            const distribution = page.getByRole('img', { name: 'Command duration distribution' });
            await expect(distribution).toBeVisible();
            expect((await matrix.boundingBox())?.y).toBeLessThanOrEqual(64);
            const distributionBounds = await distribution.boundingBox();
            expect((distributionBounds?.y ?? 0) + (distributionBounds?.height ?? 0))
                .toBeLessThanOrEqual(430);
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
        },
    },
];

test.describe('approved Signal Ledger concept fidelity', () => {
    for (const concept of CONCEPT_CASES) {
        test(concept.name, async ({ page }) => {
            await page.setViewportSize(concept.viewport);
            await page.goto(
                `/?provider=simulated&v=1&experience=recipe-console&view=${concept.view}`,
            );
            await expect(page.locator('.recipe-console')).toHaveAttribute(
                'data-view',
                concept.view,
            );
            await concept.ready(page);
            await page.evaluate(() => document.fonts.ready.then(() => undefined));

            test.skip(
                process.platform !== 'darwin',
                'Pixel baselines use the controlled Darwin render platform; semantic and geometry assertions completed before this skip.',
            );

            await expect(page).toHaveScreenshot(concept.snapshot, {
                animations: 'disabled',
                caret: 'hide',
                fullPage: false,
                maxDiffPixelRatio: 0.01,
                scale: 'css',
            });
        });
    }
});
