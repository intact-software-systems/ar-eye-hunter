import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
    createAnalyzeLooseFiles,
    createAnalyzeTimeoutEnvelopeFile,
    createAnalyzeTimeoutLooseFiles
} from './recipe-console-analyze-artifacts.ts';
import { installRecipeConsoleAnalyzeFixture } from './recipe-console-analyze-fixture.ts';
import {
    ANALYZE_SECTION_ORDER,
    analyzeSearch,
    analyzeSource,
    analyzeVerdict,
    chooseAnalyzeFiles
} from './recipe-console-analyze-helpers.ts';
import {
    ANALYZE_AGENT_ID,
    ANALYZE_COMMAND_ID,
    ANALYZE_CONTROL_ROUTE,
    ANALYZE_DIAGNOSTIC_MESSAGE,
    ANALYZE_DISTRIBUTED_RUN_ID,
    ANALYZE_FAILURE_MESSAGE,
    ANALYZE_GENERATED_AT_EPOCH_MS,
    ANALYZE_RECIPE_ID,
    ANALYZE_RESULT_FAILURE_CODE,
    ANALYZE_RESULT_FAILURE_MESSAGE,
    ANALYZE_RESULT_FAILURE_NAME,
    ANALYZE_RESULT_FAILURE_STACK,
    ANALYZE_ROUTE
} from './recipe-console-analyze-run-data.ts';

test('imports a partial bundle offline and focuses the first actionable failure', async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, createAnalyzeLooseFiles());
    await expect(analyzeSource(page).locator('[data-artifact-status]'))
        .toHaveText('Artifact ready');
    await expect.poll(fixture.artifactRequestCount).toBe(0);

    const sections = page.locator('[data-analyze-section]');
    await expect(sections).toHaveCount(ANALYZE_SECTION_ORDER.length);
    expect(await sections.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-analyze-section'))))
        .toEqual(ANALYZE_SECTION_ORDER);

    const failure = analyzeVerdict(page);
    await expect(failure).toHaveAttribute('data-run-state', 'failed');
    await expect(failure).toHaveAttribute('data-artifact-support', 'supported');
    await expect(failure).toContainText('First actionable failure');
    await expect(failure).toContainText(ANALYZE_FAILURE_MESSAGE);
    await expect(failure).toContainText(ANALYZE_AGENT_ID);
    await expect(failure).toContainText(ANALYZE_COMMAND_ID);
    await expect(failure.getByText('Next action', { exact: true })).toBeVisible();
    await expect(failure.getByText('Verify', { exact: true }).locator('..'))
        .toContainText(
            'npm run test:e2e:rallar-black-box:full-stack:memory:live-rtc-3'
        );
    const quality = page.locator('[data-analyze-section="quality"]');
    await expect(quality.locator('[data-file-status="malformed"]', {
        hasText: 'events.jsonl'
    })).toBeVisible();
    await expect(quality.locator('[data-file-status="missing-optional"]', {
        hasText: 'report.json'
    })).toBeVisible();
    await expect(quality.locator('[data-file-status="ignored"]', {
        hasText: 'operator-notes.txt'
    })).toBeVisible();

    const performance = page.locator('[data-analyze-section="performance"]');
    await expect(performance).toContainText('1 agents · 0% pass');
    await expect(performance.getByText('P95 command', { exact: true }).locator('..'))
        .toContainText('1.20s');
    await expect(performance.getByText('Reconnects', { exact: true }).locator('..'))
        .toContainText('2');
    await expect(performance.getByText('Diagnostics', { exact: true }).locator('..'))
        .toContainText('2');

    const evidenceSearch = analyzeSearch(page);
    await expect(evidenceSearch.locator('[data-evidence-kind="diagnostic"]'))
        .toHaveCount(1);
    await evidenceSearch.getByLabel('Search evidence').fill('allocation missing');
    await evidenceSearch.getByLabel('Agent', { exact: true }).fill(ANALYZE_AGENT_ID);
    await evidenceSearch.getByLabel('Recipe', { exact: true }).fill(ANALYZE_RECIPE_ID);
    await evidenceSearch.getByLabel('Command', { exact: true }).fill(ANALYZE_COMMAND_ID);
    await evidenceSearch.getByRole('button', { name: 'Apply search' }).click();
    await evidenceSearch.getByLabel('Severity filter').selectOption('error');
    await evidenceSearch.getByLabel('Transport filter').selectOption('messages.rtc');
    const fromEpochMs = ANALYZE_GENERATED_AT_EPOCH_MS - 1_000;
    const toEpochMs = ANALYZE_GENERATED_AT_EPOCH_MS + 59_000;
    await evidenceSearch.getByLabel('From').fill(
        new Date(fromEpochMs).toISOString().slice(0, 16)
    );
    await evidenceSearch.getByLabel('To').fill(
        new Date(toEpochMs).toISOString().slice(0, 16)
    );

    const diagnostic = evidenceSearch.locator('[data-evidence-result]');
    await expect(diagnostic).toHaveCount(1);
    await expect(diagnostic).toHaveAttribute('data-evidence-kind', 'diagnostic');
    await expect(diagnostic).toContainText(ANALYZE_DIAGNOSTIC_MESSAGE);
    const filteredUrl = new URL(page.url());
    expect(filteredUrl.searchParams.get('historyQuery')).toBe('allocation missing');
    expect(filteredUrl.searchParams.get('agentId')).toBe(ANALYZE_AGENT_ID);
    expect(filteredUrl.searchParams.get('recipeId')).toBe(ANALYZE_RECIPE_ID);
    expect(filteredUrl.searchParams.get('commandId')).toBe(ANALYZE_COMMAND_ID);
    expect(filteredUrl.searchParams.get('diagnosticSeverity')).toBe('error');
    expect(filteredUrl.searchParams.get('transport')).toBe('messages.rtc');
    expect(filteredUrl.searchParams.get('from')).toBe(String(fromEpochMs));
    expect(filteredUrl.searchParams.get('to')).toBe(String(toEpochMs));

    await diagnostic.focus();
    await page.keyboard.press('Enter');
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector.locator('[data-analyze-inspector]'))
        .toHaveAttribute('data-selection-kind', 'diagnostic');
    await expect(inspector).toContainText(ANALYZE_DIAGNOSTIC_MESSAGE);
    await expect(inspector).toContainText('events.jsonl');
    const markdown = page.locator('[data-analyze-section="markdown"]');
    await markdown.getByText('Preview issue Markdown').click();
    await expect(markdown).toContainText(ANALYZE_FAILURE_MESSAGE);
    await expect(markdown).toContainText('Likely causal trail');
});

test('promotes a correlated timeout result from verdict through raw payload', async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, createAnalyzeTimeoutLooseFiles());

    const verdict = analyzeVerdict(page);
    const resultFingerprint = verdict.locator(
        '[data-analyze-failure-details="verdict"]'
    );
    await expect(resultFingerprint).toContainText(ANALYZE_RESULT_FAILURE_CODE);
    await expect(resultFingerprint).toContainText(ANALYZE_RESULT_FAILURE_NAME);
    await expect(resultFingerprint).toContainText(ANALYZE_RESULT_FAILURE_MESSAGE);
    await expect(resultFingerprint).toContainText('at _t');

    const failedResult = analyzeSearch(page).locator('[data-evidence-kind="result"]');
    await expect(failedResult).toContainText(ANALYZE_RESULT_FAILURE_CODE);
    await expect(failedResult).toContainText(ANALYZE_RESULT_FAILURE_NAME);
    await expect(failedResult).toContainText(ANALYZE_RESULT_FAILURE_MESSAGE);

    const inspectResult = verdict.getByRole('button', { name: 'Inspect result' });
    await inspectResult.click();
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector.locator('[data-analyze-inspector]'))
        .toHaveAttribute('data-selection-kind', 'result');
    await expect(inspector.locator('[data-analyze-failure-details="inspector"]'))
        .toContainText(ANALYZE_RESULT_FAILURE_STACK);
    const rawPayload = inspector.locator('details').filter({
        hasText: 'Raw payload JSON'
    });
    await expect(rawPayload).toHaveJSProperty('open', false);
    await rawPayload.locator('summary').click();
    await expect(rawPayload.locator('pre')).toContainText(ANALYZE_RESULT_FAILURE_NAME);
});

test('loads from Control, exports an envelope, reimports it, and clears memory on reload', async ({ context, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const fixture = await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_CONTROL_ROUTE);
    await expect.poll(fixture.runRequestCount).toBeGreaterThan(0);
    await expect.poll(fixture.distributedRunRequestCount).toBeGreaterThan(0);
    const controlSource = page.locator('[data-analyze-control-source]');
    await expect(controlSource.getByLabel('Analyze control run'))
        .toHaveValue('analyze-control-ci');
    await expect(controlSource.getByLabel('Analyze distributed run'))
        .toHaveValue(ANALYZE_DISTRIBUTED_RUN_ID);
    await controlSource.getByRole('button', { name: 'Load artifact' }).click();
    await expect.poll(fixture.artifactRequestCount).toBe(1);
    await expect(analyzeSource(page).locator('[data-artifact-status]'))
        .toHaveText('Artifact ready');

    const downloadPromise = page.waitForEvent('download');
    await controlSource.getByRole('button', { name: 'Export artifact' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
        `${ANALYZE_DISTRIBUTED_RUN_ID}-artifact.json`
    );
    const downloadPath = await download.path();
    if (!downloadPath) {
        throw new Error('Analyze artifact download path is unavailable.');
    }
    const downloaded = await readFile(downloadPath);
    expect(JSON.parse(downloaded.toString())).toMatchObject({
        artifactSchemaVersion: 2,
        distributedRunId: ANALYZE_DISTRIBUTED_RUN_ID,
        generatedAtEpochMs: ANALYZE_GENERATED_AT_EPOCH_MS
    });
    await controlSource.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('heading', { name: 'Import distributed-run evidence' }))
        .toBeVisible();
    await chooseAnalyzeFiles(page, [{
        name: download.suggestedFilename(),
        mimeType: 'application/json',
        buffer: downloaded
    }]);
    await expect(analyzeVerdict(page)).toContainText(ANALYZE_FAILURE_MESSAGE);
    expect(fixture.artifactRequestCount()).toBe(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Import distributed-run evidence' }))
        .toBeVisible();
    await expect(controlSource.getByRole('button', { name: 'Export artifact' }))
        .toBeDisabled();
});

test('opens and closes the Analyze inspector through a keyboard-only short-landscape path', async ({ context, page }) => {
    await page.setViewportSize({ width: 932, height: 430 });
    const fixture = await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, [createAnalyzeTimeoutEnvelopeFile()]);
    const trigger = analyzeVerdict(page)
        .getByRole('button', { name: 'Inspect evidence' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    await expect(inspector.getByRole('button', { name: 'Close inspector' }))
        .toBeFocused();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(trigger).toBeFocused();

    const resultTrigger = analyzeVerdict(page)
        .getByRole('button', { name: 'Inspect result' });
    await resultTrigger.focus();
    await page.keyboard.press('Enter');
    const resultInspector = page.getByRole('dialog', { name: 'Inspector' });
    await expect(resultInspector.locator('[data-analyze-failure-details="inspector"]'))
        .toContainText(ANALYZE_RESULT_FAILURE_NAME);
    await page.keyboard.press('Escape');
    await expect(resultInspector).toHaveCount(0);
    await expect(resultTrigger).toBeFocused();
    await expect.poll(fixture.artifactRequestCount).toBe(0);
    expect(
        await page.evaluate(() => ({
            x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            y: document.documentElement.scrollHeight - document.documentElement.clientHeight
        }))
    ).toEqual({ x: 0, y: 0 });
});
