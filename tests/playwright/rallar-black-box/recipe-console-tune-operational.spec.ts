import { expect, test, type Page } from '@playwright/test';
import { chooseAnalyzeFiles } from './recipe-console-analyze-helpers.ts';
import { createTuneArtifactUpload } from './recipe-console-tune-artifacts.ts';
import {
    installRecipeConsoleTuneFixture,
    type RecipeConsoleTuneFixture,
    type RecipeConsoleTuneFixtureOptions,
} from './recipe-console-tune-fixture.ts';
import {
    TUNE_ANALYZE_ROUTE,
    TUNE_COMPARE_ROUTE,
    TUNE_LEFT_RUN_ID,
    TUNE_RIGHT_CONTROL_RUN_ID,
    TUNE_RIGHT_RUN_ID,
    TUNE_SLOW_AGENT_ID,
} from './recipe-console-tune-run-data.ts';

const SPA_ORIGIN = 'http://127.0.0.1:5176';

type OperationalCase = Readonly<{
    name: string;
    options?: RecipeConsoleTuneFixtureOptions;
    prepare(page: Page): Promise<void>;
    verify(page: Page, fixture: RecipeConsoleTuneFixture): Promise<void>;
}>;

const OPERATIONAL_CASES: readonly OperationalCase[] = [
    {
        name: 'partial control',
        options: { initialControlState: 'partial' },
        prepare: page => page.goto(absolute(TUNE_COMPARE_ROUTE)).then(() => undefined),
        verify: async page => {
            await expect(page.getByRole('status').filter({
                hasText: 'Partial · reachable',
            })).toBeVisible();
            const tune = page.locator('[data-tune-workspace]');
            await expect(tune).toHaveAttribute('data-source-kind', 'none');
            await expect(tune).toHaveAttribute('data-source-detail', 'unavailable');
            await expect(tune.locator('[data-tune-source]'))
                .toContainText('Control evidence is partial and bounded.');
            await expect(tune.locator('[data-tune-candidate]'))
                .toContainText('A paired distributed and control run is required.');
            await expect(tune.getByRole('button', { name: 'Preview candidate' }))
                .toHaveCount(0);
        },
    },
    {
        name: 'retained mismatch fallback',
        prepare: async page => {
            await page.goto(absolute(TUNE_ANALYZE_ROUTE));
            await chooseAnalyzeFiles(page, [createTuneArtifactUpload()]);
            await expect(page.locator('[data-artifact-status]'))
                .toHaveText('Artifact ready');
            await expect.poll(() => new URL(page.url()).searchParams.get(
                'distributedRunId',
            )).toBe(TUNE_RIGHT_RUN_ID);
            await page.getByRole('button', { name: 'Tune', exact: true }).click();
            await page.getByLabel('Candidate run').selectOption(TUNE_LEFT_RUN_ID);
        },
        verify: async page => {
            const tune = page.locator('[data-tune-workspace]');
            await expect(tune).toHaveAttribute('data-source-kind', 'control');
            await expect(tune).toHaveAttribute('data-source-detail', 'bounded');
            await expect(tune.locator('[data-tune-source]')).toContainText(
                'Loaded artifact tune-distributed-candidate does not match selected distributed run tune-distributed-baseline; previous analysis is retained.',
            );
            await expect(tune.locator('[data-tune-command-timing]'))
                .toContainText('P95 600 ms');
            await expect(tune.locator('[data-tune-command-timing]'))
                .not.toContainText('P95 1,200 ms');
        },
    },
    {
        name: 'reference-only recipe',
        options: { rightRecipe: 'reference-only' },
        prepare: page => page.goto(absolute(TUNE_COMPARE_ROUTE)).then(() => undefined),
        verify: async page => {
            const tune = page.locator('[data-tune-workspace]');
            await expect(tune).toHaveAttribute('data-source-kind', 'control');
            await expect(tune.locator('[data-tune-source]')).toContainText(
                'A selected recipe is reference-only and has no authoritative inline knobs.',
            );
            const candidate = tune.locator('[data-tune-candidate]');
            expect(await candidate.getByLabel('Exact knob path').locator('option')
                .evaluateAll(options => options.map(option =>
                    (option as HTMLOptionElement).value
                ))).toEqual(['/ackTimeoutMs', '/barrier/timeoutMs']);
            await expect(candidate.getByRole('button', {
                name: 'Preview candidate',
            })).toBeEnabled();
        },
    },
    {
        name: 'unsupported retained artifact',
        prepare: async page => {
            await page.goto(absolute(TUNE_ANALYZE_ROUTE));
            await chooseAnalyzeFiles(page, [createTuneArtifactUpload(99)]);
            await page.getByRole('button', { name: 'Tune', exact: true }).click();
        },
        verify: async page => {
            const tune = page.locator('[data-tune-workspace]');
            await expect(tune).toHaveAttribute('data-source-kind', 'artifact');
            await expect(tune).toHaveAttribute('data-source-detail', 'inspectable');
            await expect(tune.locator('[data-tune-source]'))
                .toContainText('Artifact schema version 99 is not supported.');
            const candidate = tune.locator('[data-tune-candidate]');
            await expect(candidate)
                .toContainText('Artifact schema version 99 is not supported.');
            await expect(candidate.getByRole('button', {
                name: 'Preview candidate',
            })).toBeDisabled();
        },
    },
];

test('renders table-driven Tune operational authority states', async ({ browser }) => {
    for (const scenario of OPERATIONAL_CASES) {
        const context = await browser.newContext({ baseURL: SPA_ORIGIN });
        const page = await context.newPage();
        try {
            const fixture = await installRecipeConsoleTuneFixture(
                context,
                scenario.options,
            );
            await test.step(scenario.name, async () => {
                await scenario.prepare(page);
                await scenario.verify(page, fixture);
                expect(fixture.artifactRequestCount()).toBe(0);
                expect(fixture.mutationRequestCount()).toBe(0);
            });
        } finally {
            await context.close();
        }
    }
});

test('keeps real Tune desktop geometry contained through inspection', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installRecipeConsoleTuneFixture(context);
    await page.goto(TUNE_COMPARE_ROUTE);

    const shell = page.locator('[data-recipe-console-shell]');
    await expect(shell).toHaveAttribute('data-navigation', 'rail');
    await expect(shell).toHaveAttribute('data-inspector-mode', 'rail');
    const command = page.locator('[data-tune-command-timing]');
    const stream = page.locator('[data-tune-stream-health]');
    const work = page.locator('[data-work-surface]');
    const commandBounds = await command.boundingBox();
    const streamBounds = await stream.boundingBox();
    const workBounds = await work.boundingBox();
    expect(commandBounds).not.toBeNull();
    expect(streamBounds).not.toBeNull();
    expect(workBounds).not.toBeNull();
    expect(Math.abs((commandBounds?.y ?? 0) - (streamBounds?.y ?? 0)))
        .toBeLessThanOrEqual(1);
    expect((commandBounds?.x ?? 0) + (commandBounds?.width ?? 0))
        .toBeLessThanOrEqual(streamBounds?.x ?? 0);
    expect((streamBounds?.x ?? 0) + (streamBounds?.width ?? 0))
        .toBeLessThanOrEqual((workBounds?.x ?? 0) + (workBounds?.width ?? 0) + 1);
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
    expect(await documentOverflow(page)).toEqual({ x: 0, y: 0 });

    const trigger = command.locator('[data-tune-slow-agents="command"] button')
        .filter({ hasText: TUNE_SLOW_AGENT_ID });
    await trigger.focus();
    await trigger.press('Enter');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector.locator('[data-tune-inspector]'))
        .toContainText(TUNE_SLOW_AGENT_ID);
    expect((await inspector.boundingBox())?.width).toBe(352);
    const handoff = new URL(
        await inspector.getByRole('link', {
            name: 'Open this run in legacy Runs',
        }).getAttribute('href') ?? '',
        page.url(),
    );
    expect(handoff.searchParams.get('controlRunId')).toBe(TUNE_RIGHT_CONTROL_RUN_ID);
    expect(handoff.searchParams.get('distributedRunId')).toBe(TUNE_RIGHT_RUN_ID);
    const legacyLink = inspector.getByRole('link', {
        name: 'Open this run in legacy Runs',
    });
    await legacyLink.focus();
    await expect(legacyLink).toBeFocused();
    await expect.poll(() => documentOverflow(page)).toEqual({ x: 0, y: 0 });
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

function absolute(route: string): string {
    return new URL(route, SPA_ORIGIN).toString();
}

async function documentOverflow(page: Page): Promise<{ x: number; y: number }> {
    return page.evaluate(() => ({
        x: document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight -
            document.documentElement.clientHeight,
    }));
}
