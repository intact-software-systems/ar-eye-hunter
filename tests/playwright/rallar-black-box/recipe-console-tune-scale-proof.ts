import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import {
    createRecipeConsoleTuneScaleFixture
} from '../../../packages/shared-test/rallar-bb-test/recipe-console-tune-scale-fixture.ts';
import { installRecipeConsoleTuneFixture, tuneScaleRunNeedles } from './recipe-console-tune-fixture.ts';
import { tuneListboxTrigger } from './recipe-console-tune-listbox-helpers.ts';
import { TUNE_COMPARE_ROUTE } from './recipe-console-tune-run-data.ts';

const PRODUCTION_BASE_URL = 'http://127.0.0.1:4176';
const RUN_COUNT = 5_000;
const COMMAND_COUNT = 2_000;

export async function verifyTuneScalePressure(browser: Browser): Promise<void> {
    await test.step(
        'Tune keeps 5,000 runs and 24,002 knobs bounded during held refresh',
        async () => {
            const context = await browser.newContext({
                baseURL: PRODUCTION_BASE_URL,
                colorScheme: 'light',
                deviceScaleFactor: 1,
                hasTouch: true,
                isMobile: true,
                locale: 'en-US',
                reducedMotion: 'reduce',
                timezoneId: 'UTC',
                viewport: { width: 932, height: 430 }
            });
            try {
                const page = await context.newPage();
                await installHeartbeat(page);
                const fixture = await installRecipeConsoleTuneFixture(context, {
                    tuneScale: {
                        commandCount: COMMAND_COUNT,
                        runCount: RUN_COUNT
                    }
                });
                await page.goto(TUNE_COMPARE_ROUTE);
                const workspace = page.locator('[data-tune-workspace]');
                const candidate = page.locator('[data-tune-candidate]');
                await expect(candidate).toBeVisible();
                const initialIndexBuilds = await numericAttribute(
                    candidate,
                    'data-tune-knob-index-builds'
                );

                fixture.setTuneScaleEnabled(true);
                fixture.holdNextDistributedSnapshot();
                const heartbeatBeforeAccept = await heartbeat(page);
                await page.getByLabel('Refresh control data').click();
                await expect.poll(() => fixture.heldDistributedSnapshotCount())
                    .toBe(1);
                await expect(workspace).toHaveAttribute(
                    'data-tune-refreshing',
                    'true'
                );
                await expect.poll(() => heartbeat(page)).toBeGreaterThan(
                    heartbeatBeforeAccept
                );
                await expect(candidate).toBeVisible();
                await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
                const heartbeatAtPaint = await heartbeat(page);
                fixture.releaseHeldDistributedSnapshot();

                await expect(candidate).toHaveAttribute(
                    'data-tune-editable-options',
                    '24002',
                    { timeout: 60_000 }
                );
                await expect.poll(() => heartbeat(page)).toBeGreaterThan(
                    heartbeatAtPaint
                );
                await expect(workspace).toHaveAttribute(
                    'data-tune-refreshing',
                    'false'
                );
                await expect(workspace).toHaveAttribute(
                    'data-tune-control-rows-indexed',
                    '5000'
                );
                await expect(workspace).toHaveAttribute(
                    'data-tune-distributed-rows-indexed',
                    '5000'
                );
                await expect(workspace).toHaveAttribute(
                    'data-tune-identity-projections',
                    '5000'
                );
                await expect(workspace).toHaveAttribute(
                    'data-tune-manifest-identity-checks',
                    '5000'
                );
                await expect(workspace).toHaveAttribute(
                    'data-tune-manifest-validations',
                    '2'
                );
                await expect(workspace).toHaveAttribute(
                    'data-tune-performance-derivations',
                    '2'
                );
                await expect(page.locator('[data-tune-source]')).toHaveAttribute(
                    'data-tune-picker-options-projected',
                    '5000'
                );
                await expect(candidate).toHaveAttribute(
                    'data-tune-knob-rows-visited',
                    '24002'
                );
                await expect(candidate).toHaveAttribute(
                    'data-tune-knob-revision-rows',
                    '24002'
                );
                await expect(candidate).toHaveAttribute(
                    'data-tune-blocked-options',
                    '0'
                );
                expect(
                    await numericAttribute(
                        candidate,
                        'data-tune-knob-index-builds'
                    )
                ).toBeGreaterThan(initialIndexBuilds);
                expect(fixture.mutationRequestCount()).toBe(0);
                await candidate.getByLabel('Candidate value').fill('27');

                const runPopup = await tapListbox(page, 'Candidate run');
                const runSearch = runPopup.getByRole('combobox', {
                    name: 'Search Candidate run'
                });
                const runOptions = runPopup.getByRole('option');
                await expect(runOptions).toHaveCount(100);
                const runNeedles = tuneScaleRunNeedles(RUN_COUNT);
                for (const needle of Object.values(runNeedles)) {
                    await runSearch.fill(needle);
                    await expect(runOptions).toHaveCount(1);
                    await expect(runOptions.first()).toHaveAttribute(
                        'data-option-key',
                        needle
                    );
                    await expect(runOptions.first().locator('bdi')).toHaveText(needle);
                }
                await runSearch.fill('');
                await runSearch.press('Home');
                await expect(runPopup.locator('[data-searchable-listbox-range]'))
                    .toHaveText('Showing 1–100 of 5,000 options.');
                await runSearch.press('End');
                await expect(runPopup.locator('[data-searchable-listbox-range]'))
                    .toHaveText('Showing 4,901–5,000 of 5,000 options.');
                await expect(runOptions).toHaveCount(100);

                await runSearch.fill('tune-scale');
                await expect(runPopup).toHaveAttribute('aria-busy', 'false');
                await runSearch.press('PageDown');
                await runSearch.press('PageDown');
                await expect(runPopup.locator('[data-searchable-listbox-range]'))
                    .toHaveText('Showing 201–300 of 4,998 options.');
                const stableRange = await runPopup.locator(
                    '[data-searchable-listbox-range]'
                ).textContent();
                const stableBuilds = await numericAttribute(
                    candidate,
                    'data-tune-knob-index-builds'
                );
                const stableCatalogBuilds = await numericAttribute(
                    workspace,
                    'data-tune-catalog-builds'
                );
                const cacheHitsBefore = await numericAttribute(
                    workspace,
                    'data-tune-catalog-cache-hits'
                );
                fixture.holdNextDistributedSnapshot();
                const cloneRequestCount = fixture.distributedSnapshotRequestCount();
                const cloneHeartbeat = await heartbeat(page);
                await page.getByLabel('Refresh control data').evaluate(
                    (button: HTMLButtonElement) => button.click()
                );
                await expect.poll(() => fixture.heldDistributedSnapshotCount())
                    .toBe(2);
                await expect.poll(() => heartbeat(page)).toBeGreaterThan(
                    cloneHeartbeat
                );
                fixture.releaseHeldDistributedSnapshot();
                await expect.poll(() => fixture.distributedSnapshotRequestCount())
                    .toBeGreaterThan(cloneRequestCount);
                await expect(workspace).toHaveAttribute(
                    'data-tune-catalog-cache-hit',
                    'true'
                );
                expect(await numericAttribute(workspace, 'data-tune-catalog-builds'))
                    .toBe(stableCatalogBuilds);
                expect(
                    await numericAttribute(
                        workspace,
                        'data-tune-catalog-cache-hits'
                    )
                ).toBeGreaterThan(cacheHitsBefore);
                expect(
                    await numericAttribute(
                        candidate,
                        'data-tune-knob-index-builds'
                    )
                ).toBe(stableBuilds);
                await expect(runSearch).toHaveValue('tune-scale');
                await expect(runPopup.locator('[data-searchable-listbox-range]'))
                    .toHaveText(stableRange ?? '');
                await expect(candidate.getByLabel('Candidate value')).toHaveValue('27');
                await runSearch.press('Escape');

                const knobPopup = await tapListbox(candidate, 'Exact knob path');
                const knobSearch = knobPopup.getByRole('combobox', {
                    name: 'Search Exact knob path'
                });
                const knobOptions = knobPopup.getByRole('option');
                await expect(knobOptions).toHaveCount(100);
                const knobFixture = createRecipeConsoleTuneScaleFixture();
                for (
                    const position of [
                        'first',
                        'middle',
                        'last',
                        'longBidi'
                    ] as const
                ) {
                    const commandId = knobFixture.needles.commandIds[position];
                    const commandIndex = knobFixture.positions[position];
                    await knobSearch.fill(commandId);
                    await expect(knobOptions).toHaveCount(12);
                    await expect(knobSearch).toHaveValue(commandId);
                    for (const option of await knobOptions.all()) {
                        await expect(option).toHaveAttribute(
                            'data-option-key',
                            new RegExp(`/commands/${commandIndex}/`, 'u')
                        );
                    }
                }
                await knobSearch.fill('');
                await knobSearch.press('Home');
                await expect(knobPopup.locator('[data-searchable-listbox-range]'))
                    .toHaveText('Showing 1–100 of 24,002 options.');
                await knobSearch.press('End');
                await expect(knobPopup.locator('[data-searchable-listbox-range]'))
                    .toHaveText('Showing 24,001–24,002 of 24,002 options.');
                await expect(knobOptions).toHaveCount(2);
                await expect(knobSearch).toHaveAttribute(
                    'aria-activedescendant',
                    /tune-knob-option-24001/u
                );
                expect(fixture.mutationRequestCount()).toBe(0);
                expect(
                    await page.evaluate(() =>
                        document.documentElement.scrollWidth -
                        document.documentElement.clientWidth
                    )
                ).toBe(0);
                expect(
                    await reducedMotionGeometry(
                        tuneListboxTrigger(candidate, 'Exact knob path')
                    )
                ).toEqual({
                    minHeight: true,
                    minWidth: true,
                    reducedMotion: true
                });
                await page.setViewportSize({ width: 430, height: 932 });
                expect(
                    await page.evaluate(() =>
                        document.documentElement.scrollWidth -
                        document.documentElement.clientWidth
                    )
                ).toBe(0);
            }
            finally {
                await context.close();
            }
        }
    );
}

async function tapListbox(
    owner: Page | Locator,
    label: string
): Promise<Locator> {
    await tuneListboxTrigger(owner, label).tap();
    const search = owner.getByRole('combobox', { name: `Search ${label}` });
    const popup = search.locator(
        'xpath=ancestor::*[@data-searchable-listbox-popup][1]'
    );
    await expect(popup).toBeVisible();
    return popup;
}

async function installHeartbeat(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const state = { ticks: 0 };
        Object.defineProperty(window, '__rallarTuneHeartbeat', {
            configurable: false,
            value: state
        });
        window.setInterval(() => {
            state.ticks += 1;
        }, 4);
    });
}

function heartbeat(page: Page): Promise<number> {
    return page.evaluate(() =>
        (
            window as unknown as { __rallarTuneHeartbeat: { ticks: number; }; }
        ).__rallarTuneHeartbeat.ticks
    );
}

async function numericAttribute(locator: Locator, name: string): Promise<number> {
    const value = await locator.getAttribute(name);
    if (value === null || !/^\d+$/u.test(value)) {
        throw new Error(`Expected numeric ${name}, received ${String(value)}.`);
    }
    return Number(value);
}

function reducedMotionGeometry(locator: Locator) {
    return locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
            minHeight: box.height >= 44,
            minWidth: box.width >= 44,
            reducedMotion: style.animationDuration === '0s' &&
                style.transitionDuration === '0s'
        };
    });
}
