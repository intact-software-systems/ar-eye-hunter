import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:5176';
const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;
const CRDT_ADMIN_LIST_ROUTE = 'http://localhost:8080/api/crdt/admin/documents/list';
const PROVIDER_RECIPE_ID = 'rallar-provider-parity-recipe';
const LEGACY_ACTIONABLE_TARGETS = [
    'button:visible',
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):visible',
    'select:visible',
    'textarea:visible',
    'label:visible:has(input[type="checkbox"]:visible)',
    'label:visible:has(input[type="radio"]:visible)'
].join(', ');

type TargetMeasurement = Readonly<{
    height: number;
    label: string;
    width: number;
}>;

async function installOfflineControlFixture(
    context: BrowserContext
): Promise<void> {
    await context.route(CONTROL_ROUTE, (route) => {
        if (route.request().method() === 'OPTIONS') {
            return route.fulfill({
                status: 204,
                headers: {
                    'access-control-allow-headers': 'content-type',
                    'access-control-allow-methods': 'GET,POST,OPTIONS',
                    'access-control-allow-origin': '*'
                }
            });
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ distributedRuns: [], runs: [] })
        });
    });
}

async function installCrdtAdminFixture(
    context: BrowserContext
): Promise<void> {
    await context.addInitScript(() => {
        localStorage.setItem(
            'auth.session',
            JSON.stringify({
                clientId: 'accessibility-client',
                accessToken: 'accessibility-secret-token',
                username: 'accessibility-operator',
                sessionId: 'accessibility-session',
                expiresAtEpochMs: Date.now() + 60_000
            })
        );
    });
    await context.route(CRDT_ADMIN_LIST_ROUTE, (route) => {
        if (route.request().method() === 'OPTIONS') {
            return route.fulfill({
                status: 204,
                headers: {
                    'access-control-allow-headers': 'content-type, authorization',
                    'access-control-allow-methods': 'POST, OPTIONS',
                    'access-control-allow-origin': '*'
                }
            });
        }
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({
                ok: true,
                result: {
                    documents: [
                        {
                            document: {
                                applicationId: 'rallar-black-box',
                                workspaceId: 'accessibility',
                                documentName: 'alpha',
                                documentId: 'document-alpha',
                                documentType: 'accessibility-fixture'
                            },
                            documentKey: 'accessibility/document-alpha',
                            lifecycle: 'active',
                            updateCount: 3,
                            snapshotCount: 1,
                            lastAppendSequence: 3,
                            updatedAtEpochMs: 1_700_000_000_000
                        },
                        {
                            document: {
                                applicationId: 'rallar-black-box',
                                workspaceId: 'accessibility',
                                documentName: 'bravo',
                                documentId: 'document-bravo',
                                documentType: 'accessibility-fixture'
                            },
                            documentKey: 'accessibility/document-bravo',
                            lifecycle: 'archived',
                            updateCount: 8,
                            snapshotCount: 2,
                            lastAppendSequence: 8,
                            updatedAtEpochMs: 1_700_000_010_000
                        }
                    ],
                    hasMore: false
                }
            })
        });
    });
}

async function visibleTargetMeasurements(
    locator: Locator
): Promise<readonly TargetMeasurement[]> {
    return locator.evaluateAll((elements) =>
        elements.flatMap((element, index) => {
            const bounds = element.getBoundingClientRect();
            if (bounds.width === 0 || bounds.height === 0) {
                return [];
            }
            return [{
                height: Number(bounds.height.toFixed(2)),
                label: element.getAttribute('aria-label') ??
                    element.textContent?.trim().replace(/\s+/gu, ' ') ??
                    `target-${index + 1}`,
                width: Number(bounds.width.toFixed(2))
            }];
        })
    );
}

async function expectTargetsAtLeast44(
    locator: Locator,
    label: string
): Promise<readonly TargetMeasurement[]> {
    await expect(locator.first(), `${label}: visible target`).toBeVisible();
    let measurements: readonly TargetMeasurement[] = [];
    await expect.poll(async () => {
        measurements = await visibleTargetMeasurements(locator);
        return measurements.length;
    }, { message: `${label}: measured targets` }).toBeGreaterThan(0);
    expect.soft(
        measurements.filter((target) => target.width < 44 || target.height < 44),
        `${label}: every visible target is at least 44px by 44px`
    ).toEqual([]);
    return measurements;
}

async function documentOverflow(page: Page): Promise<
    Readonly<{
        x: number;
        y: number;
    }>
> {
    return page.evaluate(() => ({
        x: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
            document.documentElement.clientWidth,
        y: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) -
            document.documentElement.clientHeight
    }));
}

async function attachScreenshot(
    page: Page,
    testInfo: TestInfo,
    name: string
): Promise<void> {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ animations: 'disabled', path });
    await testInfo.attach(name, { contentType: 'image/png', path });
}

test('repairs registered legacy touch targets and narrow CRDT containment', async ({
    browser
}, testInfo) => {
    test.setTimeout(180_000);
    const measurements: Array<Record<string, unknown>> = [];
    const panels = [
        { className: 'media-console-panel', label: 'Media', tab: 'media' },
        { className: 'rallar-data-panel', label: 'Rallar Data', tab: 'rallar-data' },
        { className: 'crdt-health-panel', label: 'CRDT', tab: 'crdt-health' },
        { className: 'auth-command-center-panel', label: 'Auth', tab: 'auth' },
        { className: 'rooms-clients-panel', label: 'Groups/Clients', tab: 'rooms-clients' },
        { className: 'rallar-server-panel', label: 'Rallar Server', tab: 'rallar-server' }
    ] as const;
    const contracts = [
        { hasTouch: false, name: 'desktop-1440x900', viewport: { width: 1440, height: 900 } },
        { hasTouch: true, name: 'touch-portrait-430x932', viewport: { width: 430, height: 932 } },
        { hasTouch: true, name: 'touch-landscape-932x430', viewport: { width: 932, height: 430 } }
    ] as const;

    for (const contract of contracts) {
        const context = await browser.newContext({
            baseURL: BASE_URL,
            hasTouch: contract.hasTouch,
            viewport: contract.viewport
        });
        await installOfflineControlFixture(context);
        const page = await context.newPage();
        try {
            for (const panelContract of panels) {
                await page.goto(
                    '/?provider=simulated&experience=legacy&workspace=rallar' +
                        `&tab=${panelContract.tab}`
                );
                const panel = page.locator(`.${panelContract.className}`);
                await expect(panel).toBeVisible();
                const targets = await expectTargetsAtLeast44(
                    panel.locator(LEGACY_ACTIONABLE_TARGETS),
                    `${contract.name} ${panelContract.label}`
                );
                const overflow = await documentOverflow(page);
                expect.soft(
                    overflow.x,
                    `${contract.name} ${panelContract.label}: no document horizontal overflow`
                ).toBeLessThanOrEqual(1);
                measurements.push({
                    contract: contract.name,
                    maxDocumentOverflowX: overflow.x,
                    minHeight: Math.min(...targets.map((target) => target.height)),
                    minWidth: Math.min(...targets.map((target) => target.width)),
                    panel: panelContract.label,
                    targetCount: targets.length
                });

                if (
                    panelContract.tab !== 'crdt-health' ||
                    contract.viewport.width > 960
                ) {
                    continue;
                }

                const gridTemplates = await panel.locator(
                    '.crdt-editor-controls, ' +
                        '.crdt-editor-workbench .form-grid, ' +
                        '.crdt-editor-diagnostics'
                ).evaluateAll((elements) =>
                    elements.map((element) => ({
                        className: element.className,
                        template: getComputedStyle(element).gridTemplateColumns
                    }))
                );
                const gridMeasurements = gridTemplates.map((measurement) => {
                    const splitTracks = (template: string): readonly string[] => {
                        const tracks: string[] = [];
                        let depth = 0;
                        let start = 0;
                        for (let index = 0; index < template.length; index += 1) {
                            const character = template[index];
                            if (character === '(') {
                                depth += 1;
                            }
                            if (character === ')') {
                                depth -= 1;
                            }
                            if (/\s/u.test(character) && depth === 0) {
                                const track = template.slice(start, index).trim();
                                if (track) {
                                    tracks.push(track);
                                }
                                start = index + 1;
                            }
                        }
                        const finalTrack = template.slice(start).trim();
                        if (finalTrack) {
                            tracks.push(finalTrack);
                        }
                        return tracks;
                    };
                    const trackCount = splitTracks(measurement.template)
                        .reduce((count, track) => {
                            const repetition = /^repeat\((\d+),/u.exec(track);
                            return count + (repetition ? Number(repetition[1]) : 1);
                        }, 0);
                    return { ...measurement, trackCount };
                });
                expect(gridMeasurements).toHaveLength(3);
                for (const grid of gridMeasurements) {
                    expect.soft(
                        grid.trackCount,
                        `${contract.name} ${grid.className}: one narrow track`
                    ).toBe(1);
                }

                const tableShell = panel.locator('.table-shell').first();
                await tableShell.evaluate((element) => {
                    const table = element.querySelector<HTMLElement>('table');
                    if (!table) {
                        throw new Error('CRDT table fixture is missing.');
                    }
                    table.style.minWidth = '1200px';
                });
                const tableGeometry = await tableShell.evaluate((element) => {
                    const owner = element.closest('.crdt-health-panel');
                    if (!(owner instanceof HTMLElement)) {
                        throw new Error('CRDT panel owner is missing.');
                    }
                    const bounds = element.getBoundingClientRect();
                    const ownerBounds = owner.getBoundingClientRect();
                    return {
                        clientWidth: element.clientWidth,
                        documentClientWidth: document.documentElement.clientWidth,
                        left: bounds.left,
                        overflowX: getComputedStyle(element).overflowX,
                        ownerLeft: ownerBounds.left,
                        ownerRight: ownerBounds.right,
                        right: bounds.right,
                        scrollWidth: element.scrollWidth
                    };
                });
                expect.soft(
                    tableGeometry.scrollWidth,
                    `${contract.name}: stressed CRDT table scrolls locally`
                ).toBeGreaterThan(tableGeometry.clientWidth);
                expect.soft(
                    tableGeometry.overflowX,
                    `${contract.name}: stressed CRDT table owns horizontal scroll`
                ).toBe('auto');
                expect.soft(tableGeometry.left).toBeGreaterThanOrEqual(
                    tableGeometry.ownerLeft - 1
                );
                expect.soft(tableGeometry.right).toBeLessThanOrEqual(
                    Math.min(
                        tableGeometry.ownerRight,
                        tableGeometry.documentClientWidth
                    ) + 1
                );
                expect.soft(
                    (await documentOverflow(page)).x,
                    `${contract.name}: stressed CRDT table does not escape the page`
                ).toBeLessThanOrEqual(1);
                measurements.push({
                    contract: contract.name,
                    crdtGridTracks: gridMeasurements.map((grid) => grid.trackCount),
                    crdtTable: tableGeometry
                });
                await tableShell.scrollIntoViewIfNeeded();
                await attachScreenshot(
                    page,
                    testInfo,
                    `legacy-crdt-${contract.name}`
                );
            }
        }
        finally {
            await context.close();
        }
    }

    await testInfo.attach('legacy-accessibility-measurements', {
        body: Buffer.from(JSON.stringify(measurements, null, 2)),
        contentType: 'application/json'
    });
});

test('offers keyboard-operable 44px CRDT document and entity selection controls', async ({ browser }) => {
    test.setTimeout(120_000);
    const contracts = [
        {
            documentKey: 'Enter',
            entityKey: 'Space',
            name: 'touch-portrait-430x932',
            viewport: { width: 430, height: 932 }
        },
        {
            documentKey: 'Space',
            entityKey: 'Enter',
            name: 'touch-landscape-932x430',
            viewport: { width: 932, height: 430 }
        }
    ] as const;

    for (const contract of contracts) {
        const context = await browser.newContext({
            baseURL: BASE_URL,
            hasTouch: true,
            viewport: contract.viewport
        });
        await installOfflineControlFixture(context);
        await installCrdtAdminFixture(context);
        const page = await context.newPage();
        try {
            await page.goto(
                '/?provider=browser-rallar&experience=legacy' +
                    '&workspace=rallar&tab=crdt-health' +
                    '&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080'
            );
            const panel = page.locator('.crdt-health-panel');
            await expect(panel).toBeVisible();

            await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
            const documentSelectors = panel.getByRole('button', {
                name: /^Select CRDT document /u
            });
            await expect(documentSelectors).toHaveCount(2);
            await expectTargetsAtLeast44(
                documentSelectors,
                `${contract.name} CRDT document selectors`
            );
            await expect(documentSelectors.first()).toHaveAttribute(
                'aria-pressed',
                'true'
            );
            await documentSelectors.nth(1).focus();
            await documentSelectors.nth(1).press(contract.documentKey);
            await expect(documentSelectors.nth(1)).toBeFocused();
            await expect(documentSelectors.nth(1)).toHaveAttribute(
                'aria-pressed',
                'true'
            );
            await expect(
                documentSelectors.nth(1).locator('xpath=ancestor::tr')
            ).toHaveClass(/selected/u);
            await expect(panel.getByText('archived', { exact: true }).last())
                .toBeVisible();

            await panel.getByRole('button', { name: 'Open', exact: true }).click();
            await expect(panel.getByText('open', { exact: true }).first())
                .toBeVisible();
            await panel.getByRole('button', { name: 'Entities', exact: true }).click();
            await panel.getByLabel('Entity id').fill('entity-npc-2');
            await panel.getByLabel('Type', { exact: true }).fill('npc');
            await panel.getByRole('button', { name: 'Add Entity', exact: true })
                .click();

            const entitySelectors = panel.getByRole('button', {
                name: /^Load CRDT entity /u
            });
            await expect(entitySelectors).toHaveCount(1);
            await expectTargetsAtLeast44(
                entitySelectors,
                `${contract.name} CRDT entity selectors`
            );
            await expect(entitySelectors.first()).toHaveAttribute(
                'aria-pressed',
                'true'
            );
            await panel.getByLabel('Entity id').fill('unselected-draft');
            await expect(entitySelectors.first()).toHaveAttribute(
                'aria-pressed',
                'false'
            );
            await entitySelectors.first().focus();
            await entitySelectors.first().press(contract.entityKey);
            await expect(entitySelectors.first()).toBeFocused();
            await expect(entitySelectors.first()).toHaveAttribute(
                'aria-pressed',
                'true'
            );
            await expect(entitySelectors.first().locator('xpath=ancestor::tr'))
                .toHaveClass(/selected/u);
            await expect(panel.getByLabel('Entity id'))
                .toHaveValue('entity-npc-2');
        }
        finally {
            await context.close();
        }
    }
});

test('exposes equivalent keyboard touch and persistent evidence at desktop portrait and landscape viewports', async ({
    browser
}, testInfo) => {
    test.setTimeout(120_000);
    const contracts = [
        { hasTouch: false, name: 'desktop-1440x900', viewport: { width: 1440, height: 900 } },
        { hasTouch: true, name: 'touch-portrait-430x932', viewport: { width: 430, height: 932 } },
        { hasTouch: true, name: 'touch-landscape-932x430', viewport: { width: 932, height: 430 } }
    ] as const;

    for (const contract of contracts) {
        const context = await browser.newContext({
            baseURL: BASE_URL,
            hasTouch: contract.hasTouch,
            reducedMotion: 'reduce',
            viewport: contract.viewport
        });
        await installOfflineControlFixture(context);
        const page = await context.newPage();
        const diagnostics: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'warning' || message.type() === 'error') {
                diagnostics.push(`${message.type()}: ${message.text()}`);
            }
        });
        page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));

        try {
            await page.goto(
                '/?provider=simulated&v=1&experience=recipe-console&view=execute' +
                    '&controlRunId=accessibility-control' +
                    '&distributedRunId=accessibility-distributed' +
                    '&agentId=accessibility-agent' +
                    '&commandId=accessibility-command'
            );
            await expect(page.locator('.recipe-console')).toHaveAttribute(
                'data-view',
                'execute'
            );
            const closeInspector = page.getByRole('button', {
                name: 'Close inspector'
            });
            if (await closeInspector.isVisible()) {
                if (contract.hasTouch) {
                    await closeInspector.tap();
                }
                else {
                    await closeInspector.click();
                }
            }

            const providerRecipe = page.locator(
                `[data-execute-recipe][data-recipe-id="${PROVIDER_RECIPE_ID}"]`
            );
            if (contract.hasTouch) {
                await providerRecipe.tap();
            }
            else {
                await providerRecipe.focus();
                await providerRecipe.press('Enter');
            }
            await expect(providerRecipe).toHaveAttribute('aria-selected', 'true');
            expect(new URL(page.url()).searchParams.get('recipeId'))
                .toBe(PROVIDER_RECIPE_ID);

            const manifest = page.locator('[data-execute-manifest]');
            const manifestSummary = manifest.locator('summary');
            await manifestSummary.scrollIntoViewIfNeeded();
            if (contract.hasTouch) {
                await manifestSummary.tap();
            }
            else {
                await manifestSummary.focus();
                await manifestSummary.press('Enter');
            }
            await expect(manifest).toHaveAttribute('open', '');
            await expectTargetsAtLeast44(
                page.locator('[data-primary-navigation] button'),
                `${contract.name} primary navigation`
            );
            await expectTargetsAtLeast44(
                providerRecipe,
                `${contract.name} selected recipe`
            );
            await expectTargetsAtLeast44(
                manifestSummary,
                `${contract.name} manifest disclosure`
            );
            expect(await documentOverflow(page), `${contract.name} Execute overflow`)
                .toEqual({ x: 0, y: 0 });

            const executeNavigation = page.locator(
                '[data-primary-navigation] button[aria-current="page"]'
            );
            await executeNavigation.focus();
            await page.keyboard.press('End');
            const advancedNavigation = page.getByRole('button', {
                name: 'Advanced',
                exact: true
            });
            await expect(advancedNavigation).toBeFocused();
            await expect(page.locator('.recipe-console')).toHaveAttribute(
                'data-view',
                'execute'
            );
            await page.keyboard.press('Enter');

            const advanced = page.locator('[data-advanced-workspace]');
            await expect(advanced).toBeVisible();
            await expect(advanced.locator(
                '[data-context-field="recipeId"] [data-exact-identifier]'
            )).toHaveText(PROVIDER_RECIPE_ID);
            await expect(advanced.locator(
                '[data-context-field="controlRunId"] [data-exact-identifier]'
            )).toHaveText('accessibility-control');

            const persistentEvidence = advanced.locator(
                '[data-surface-id="direct.auth"]'
            );
            await expect(persistentEvidence).toBeVisible();
            await persistentEvidence.scrollIntoViewIfNeeded();
            await expect(persistentEvidence.locator('span')).toHaveCount(2);
            expect(
                await persistentEvidence.evaluate((element) => ({
                    animationName: getComputedStyle(element).animationName,
                    hover: element.matches(':hover'),
                    opacity: getComputedStyle(element).opacity,
                    transitionDuration: getComputedStyle(element).transitionDuration,
                    visibility: getComputedStyle(element).visibility
                }))
            ).toEqual({
                animationName: 'none',
                hover: false,
                opacity: '1',
                transitionDuration: '0s',
                visibility: 'visible'
            });
            await expectTargetsAtLeast44(
                persistentEvidence,
                `${contract.name} persistent Advanced evidence`
            );
            expect(
                await page.evaluate(() => ({
                    hoverNone: matchMedia('(hover: none)').matches,
                    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
                    touchPoints: navigator.maxTouchPoints
                }))
            ).toEqual({
                hoverNone: contract.hasTouch,
                reducedMotion: true,
                touchPoints: contract.hasTouch ? 1 : 0
            });
            expect(await documentOverflow(page), `${contract.name} Advanced overflow`)
                .toEqual({ x: 0, y: 0 });
            expect(diagnostics, `${contract.name} console health`).toEqual([]);
            await attachScreenshot(
                page,
                testInfo,
                `ready-state-accessibility-${contract.name}`
            );
        }
        finally {
            await context.close();
        }
    }
});
