import { expect, test, type Page } from '@playwright/test';
import {
    createAnalyzeArtifactEnvelopeForIdentity,
    createAnalyzeLooseFiles,
    createAnalyzeLooseFilesForIdentity,
    createDuplicateAnalyzeFiles,
    createMalformedAnalyzeFiles,
} from './recipe-console-analyze-artifacts.ts';
import { installRecipeConsoleAnalyzeFixture } from './recipe-console-analyze-fixture.ts';
import {
    analyzeDroppedFileReadCount,
    analyzeLegacyRunsLink,
    analyzePoliteAnnouncement,
    analyzeSearch,
    analyzeSource,
    analyzeVerdict,
    chooseAnalyzeFiles,
    deferredAnalyzeFileReadCount,
    dropAnalyzeFiles,
    dropAnalyzeFilesWithReadProbe,
    installDeferredAnalyzeFileRead,
    pushAnalyzeContext,
    releaseDeferredAnalyzeFileRead,
    waitForDeferredAnalyzeFileRead,
} from './recipe-console-analyze-helpers.ts';
import {
    ANALYZE_CONTROL_RUN_ID,
    ANALYZE_CONTROL_ROUTE,
    ANALYZE_DISTRIBUTED_RUN_ID,
    ANALYZE_FAILURE_MESSAGE,
    ANALYZE_ROUTE,
} from './recipe-console-analyze-run-data.ts';

function artifactStatus(page: Page) {
    return analyzeSource(page).locator('[data-artifact-status]');
}

function operationError(page: Page) {
    return analyzeSource(page).locator('[data-analyze-operation-error]');
}

test('retains prior analysis after malformed and duplicate replacement selections', async ({ context, page }) => {
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, createAnalyzeLooseFiles());
    const evidenceCount = await analyzeSearch(page).locator('[data-evidence-result]').count();
    await chooseAnalyzeFiles(page, createMalformedAnalyzeFiles());
    await expect(operationError(page)).toContainText('Previous analysis retained.');
    await expect(operationError(page)).toContainText('does not contain usable distributed-run analysis');
    await expect(analyzePoliteAnnouncement(page)).toContainText('Artifact selection rejected');
    await expect(analyzePoliteAnnouncement(page)).toContainText('Previous analysis retained');
    await expect(analyzePoliteAnnouncement(page)).not.toContainText('Artifact selection processed');
    await expect(analyzeVerdict(page)).toContainText(ANALYZE_FAILURE_MESSAGE);
    await expect(analyzeSearch(page).locator('[data-evidence-result]')).toHaveCount(evidenceCount);
    await chooseAnalyzeFiles(page, createDuplicateAnalyzeFiles());
    await expect(operationError(page)).toContainText('Duplicate artifact basename "manifest.json"');
    await expect(analyzeVerdict(page)).toContainText(ANALYZE_FAILURE_MESSAGE);
});

test('announces Control artifact loading and ready completion', async ({ context, page }) => {
    const fixture = await installRecipeConsoleAnalyzeFixture(context);
    fixture.deferNextArtifactResponse();
    await page.goto(ANALYZE_CONTROL_ROUTE);
    await page.locator('[data-analyze-load-artifact]').click();
    await fixture.waitForDeferredArtifactRequest();
    try {
        await expect(analyzePoliteAnnouncement(page)).toContainText('Control artifact load started');
    } finally {
        fixture.releaseDeferredArtifactResponse();
    }
    await expect(artifactStatus(page)).toHaveText('Artifact ready');
    await expect(analyzePoliteAnnouncement(page)).toContainText('Control artifact ready');
});

test('rejects a dropped artifact without reading it while Control loading is busy', async ({ context, page }) => {
    const fixture = await installRecipeConsoleAnalyzeFixture(context);
    fixture.deferNextArtifactResponse();
    await page.goto(ANALYZE_CONTROL_ROUTE);
    await page.locator('[data-analyze-load-artifact]').click();
    await fixture.waitForDeferredArtifactRequest();
    try {
        await dropAnalyzeFilesWithReadProbe(page, createAnalyzeLooseFiles());
        await expect(analyzePoliteAnnouncement(page)).toContainText(
            'Artifact selection rejected while Control artifact loading is in progress',
        );
        await expect.poll(() => analyzeDroppedFileReadCount(page)).toBe(0);
        await expect(analyzePoliteAnnouncement(page)).not.toContainText('Artifact selection processed');
    } finally {
        fixture.releaseDeferredArtifactResponse();
    }
    await expect(artifactStatus(page)).toHaveText('Artifact ready');
    await expect(analyzeSource(page).locator('[data-analyze-provenance]'))
        .toContainText(`Control artifact ${ANALYZE_DISTRIBUTED_RUN_ID}`);
});

test('marks retained evidence stale across URL context history and keeps legacy handoff on the loaded run', async ({ context, page }) => {
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, createAnalyzeLooseFiles());
    await expect.poll(() => new URL(page.url()).searchParams.get('distributedRunId'))
        .toBe(ANALYZE_DISTRIBUTED_RUN_ID);
    const loadedUrl = page.url();
    await pushAnalyzeContext(page, { controlRunId: 'control-b', distributedRunId: 'distributed-b' });
    await expect(artifactStatus(page)).toHaveText('Needs attention');
    await expect(operationError(page)).toContainText(
        `Loaded artifact ${ANALYZE_DISTRIBUTED_RUN_ID} does not match selected distributed run distributed-b`,
    );
    await expect(analyzeVerdict(page)).toContainText(ANALYZE_FAILURE_MESSAGE);
    const staleHref = new URL(await analyzeLegacyRunsLink(page).getAttribute('href') ?? '', page.url());
    expect(staleHref.searchParams.get('controlRunId')).toBe(ANALYZE_CONTROL_RUN_ID);
    expect(staleHref.searchParams.get('distributedRunId')).toBe(ANALYZE_DISTRIBUTED_RUN_ID);
    await page.goBack();
    await expect(page).toHaveURL(loadedUrl);
    await expect(artifactStatus(page)).toHaveText('Artifact ready');
    await expect(operationError(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Tune', exact: true }).click();
    await expect(page.locator('[data-analyze-workspace]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Analyze', exact: true }).click();
    await expect(page.locator('[data-analyze-workspace]')).toBeVisible();
    await expect(analyzeVerdict(page)).toContainText(ANALYZE_FAILURE_MESSAGE);
});

test('rejects internally consistent Control files from the wrong control run without rewriting retained context', async ({ context, page }) => {
    const fixture = await installRecipeConsoleAnalyzeFixture(context);
    fixture.setArtifactResponse(createAnalyzeArtifactEnvelopeForIdentity({
        outerDistributedRunId: 'distributed-x',
        fileDistributedRunId: 'distributed-x',
        fileControlRunId: 'control-b',
    }));
    await page.goto(ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, createAnalyzeLooseFiles());
    await pushAnalyzeContext(page, { controlRunId: 'control-a', distributedRunId: 'distributed-x' });
    const expectedUrl = page.url();
    await page.locator('[data-analyze-load-artifact]').click();
    await expect.poll(fixture.artifactRequestCount).toBe(1);
    await expect(artifactStatus(page)).toHaveText('Needs attention');
    await expect(operationError(page)).toContainText(
        'Artifact response belongs to control run control-b, not control-a.',
    );
    await expect(analyzeVerdict(page)).toContainText(ANALYZE_FAILURE_MESSAGE);
    expect(page.url()).toBe(expectedUrl);
});

test('keeps unsafe artifact identities out of URLs and bounds the exported filename', async ({ context, page }) => {
    await installRecipeConsoleAnalyzeFixture(context);
    const distributedRunId = `../dist-\u202e/${'x'.repeat(300)}`;
    const controlRunId = 'control-\u2066unsafe';
    await page.goto(ANALYZE_ROUTE);
    await chooseAnalyzeFiles(page, createAnalyzeLooseFilesForIdentity({ distributedRunId, controlRunId }));
    await expect(artifactStatus(page)).toHaveText('Artifact ready');
    const warnings = page.locator('[data-analyze-section="quality"]').getByRole('alert');
    await expect(warnings).toHaveCount(2);
    await expect(warnings.filter({ hasText: 'exceeds 256 characters' })).toHaveCount(1);
    await expect(warnings.filter({ hasText: 'contains unsafe characters' })).toHaveCount(1);
    const url = new URL(page.url());
    expect(url.searchParams.has('distributedRunId')).toBe(false);
    expect(url.searchParams.get('controlRunId')).toBe(ANALYZE_CONTROL_RUN_ID);
    expect(page.url().length).toBeLessThan(300);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-analyze-export-artifact]').click();
    const filename = (await downloadPromise).suggestedFilename();
    expect(filename.length).toBeLessThanOrEqual(140);
    expect(filename).not.toMatch(/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u);
    expect(filename).not.toContain('..');
});

test('rejects a second drop during a deferred local import without reading it', async ({ context, page }) => {
    await installRecipeConsoleAnalyzeFixture(context);
    await page.goto(ANALYZE_ROUTE);
    await installDeferredAnalyzeFileRead(page);
    await chooseAnalyzeFiles(page, createAnalyzeLooseFiles());
    await waitForDeferredAnalyzeFileRead(page);
    try {
        await dropAnalyzeFiles(page, createAnalyzeLooseFilesForIdentity({
            distributedRunId: 'distributed-b', controlRunId: 'control-b',
        }));
        await expect.soft(analyzePoliteAnnouncement(page)).toContainText(
            'Artifact selection rejected while artifact import is in progress',
        );
        await expect.poll(() => deferredAnalyzeFileReadCount(page)).toBe(1);
    } finally {
        await releaseDeferredAnalyzeFileRead(page);
    }
    await expect(artifactStatus(page)).toHaveText('Artifact ready');
    await expect.soft(analyzePoliteAnnouncement(page)).toContainText(
        'Artifact selection rejected while artifact import is in progress',
    );
    expect(new URL(page.url()).searchParams.get('distributedRunId'))
        .toBe(ANALYZE_DISTRIBUTED_RUN_ID);
});
