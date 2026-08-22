import { expect, test, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installRecipeConsoleAnalyzeFixture } from './recipe-console-analyze-fixture.ts';
import { analyzeSource } from './recipe-console-analyze-helpers.ts';
import { ANALYZE_ROUTE } from './recipe-console-analyze-run-data.ts';

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..'
);
const artifactFixtureRoot = path.join(
    repoRoot,
    'packages/shared-test/black-box-runner/fixtures/schema/v1/artifact-bundle'
);
const finalIdentity = '  success/group/\u202efull identity  ';
const expectedNames = [
    'duplicate-success',
    'duplicate-success',
    ...Array.from(
        { length: 58 },
        (_, index) => `success-group-${String(index + 3).padStart(3, '0')}`
    ),
    finalIdentity
];

test(
    'shows bounded generic artifact compaction without changing the Shared Test fallback',
    async ({ context, page }) => {
        const mutations: string[] = [];
        context.on('request', (request) => {
            if (!['GET', 'OPTIONS'].includes(request.method())) {
                mutations.push(`${request.method()} ${request.url()}`);
            }
        });
        await installRecipeConsoleAnalyzeFixture(context);
        await page.goto(ANALYZE_ROUTE);
        await analyzeSource(page).getByRole('link', {
            name: 'Open generic export in legacy Shared Test'
        }).click();

        await expect(page).toHaveURL(/experience=legacy/);
        await expect(page).toHaveURL(/workspace=black-box-runner/);
        await expect(page).toHaveURL(/tab=advanced/);
        await expect(page).toHaveURL(/advancedSurface=shared-test/);
        const fallbackUrl = page.url();
        await expect(page.locator('.recipe-console')).toHaveCount(0);
        await expect(page.locator('#legacy-panel-shared-test')).toHaveCount(0);

        const advanced = page.locator('#panel-advanced');
        await expect(advanced).toBeVisible();
        await expect(advanced.getByRole('button', {
            name: 'Shared Test',
            exact: true
        })).toHaveClass(/selected/);
        const sharedTest = advanced.locator('#panel-shared-test');
        await expect(sharedTest).toBeVisible();
        await sharedTest.getByLabel('Artifact Files').setInputFiles(
            sharedTestArtifactFiles()
        );

        const importer = sharedTest.locator('.shared-test-artifact-panel');
        await expect(importer.locator(':scope > .panel-heading .pill'))
            .toHaveText('valid');
        const importedSummary = importer.locator('.artifact-summary-panel').first();
        await expect(metricValue(importedSummary, 'Events')).toHaveText('5');

        const artifactIndex = importer.locator(
            '[data-shared-test-artifact-index]'
        );
        await expect(artifactIndex).toContainText(
            'Generic black-box-runner artifact index'
        );
        await expect(artifactIndex).toContainText(
            'not authoritative distributed-run identity'
        );
        await expect(artifactIndex.locator(
            '[data-shared-test-index-total-events]'
        )).toHaveText('72');
        await expect(artifactIndex.locator(
            '[data-shared-test-index-emitted-events]'
        )).toHaveText('10');
        await expect(artifactIndex.locator(
            '[data-shared-test-index-omitted-events]'
        )).toHaveText('62');
        await expect(artifactIndex.locator(
            '[data-shared-test-index-summary-count]'
        )).toHaveText('61');

        const visitedNames: string[] = [];
        const visitedOrdinals: number[] = [];
        const expectedRanges = [
            'Showing 1–24 of 61 compacted success groups.',
            'Showing 25–48 of 61 compacted success groups.',
            'Showing 49–61 of 61 compacted success groups.'
        ];
        const range = artifactIndex.locator(
            '[data-shared-test-compaction-window] [role="status"]'
        );
        const next = artifactIndex.getByRole('button', { name: 'Next' });

        for (const [index, expectedRange] of expectedRanges.entries()) {
            await expect(range).toHaveText(expectedRange);
            const rows = artifactIndex.locator('[data-compaction-summary-row]');
            expect(await rows.count()).toBeLessThanOrEqual(24);
            visitedNames.push(
                ...await rows.locator(
                    '[data-compaction-summary-name]'
                ).allTextContents()
            );
            visitedOrdinals.push(
                ...await rows.evaluateAll((elements) =>
                    elements.map((element) =>
                        Number(
                            (element as HTMLElement).dataset.compactionSummaryOrdinal
                        )
                    )
                )
            );
            if (index < expectedRanges.length - 1) {
                await next.focus();
                await expect(next).toBeFocused();
                await page.keyboard.press('Enter');
                if (index === expectedRanges.length - 2) {
                    await expect(range).toBeFocused();
                }
                expect(page.url()).toBe(fallbackUrl);
            }
        }

        expect(visitedNames).toEqual(expectedNames);
        expect(visitedOrdinals).toEqual(
            expectedNames.map((_, index) => index + 1)
        );
        expect(new Set(visitedOrdinals).size).toBe(expectedNames.length);
        const lastName = artifactIndex.locator(
            '[data-compaction-summary-name]'
        ).last();
        await expect(lastName).toHaveText(finalIdentity);
        await expect(lastName).toHaveAttribute('dir', 'ltr');
        await expect(next).toBeDisabled();

        const previous = artifactIndex.getByRole('button', { name: 'Previous' });
        await previous.focus();
        await page.keyboard.press('Enter');
        await expect(range).toHaveText(expectedRanges[1]);
        await expect(previous).toBeFocused();
        await previous.focus();
        await page.keyboard.press('Enter');
        await expect(range).toHaveText(expectedRanges[0]);
        await expect(range).toBeFocused();
        expect(page.url()).toBe(fallbackUrl);
        expect(mutations).toEqual([]);

        await page.goto('/?provider=simulated&tab=artifacts');
        await expect(page.getByRole('tab', { name: 'Advanced', exact: true }))
            .toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#panel-advanced #panel-shared-test'))
            .toBeVisible();
        await expect(
            page.locator('#panel-advanced').getByRole('button', {
                name: 'Shared Test',
                exact: true
            })
        ).toHaveClass(/selected/);
        expect(mutations).toEqual([]);
    }
);

function metricValue(scope: Locator, label: string) {
    return scope.getByText(label, { exact: true }).locator('..').locator('strong');
}

function sharedTestArtifactFiles() {
    const file = (name: string, contents?: string) => ({
        name,
        mimeType: name.endsWith('.jsonl')
            ? 'application/x-ndjson'
            : 'application/json',
        buffer: Buffer.from(
            contents ?? readFileSync(
                path.join(artifactFixtureRoot, name),
                'utf8'
            )
        )
    });
    return [
        file('report.json'),
        file('events.jsonl'),
        file('failures.json'),
        file('metadata.json'),
        file('artifact-index.json', JSON.stringify(largeArtifactIndex()))
    ];
}

function largeArtifactIndex() {
    const artifactIndex = JSON.parse(readFileSync(
        path.join(artifactFixtureRoot, 'artifact-index.json'),
        'utf8'
    ));
    return {
        ...artifactIndex,
        compaction: {
            compacted: true,
            repeatedSuccessSummaries: expectedNames.map((name, index) => ({
                name,
                transport: index % 2 === 0 ? 'RTC' : 'WS',
                action: 'send',
                connection: `connection-${index % 3}`,
                status: 'SUCCESS',
                count: 1,
                firstSequence: index + 1,
                lastSequence: index + 1
            }))
        },
        truncation: {
            ...artifactIndex.truncation,
            truncated: true,
            totalEvents: 72,
            emittedEvents: 10,
            omittedEvents: 62
        }
    };
}
