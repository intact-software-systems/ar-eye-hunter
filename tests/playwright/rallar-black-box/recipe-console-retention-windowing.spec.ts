import { expect, type Locator, type Page, test } from '@playwright/test';
import {
    installRecipeConsoleTuneFixture,
    RETENTION_LONG_BIDI_CONTROL_ID,
} from './recipe-console-tune-fixture.ts';
import { TUNE_ROUTE } from './recipe-console-tune-run-data.ts';

const RETENTION_PREVIEW_REQUEST = {
    kind: 'preview',
    method: 'POST',
    dryRun: true,
    hasPlanToken: false,
    body: null,
    authorization: null,
} as const;

test('bounds 205 retention candidates, totals, and dialog rows without hiding exact evidence',
    async ({ context, page }) => {
        const fixture = await installRecipeConsoleTuneFixture(context, {
            retention: 'ready',
            retentionCandidateCount: 205,
            retentionLongBidiId: true,
        });
        await page.goto(TUNE_ROUTE);
        const route = page.url();
        await page.getByRole('button', {
            name: 'Preview cleanup',
            exact: true,
        }).click();

        const retention = page.locator('[data-retention-panel]');
        await expect(retention.locator('[data-retention-candidate-row]'))
            .toHaveCount(50);
        await expect(retention).toContainText('Showing 1–50 of 205 candidates.');
        await expect(retention.locator('[data-retention-total-id-row]')).toHaveCount(0);

        await page.getByRole('button', {
            name: 'Review cleanup',
            exact: true,
        }).click();
        const dialog = page.getByRole('alertdialog', {
            name: 'Delete previewed runs?',
        });
        await expect(retention.locator('[data-retention-candidate-row]')).toHaveCount(0);
        await expect(dialog.locator('[data-retention-dialog-candidate-row]'))
            .toHaveCount(50);
        await expect(pressureRows(page)).toHaveCount(50);
        await nextWindow(page, 'Previewed runs to delete', 4);
        await expect(dialog.locator('[data-retention-dialog-candidate-row]'))
            .toHaveCount(5);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(retention.locator('[data-retention-candidate-row]')).toHaveCount(50);

        const candidates = windowControls(page, 'Retention candidates');
        const firstCandidateNext = candidates.getByRole('button', { name: 'Next' });
        await firstCandidateNext.focus();
        await firstCandidateNext.press('Enter');
        await expect(retention.locator('[data-retention-candidate-row]'))
            .toHaveCount(50);
        await nextWindow(page, 'Retention candidates', 2);
        await expect(retention.locator('bdi[data-exact-identifier]', {
            hasText: RETENTION_LONG_BIDI_CONTROL_ID,
        })).toHaveText(RETENTION_LONG_BIDI_CONTROL_ID);
        const finalCandidate = candidates.getByRole('button', { name: 'Next' });
        await finalCandidate.press('Enter');
        await expect(retention.locator('[data-retention-candidate-row]')).toHaveCount(5);
        await expect(retention.locator(
            '[data-retention-window-focus-anchor="Retention candidates"]',
        )).toBeFocused();

        const controlIds = retention.getByText('Control run IDs (205)', {
            exact: true,
        });
        await controlIds.click();
        await expect(retention.locator('[data-retention-total-id-row]')).toHaveCount(50);
        await expect(pressureRows(page)).toHaveCount(55);
        await nextWindow(page, 'Control run IDs', 4);
        await expect(retention.locator('[data-retention-total-id-row]')).toHaveCount(5);
        await controlIds.click();
        await expect(retention.locator('[data-retention-total-id-row]')).toHaveCount(0);

        expect(page.url()).toBe(route);
        expect(fixture.retentionRequests()).toEqual([RETENTION_PREVIEW_REQUEST]);
        expect(await page.locator('body').innerHTML()).not.toContain('history-plan-');
    });

test('unmounts closed 201-row linked consequences and windows them on reduced-motion mobile',
    async ({ browser }) => {
        const context = await browser.newContext({
            baseURL: 'http://127.0.0.1:5176',
            hasTouch: true,
            reducedMotion: 'reduce',
            viewport: { width: 430, height: 932 },
        });
        const fixture = await installRecipeConsoleTuneFixture(context, {
            retention: 'ready',
            retentionCandidateCount: 1,
            retentionLinkedCount: 201,
        });
        const page = await context.newPage();
        await page.goto(TUNE_ROUTE);
        await page.getByRole('button', {
            name: 'Preview cleanup',
            exact: true,
        }).click();

        const candidate = page.locator('[data-retention-candidate-row]');
        await expect(candidate.locator('[data-retention-linked-run-row]')).toHaveCount(0);
        await expect(candidate.locator('[data-retention-linked-fleet-row]')).toHaveCount(0);

        const linkedRuns = candidate.getByText('Linked distributed runs (201)', {
            exact: true,
        });
        await linkedRuns.tap();
        await expect(candidate.locator('[data-retention-linked-run-row]')).toHaveCount(50);
        await expect(pressureRows(page)).toHaveCount(51);
        await nextWindow(page, 'Linked distributed runs', 4, true);
        await expect(candidate.locator('[data-retention-linked-run-row]')).toHaveCount(1);
        await linkedRuns.tap();
        await expect(candidate.locator('[data-retention-linked-run-row]')).toHaveCount(0);

        const linkedFleet = candidate.getByText('Linked fleet reports (201)', {
            exact: true,
        });
        await linkedFleet.tap();
        await expect(candidate.locator('[data-retention-linked-fleet-row]')).toHaveCount(50);
        await expect(pressureRows(page)).toHaveCount(51);
        await nextWindow(page, 'Linked fleet reports', 4, true);
        await expect(candidate.locator('[data-retention-linked-fleet-row]')).toHaveCount(1);

        expect(await page.evaluate(() => document.documentElement.scrollWidth -
            document.documentElement.clientWidth)).toBe(0);
        expect(fixture.retentionRequests()).toEqual([RETENTION_PREVIEW_REQUEST]);
        await context.close();
    });

function windowControls(page: Page, label: string): Locator {
    return page.getByRole('group', { name: `${label} window`, exact: true });
}

function pressureRows(page: Page): Locator {
    return page.locator([
        '[data-retention-candidate-row]',
        '[data-retention-linked-run-row]',
        '[data-retention-linked-fleet-row]',
        '[data-retention-total-id-row]',
        '[data-retention-dialog-candidate-row]',
    ].join(','));
}

async function nextWindow(
    page: Page,
    label: string,
    count: number,
    touch = false,
): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        const next = windowControls(page, label).getByRole('button', { name: 'Next' });
        if (touch) await next.tap();
        else await next.click();
    }
}
