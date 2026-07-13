import { expect, test, type Locator, type Page } from '@playwright/test';
import { createRecipeConsoleScaleFixture } from
    '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';
import {
    createAnalyzeLooseFiles,
    type AnalyzeUploadFile,
} from './recipe-console-analyze-artifacts.ts';
import { installRecipeConsoleAnalyzeFixture } from
    './recipe-console-analyze-fixture.ts';
import {
    analyzeLegacyRunsLink,
    analyzeSearch,
    analyzeSource,
    chooseAnalyzeFiles,
} from './recipe-console-analyze-helpers.ts';
import {
    ANALYZE_AGENT_ID,
    ANALYZE_COMMAND_ID,
    ANALYZE_RECIPE_ID,
    ANALYZE_ROUTE,
} from './recipe-console-analyze-run-data.ts';

const PRODUCTION_BASE_URL = 'http://127.0.0.1:4176';

test('keeps synthetic large event and result lists bounded responsive and searchable',
    async ({ context, page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: 932, height: 430 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await installRecipeConsoleAnalyzeFixture(context);
        await page.goto(new URL(ANALYZE_ROUTE, PRODUCTION_BASE_URL).href);
        await page.evaluate(() => { document.documentElement.dir = 'rtl'; });

        const fixture = createRecipeConsoleScaleFixture();
        await chooseAnalyzeFiles(page, scaleUploads(fixture.files));
        await expect(analyzeSource(page).locator('[data-artifact-status]'))
            .toHaveText('Artifact ready', { timeout: 60_000 });

        const workspace = page.locator('[data-analyze-workspace]');
        const search = analyzeSearch(page);
        const results = search.locator('ol#analyze-evidence-results > li');
        const windowControls = search.getByRole('group', {
            name: 'Evidence results window',
        });
        const status = windowControls.getByRole('status');
        const previous = windowControls.getByRole('button', { name: 'Previous' });
        const next = windowControls.getByRole('button', { name: 'Next' });

        await expect(status).toHaveText(
            'Showing 1–64 of 15,003 retained matches.',
        );
        await expect(results).toHaveCount(64);
        await expect(workspace).toHaveAttribute('data-analyze-mounted-count', '64');
        await expect(previous).toBeDisabled();
        await expect(next).toBeEnabled();
        await expect(search.locator('[data-analyze-producer-compaction]'))
            .toContainText('Unavailable for distributed artifacts');
        await expect(search.locator('[data-analyze-index-omission]'))
            .toContainText('0 source entries omitted before search and not searchable');
        await expect(search.locator('[data-analyze-matching-truth]'))
            .toContainText('15,003 retained matches');
        await expect(search.locator('[data-analyze-render-window-truth]'))
            .toContainText('14,939 outside this render window and browseable');
        expect(await controlGeometry(next)).toMatchObject({
            minHeight: true,
            minWidth: true,
            reducedMotion: true,
        });
        expect(await page.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth
        )).toBe(0);

        await next.focus();
        await page.keyboard.press('Enter');
        await expect(status).toHaveText(
            'Showing 65–128 of 15,003 retained matches.',
        );
        await expect(next).toBeFocused();
        await expect(results).toHaveCount(64);

        await results.first().getByRole('button').focus();
        await next.evaluate((button: HTMLButtonElement) => button.click());
        await expect(status).toHaveText(
            'Showing 129–192 of 15,003 retained matches.',
        );
        await expect(status).toBeFocused();
        await expect(results).toHaveCount(64);

        await previous.focus();
        await page.keyboard.press('Enter');
        await expect(status).toHaveText(
            'Showing 65–128 of 15,003 retained matches.',
        );
        await page.keyboard.press('Enter');
        await expect(status).toHaveText(
            'Showing 1–64 of 15,003 retained matches.',
        );
        await expect(previous).toBeDisabled();

        const evidenceIds: string[] = [];
        const totalEvidence = 15_003;
        for (let rangeStart = 1; rangeStart <= totalEvidence; rangeStart += 64) {
            const rangeEnd = Math.min(rangeStart + 63, totalEvidence);
            const rangeSize = rangeEnd - rangeStart + 1;
            await expect(status).toHaveText(
                `Showing ${rangeStart.toLocaleString('en-US')}–${rangeEnd.toLocaleString('en-US')} of 15,003 retained matches.`,
            );
            await expect(results).toHaveCount(rangeSize);
            await expect(workspace).toHaveAttribute(
                'data-analyze-mounted-count',
                String(rangeSize),
            );
            const windowIds = await results.locator('[data-evidence-result]')
                .evaluateAll(elements => elements.map(element =>
                    element.getAttribute('data-evidence-id') ?? ''
                ));
            expect(windowIds).toHaveLength(rangeSize);
            expect(windowIds.every(Boolean)).toBe(true);
            evidenceIds.push(...windowIds);
            if (rangeEnd < totalEvidence) {
                await expect(next).toBeEnabled();
                await next.click();
            }
        }
        await expect(status).toHaveText(
            'Showing 14,977–15,003 of 15,003 retained matches.',
        );
        await expect(next).toBeDisabled();
        expect(evidenceIds).toHaveLength(totalEvidence);
        expect(new Set(evidenceIds).size).toBe(totalEvidence);

        await previous.click();
        await expect(status).toHaveText(
            'Showing 14,913–14,976 of 15,003 retained matches.',
        );
        await expect(results).toHaveCount(64);

        for (const [needle, kind, sourceFile, invalidatesRow] of [
            [fixture.needles.events.last, 'event', 'events.jsonl', true],
            [fixture.needles.results.last, 'result', 'results.jsonl', false],
        ] as const) {
            await search.getByLabel('Search evidence').fill(needle);
            await search.getByRole('button', { name: 'Apply search' }).click();
            await expect(search.getByLabel('Search evidence')).toHaveValue(needle);
            await expect(results).toHaveCount(1);
            await expect(results.first().getByRole('button'))
                .toHaveAttribute('data-evidence-kind', kind);
            await expect(results.first().getByRole('button'))
                .toHaveAttribute('data-evidence-source', sourceFile);
            await expect(status).toHaveText(
                'Showing 1–1 of 1 retained matches.',
            );
            await expect(workspace).toHaveAttribute('data-analyze-mounted-count', '1');
            const trigger = results.first().getByRole('button');
            const triggerHandle = await trigger.elementHandle();
            await trigger.click();
            const inspector = page.getByRole('dialog', { name: 'Inspector' });
            await expect(inspector.locator('[data-analyze-inspector]'))
                .toHaveAttribute('data-selection-kind', kind);
            await expect(inspector).toContainText(sourceFile);
            if (invalidatesRow) {
                await expect.poll(() => urlEvidenceSelectors(page)).toEqual({
                    agentId: 'scale-agent-001',
                    commandId: 'scale-command-002999',
                    recipeId: 'recipe-console-scale-recipe',
                });
                await expect.poll(() => triggerHandle?.evaluate(
                    element => element.isConnected,
                )).toBe(false);
            }
            await inspector.getByRole('button', { name: 'Close inspector' }).click();
            if (invalidatesRow) await expect(status).toBeFocused();
            else await expect(trigger).toBeFocused();
        }

        await expect(analyzeLegacyRunsLink(page)).toBeVisible();
        await expect(analyzeSource(page).getByRole('link', {
            name: 'Open generic export in legacy Shared Test',
        })).toBeVisible();
    });

test('keeps multibyte bidi evidence identifiers exact and isolated in RTL',
    async ({ context, page }) => {
        await installRecipeConsoleAnalyzeFixture(context);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(ANALYZE_ROUTE);
        await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
        const identifiers = {
            agent: 'agent-‮gnul-界',
            recipe: 'מתכון-界',
            command: 'command-⁦exact⁩-🧪',
        };
        await chooseAnalyzeFiles(page, bidiUploads(identifiers));
        await expect(analyzeSource(page).locator('[data-artifact-status]'))
            .toHaveText('Artifact ready');

        const search = analyzeSearch(page);
        const result = search.locator('[data-evidence-result]').first();
        const originalResult = await result.elementHandle();
        const evidenceId = await result.getAttribute('data-evidence-id');
        for (const value of Object.values(identifiers)) {
            const exact = result.locator('bdi[data-exact-identifier]', {
                hasText: value,
            }).first();
            await expect(exact).toHaveText(value);
            await expect(exact).toHaveAttribute('dir', 'ltr');
            expect(await exact.evaluate(node => ({
                direction: getComputedStyle(node).direction,
                unicodeBidi: getComputedStyle(node).unicodeBidi,
            }))).toEqual({
                direction: 'ltr',
                unicodeBidi: 'isolate-override',
            });
        }
        await result.click();
        await expect.poll(() => urlEvidenceSelectors(page)).toEqual({
            agentId: identifiers.agent,
            commandId: identifiers.command,
            recipeId: identifiers.recipe,
        });
        await expect.poll(() => originalResult?.evaluate(
            element => element.isConnected,
        )).toBe(false);
        const inspector = page.getByRole('dialog', { name: 'Inspector' });
        await expect(inspector).toBeVisible();
        for (const value of [evidenceId, ...Object.values(identifiers)]) {
            expect(value).not.toBeNull();
            const exact = inspector.locator('bdi[data-exact-identifier]', {
                hasText: value!,
            }).first();
            await expect(exact).toHaveText(value!);
            await expect(exact).toHaveAttribute('dir', 'ltr');
            expect(await exact.evaluate(node => ({
                direction: getComputedStyle(node).direction,
                unicodeBidi: getComputedStyle(node).unicodeBidi,
            }))).toEqual({
                direction: 'ltr',
                unicodeBidi: 'isolate-override',
            });
        }
        await inspector.getByRole('button', { name: 'Close inspector' }).click();
        await expect(search.getByRole('group', {
            name: 'Evidence results window',
        }).getByRole('status')).toBeFocused();
    });

async function controlGeometry(control: Locator) {
    return control.evaluate(element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
            minHeight: box.height >= 44,
            minWidth: box.width >= 44,
            reducedMotion:
                style.animationDuration === '0s' &&
                style.transitionDuration === '0s',
        };
    });
}

function urlEvidenceSelectors(page: Page) {
    const params = new URL(page.url()).searchParams;
    return Object.fromEntries(
        ['agentId', 'recipeId', 'commandId'].flatMap(key => {
            const value = params.get(key);
            return value === null ? [] : [[key, value]];
        }),
    );
}

function scaleUploads(
    files: Readonly<Record<string, string>>,
): readonly AnalyzeUploadFile[] {
    return Object.entries(files).map(([name, contents]) => ({
        name,
        mimeType: name.endsWith('.jsonl')
            ? 'application/x-ndjson'
            : 'application/json',
        buffer: Buffer.from(contents),
    }));
}

function bidiUploads(identifiers: Readonly<{
    agent: string;
    recipe: string;
    command: string;
}>): readonly AnalyzeUploadFile[] {
    return createAnalyzeLooseFiles().map(file => ({
        ...file,
        buffer: Buffer.from(file.buffer.toString('utf8')
            .replaceAll(ANALYZE_AGENT_ID, identifiers.agent)
            .replaceAll(ANALYZE_RECIPE_ID, identifiers.recipe)
            .replaceAll(ANALYZE_COMMAND_ID, identifiers.command)),
    }));
}
