import { expect, test } from '@playwright/test';
import { chooseAnalyzeFiles } from './recipe-console-analyze-helpers.ts';
import { createTuneArtifactUpload } from './recipe-console-tune-artifacts.ts';
import { installRecipeConsoleTuneFixture } from './recipe-console-tune-fixture.ts';
import {
    chooseTuneListboxOptionWithKeyboard,
    tuneListboxTrigger,
    visibleTuneListboxValues,
} from './recipe-console-tune-listbox-helpers.ts';
import {
    TUNE_ANALYZE_ROUTE,
    TUNE_COMPARE_ROUTE,
    TUNE_LEFT_RUN_ID,
    TUNE_RIGHT_CONTROL_RUN_ID,
    TUNE_RIGHT_RUN_ID,
    TUNE_ROUTE,
    TUNE_SLOW_AGENT_ID,
} from './recipe-console-tune-run-data.ts';

const TUNE_EDITABLE_KNOB_PATHS = [
    '/ackTimeoutMs',
    '/barrier/timeoutMs',
    '/recipes/0/recipe/commands/0/durationMs',
    '/recipes/0/recipe/commands/0/intervalMs',
    '/recipes/0/recipe/commands/0/rateHz',
    '/recipes/0/recipe/commands/0/maxInFlight',
    '/recipes/0/recipe/commands/0/thresholds/minSendSuccessRatio',
    '/recipes/0/recipe/commands/0/thresholds/maxDroppedFrames',
    '/recipes/0/recipe/commands/0/thresholds/maxBackpressureCount',
    '/recipes/0/recipe/commands/0/thresholds/maxP95SendDurationMs',
    '/recipes/0/recipe/commands/0/thresholds/maxP99SendDurationMs',
    '/recipes/0/recipe/commands/0/thresholds/maxAverageStartDriftMs',
    '/recipes/0/recipe/commands/0/thresholds/maxStartDriftMs',
    '/recipes/0/recipe/commands/0/thresholds/maxJitterMs',
] as const;

test('shows command percentiles cadence drift drops and backpressure for an RTC stream', async ({ context, page }) => {
    const fixture = await installRecipeConsoleTuneFixture(context);
    await page.goto(TUNE_ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, [createTuneArtifactUpload()]);
    await expect(page.locator('[data-analyze-section="source"] [data-artifact-status]'))
        .toHaveText('Artifact ready');
    await page.getByRole('button', { name: 'Tune', exact: true }).click();
    await expect(page).toHaveURL(/view=tune/);

    const tune = page.locator('[data-tune-workspace]');
    await expect(tune, 'RED: Tune must replace the seed with retained artifact truth')
        .toBeVisible({ timeout: 2_000 });
    const commandTiming = tune.locator('[data-tune-command-timing]');
    for (const evidence of [
        'Min 400 ms', 'P50 400 ms', 'P95 1,200 ms',
        'P99 1,200 ms', 'Max 1,200 ms',
        'Average 800 ms · Spread 3× · 1 outliers',
        'Command average 1,200 ms · max 1,200 ms',
        'Command average 400 ms · max 400 ms',
    ]) {
        await expect(commandTiming).toContainText(evidence);
    }
    const stream = tune.locator('[data-tune-stream-health]');
    for (const evidence of [
        '30 planned', '28 scheduled', '23 attempted', '22 completed',
        '1 failed', '5 dropped', '2 in-flight drops',
        '30 Hz requested', '28 Hz scheduled', '22 Hz completed',
        '28 ms max drift', '6 late', '4 backpressure',
        'P50 23 ms', 'P95 68 ms', 'P99 92 ms', 'Max 92 ms',
        'Stream P95 68 ms · P99 92 ms · max 92 ms',
        TUNE_SLOW_AGENT_ID,
    ]) {
        await expect(stream).toContainText(evidence);
    }
    await expect(tune.locator('[data-tune-hints]')).toContainText('Lower cadence');
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('compares two runs across recipe participant failure timing and receive deltas', async ({ context, page }) => {
    const fixture = await installRecipeConsoleTuneFixture(context);
    await page.goto(TUNE_COMPARE_ROUTE);
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'tune');

    const comparison = page.locator('[data-tune-comparison]');
    await expect(comparison, 'RED: Tune must render explicit URL-backed comparison')
        .toBeVisible({ timeout: 2_000 });
    await expect(comparison).toContainText(TUNE_LEFT_RUN_ID);
    await expect(comparison).toContainText(TUNE_RIGHT_RUN_ID);
    await expect(comparison.locator('[data-compare-category="recipe"]'))
        .toContainText(
            'tune-rtc-stream: baseline → candidate · Baseline only None · Candidate only None',
        );
    await expect(comparison.locator('[data-compare-category="participant"]'))
        .toContainText(
            'Baseline only tune-agent-baseline · Candidate only tune-agent-slow · Shared tune-agent-shared',
        );
    await expect(comparison.locator('[data-compare-category="failure"]'))
        .toContainText(
            '0 → 1 · Removed None · Added recipe:tune-rtc-stream:tune-agent-slow:failed:RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED:RTC stream exceeded pacing and backlog thresholds.',
        );
    await expect(comparison.locator('[data-compare-category="timing"]'))
        .toContainText('Duration -1,200 ms · Start 0 ms · Complete -1,200 ms');
    await expect(comparison.locator('[data-compare-category="received-message"]'))
        .toContainText('1 → 2 · +1');
    await expect(comparison.locator('[data-compare-category="performance"]'))
        .toContainText('stream-send-duration · p95 Unavailable · unavailable');
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('compares two runs and emits explicit candidate timing changes without mutation', async ({ context, page }) => {
    const fixture = await installRecipeConsoleTuneFixture(context);
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: 'http://127.0.0.1:5176' },
    );
    await page.goto(TUNE_COMPARE_ROUTE);
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'tune');

    const candidate = page.locator('[data-tune-candidate]');
    await expect(candidate, 'RED: Tune must expose deliberate clone-only candidate edits')
        .toBeVisible({ timeout: 2_000 });
    await expect(candidate).toContainText('/recipes/0/recipe/commands/0/rateHz');
    await expect(candidate).toContainText('Current 30');
    expect(await visibleTuneListboxValues(
        candidate,
        'Exact knob path',
    )).toEqual(TUNE_EDITABLE_KNOB_PATHS);
    await candidate.getByLabel('Candidate value').fill('24');
    await candidate.getByRole('button', { name: 'Preview candidate' }).click();
    await expect(candidate.locator('[data-candidate-patch]'))
        .toContainText('"value": 24');
    await expect(candidate).toContainText('Source remains 30');
    await candidate.getByText('Readable diff', { exact: true }).click();
    await expect(candidate.locator('details pre')).toBeVisible();
    await expect(candidate.locator('details pre')).toHaveText(
        '/recipes/0/recipe/commands/0/rateHz: 30 -> 24',
    );
    await candidate.getByRole('button', { name: 'Copy JSON patch' }).click();
    await expect(candidate.getByRole('status')).toContainText('Candidate patch copied');
    const clipboardPatch = JSON.parse(
        await page.evaluate(() => navigator.clipboard.readText()),
    );
    expect(clipboardPatch).toEqual([{
        op: 'replace',
        path: '/recipes/0/recipe/commands/0/rateHz',
        value: 24,
    }]);
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('renders explicit offline and invalid-focus states without candidate authority', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context, {
        initialReachability: 'offline',
    });
    await page.goto(`${TUNE_ROUTE}` +
        '&compareLeft=missing-baseline&compareRight=missing-candidate');

    await expect(page.getByRole('status').filter({ hasText: 'Offline · unreachable' }))
        .toBeVisible();
    const tune = page.locator('[data-tune-workspace]');
    await expect(tune).toHaveAttribute('data-source-kind', 'none');
    await expect(tune).toHaveAttribute('data-source-detail', 'unavailable');
    await expect(tune.locator('[data-tune-source]'))
        .toContainText('Run missing-candidate is unavailable.');
    const comparison = tune.locator('[data-tune-comparison]');
    await expect(comparison).toContainText('invalid');
    await expect(comparison).toContainText(
        'compareLeft is not available in retained artifact or control evidence.',
    );
    await expect(comparison).toContainText(
        'compareRight is not available in retained artifact or control evidence.',
    );
    await expect(tune.locator('[data-tune-command-timing]'))
        .toContainText('Command timing is unavailable for this source.');
    await expect(tune.locator('[data-tune-stream-health]'))
        .toContainText('RTC frame disposition, cadence, drift, and backpressure are unavailable.');
    const candidate = tune.locator('[data-tune-candidate]');
    await expect(candidate).toContainText(
        'A paired distributed and control run is required.',
    );
    await expect(candidate).toContainText(
        'Performance evidence is required before creating a candidate.',
    );
    await expect(candidate).toContainText(
        'Current live or partial control truth is required.',
    );
    await expect(candidate.getByRole('button', { name: 'Preview candidate' }))
        .toHaveCount(0);
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('blocks candidate output when last-known control evidence becomes stale', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context);
    await page.goto(TUNE_COMPARE_ROUTE);
    const tune = page.locator('[data-tune-workspace]');
    await expect(tune).toHaveAttribute('data-source-kind', 'control');
    await expect(tune).toHaveAttribute('data-source-detail', 'bounded');
    const preview = tune.getByRole('button', { name: 'Preview candidate' });
    await expect(preview).toBeEnabled();

    fixture.setReachability('offline');
    await page.getByRole('button', { name: 'Refresh control data' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Stale · unreachable' }))
        .toBeVisible();
    await expect(tune.locator('[data-tune-source]'))
        .toContainText('Control evidence is last-known and stale.');
    await expect(tune.locator('[data-tune-candidate]'))
        .toContainText('Current live or partial control truth is required.');
    await expect(preview).toBeDisabled();
    await expect(tune.locator('[data-tune-command-timing]'))
        .toContainText('P95 1,200 ms');
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('keeps incompatible comparison evidence visible and advisory', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context, {
        compatibility: 'advisory',
    });
    await page.goto(TUNE_COMPARE_ROUTE);

    const comparison = page.locator('[data-tune-comparison]');
    await expect(comparison).toContainText('ready');
    await expect(comparison).toContainText(
        'The selected runs target different application/workspace/group scopes.',
    );
    await expect(comparison).toContainText(
        'The selected runs have no shared recipe identity.',
    );
    await expect(comparison.getByRole('status')).toHaveText(
        'Comparison state: ready. ' +
        'The selected runs target different application/workspace/group scopes. ' +
        'The selected runs have no shared recipe identity.',
    );
    for (const category of [
        'recipe',
        'participant',
        'failure',
        'timing',
        'received-message',
        'performance',
    ]) {
        await expect(comparison.locator(`[data-compare-category="${category}"]`))
            .toBeVisible();
    }
    await expect(comparison.locator('[data-compare-category="performance"]'))
        .toContainText('unavailable');
    await expect(page.getByRole('button', { name: 'Preview candidate' }))
        .toBeEnabled();
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('keeps a shadowed rate knob visible and inspectable but not editable', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context, {
        shadowedRateHz: true,
    });
    await page.goto(TUNE_COMPARE_ROUTE);

    const candidate = page.locator('[data-tune-candidate]');
    const editable = await visibleTuneListboxValues(candidate, 'Exact knob path');
    expect(editable).toContain('/recipes/0/recipe/commands/0/intervalMs');
    expect(editable).not.toContain('/recipes/0/recipe/commands/0/rateHz');
    const blocked = candidate.locator('[data-tune-blocked-knob]')
        .filter({ hasText: '/recipes/0/recipe/commands/0/rateHz' });
    await expect(blocked).toContainText('Current 30');
    await expect(blocked).toContainText(
        'intervalMs takes precedence over rateHz for RTC stream scheduling.',
    );
    const inspect = blocked.getByRole('button', { name: 'Inspect knob' });
    await inspect.focus();
    await inspect.press('Enter');
    const inspector = page.locator('[data-tune-inspector]');
    await expect(inspector).toContainText('/recipes/0/recipe/commands/0/rateHz');
    await expect(inspector).toContainText('Current30');
    await expect(inspector).toContainText('Availabilityblocked');
    await expect(inspector).toContainText('EffectiveNo');
    await expect(inspector).toContainText(
        'intervalMs takes precedence over rateHz for RTC stream scheduling.',
    );
    await page.keyboard.press('Escape');
    await expect(inspect).toBeFocused();
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});

test('shows uncommitted candidate focus and commits comparison in one keyboard choice', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleTuneFixture(context);
    await page.goto(`${TUNE_ROUTE}` +
        `&controlRunId=${TUNE_RIGHT_CONTROL_RUN_ID}` +
        `&distributedRunId=${TUNE_RIGHT_RUN_ID}` +
        `&compareLeft=${TUNE_LEFT_RUN_ID}`);

    const candidate = tuneListboxTrigger(page, 'Candidate run');
    await expect(candidate).toContainText('Select candidate');
    const comparison = page.locator('[data-tune-comparison]');
    await expect(comparison).toContainText('incomplete');
    await expect(comparison).toContainText('compareRight must be selected explicitly.');
    await expect(page.locator('[data-tune-workspace]'))
        .toHaveAttribute('data-source-kind', 'control');

    await chooseTuneListboxOptionWithKeyboard(
        page,
        'Candidate run',
        TUNE_RIGHT_RUN_ID,
    );
    await expect(page).toHaveURL(new RegExp(`compareRight=${TUNE_RIGHT_RUN_ID}`));
    await expect(candidate).toContainText(TUNE_RIGHT_RUN_ID);
    await expect(comparison).toContainText('ready');
    await expect(comparison.locator('[data-compare-category="recipe"]'))
        .toBeVisible();
    expect(fixture.artifactRequestCount()).toBe(0);
    expect(fixture.mutationRequestCount()).toBe(0);
});
