import { expect, test, type Locator, type Page } from '@playwright/test';
import {
    FLEET_ALTERNATE_REGION,
    FLEET_CONTROL_RUN_ID,
    FLEET_EXPLICIT_ONLY_AGENT_ID,
    FLEET_LONG_BIDI_AGENT_ID,
    FLEET_PRIMARY_AGENT_ID,
    FLEET_PRIMARY_RECIPE_ID,
    FLEET_PRIMARY_SIGNATURE_ID,
    FLEET_REPORT_ID,
    FLEET_ROUTE,
    FLEET_SELECTED_REGION,
    installRecipeConsoleFleetFixture,
} from './recipe-console-fleet-fixture.ts';

const SPA_ORIGIN = 'http://127.0.0.1:5176';

test('restores fleet filters and map layers and links a failure signature to its run evidence', async ({
    context,
    page,
}) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        { origin: SPA_ORIGIN },
    );
    const fixture = await installRecipeConsoleFleetFixture(context, page);
    await page.goto(FLEET_ROUTE);

    const fleet = page.locator('[data-fleet-workspace]');
    await expect(fleet).toBeVisible();
    await expect(fleet.locator('[data-fleet-operational-state="live"]'))
        .toBeVisible();
    await expect(fleet.getByText('Root control snapshot', { exact: true }))
        .toBeVisible();
    await expect(fleet).toContainText('14 accepted reports');
    await expect(fleet).toContainText('All source reports passed the supported schema boundary.');

    await expectFleetUrl(page, {
        view: 'fleet',
        controlRunId: FLEET_CONTROL_RUN_ID,
        distributedRunId: FLEET_REPORT_ID,
        fleetRegion: FLEET_SELECTED_REGION,
        fleetMapLayers: 'live-agents,historical-regions,failures',
    });
    const map = fleet.getByRole('region', { name: 'Fleet evidence map' });
    const routesLayer = map.locator(
        `[data-fleet-map-layer="observed-routes"]`,
    );
    await expect(routesLayer).toHaveAttribute('aria-pressed', 'false');
    await expect(map.locator('[data-fleet-map-agent]')).toHaveCount(40);
    await expect(map.locator('[data-fleet-map-region]')).toHaveCount(24);
    await expect(map.locator('[data-fleet-map-route]')).toHaveCount(0);
    await expect(map.locator('[data-fleet-map-failure]')).toHaveCount(40);
    await expectMapLayerTruth(map, 'Live agents', {
        enabled: true,
        text: '40 rendered of 50 candidates; 10 omitted.',
    });
    await expectMapLayerTruth(map, 'Historical regions', {
        enabled: true,
        text: '24 rendered of 69 candidates; 45 omitted.',
    });
    await expectMapLayerTruth(map, 'Observed routes', {
        enabled: false,
        text: '0 rendered of 36 candidates; 36 omitted.',
    });
    await expectMapLayerTruth(map, 'Failure locations', {
        enabled: true,
        text: '40 rendered of 45 candidates; 5 omitted.',
    });

    const initialHref = page.url();
    await page.getByRole('button', { name: 'Copy canonical link' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(initialHref);
    await page.reload();
    await expect(page).toHaveURL(initialHref);
    await expect(routesLayer).toHaveAttribute('aria-pressed', 'false');
    await expect(map.locator(
        `[data-fleet-map-region][data-selected="true"]`,
    )).toHaveCount(24);
    await expect(fleet.locator(
        `[data-fleet-region="${FLEET_SELECTED_REGION}"]`,
    ).first()).toHaveAttribute('aria-pressed', 'true');

    await routesLayer.scrollIntoViewIfNeeded();
    await routesLayer.focus();
    await expect(routesLayer).toBeFocused();
    await routesLayer.press('Enter');
    const allLayersHref = page.url();
    expect(new URL(allLayersHref).searchParams.has('fleetMapLayers')).toBe(false);
    await expect(routesLayer).toHaveAttribute('aria-pressed', 'true');
    await expect(map.locator('[data-fleet-map-agent]')).toHaveCount(40);
    await expect(map.locator('[data-fleet-map-region]')).toHaveCount(24);
    await expect(map.locator('[data-fleet-map-route]')).toHaveCount(32);
    await expect(map.locator('[data-fleet-map-failure]')).toHaveCount(40);
    await expectMapLayerTruth(map, 'Observed routes', {
        enabled: true,
        text: '32 rendered of 36 candidates; 4 omitted.',
    });

    const alternateRegion = fleet.locator(
        `[data-fleet-region="${FLEET_ALTERNATE_REGION}"]`,
    ).first();
    await tabToFleetRegion(page, fleet, alternateRegion);
    await page.keyboard.press('Enter');
    const alternateRegionHref = page.url();
    expect(new URL(alternateRegionHref).searchParams.get('fleetRegion'))
        .toBe(FLEET_ALTERNATE_REGION);
    await expect(alternateRegion).toHaveAttribute('aria-pressed', 'true');
    await expect(alternateRegion).toBeFocused();

    await page.goBack();
    await expect(page).toHaveURL(allLayersHref);
    await expect(routesLayer).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(
        `[data-fleet-region="${FLEET_SELECTED_REGION}"]`,
    ).first()).toHaveAttribute('aria-pressed', 'true');
    await expect(alternateRegion).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(initialHref);
    await expect(routesLayer).toHaveAttribute('aria-pressed', 'false');
    await page.goForward();
    await expect(page).toHaveURL(allLayersHref);
    await page.goForward();
    await expect(page).toHaveURL(alternateRegionHref);

    await page.goto(initialHref);
    await expect(fleet.locator('[data-fleet-operational-state="live"]'))
        .toBeVisible();
    for (const [label, range] of [
        ['Fleet live agents', 'Showing 1–40 of 95 live agents.'],
        ['Fleet heatmap agents', 'Showing 1–32 of 100 agents.'],
        ['Fleet heatmap runs', 'Showing 1–8 of 14 runs.'],
        ['Fleet regions', 'Showing 1–24 of 69 regions.'],
        ['Fleet failure groups', 'Showing 1–24 of 30 failure groups.'],
        ['Fleet region timing', 'Showing 1–24 of 69 region timing groups.'],
        ['Fleet recipe timing', 'Showing 1–24 of 30 recipe timing groups.'],
        ['Fleet resolved live agent locations',
            'Showing 1–40 of 50 resolved live agent locations.'],
        ['Fleet resolved region locations',
            'Showing 1–24 of 69 resolved region locations.'],
        ['Fleet resolved failure locations',
            'Showing 1–40 of 45 resolved failure locations.'],
        ['Fleet observed routes', 'Showing 1–32 of 36 observed routes.'],
        ['Fleet unresolved agents', 'Showing 1–40 of 45 unresolved agents.'],
        ['Fleet unresolved route endpoints',
            'Showing 1–40 of 45 unresolved route endpoints.'],
        ['Fleet unlabeled agents', 'Showing 1–40 of 45 unlabeled agents.'],
        ['Selected Fleet report recipes', 'Showing 1–24 of 30 recipes.'],
    ] as const) {
        await expectWindow(fleet, label, range);
    }
    await expect(fleet.locator('[data-fleet-resolved-agent-location]'))
        .toHaveCount(40);
    await expect(fleet.locator('[data-fleet-resolved-region-location]'))
        .toHaveCount(24);
    await expect(fleet.locator('[data-fleet-resolved-failure-location]'))
        .toHaveCount(40);
    await expect(fleet.locator('[data-fleet-route-evidence]')).toHaveCount(32);
    await expect(fleet.locator('[data-fleet-unresolved-agent]')).toHaveCount(40);
    await expect(fleet.locator('[data-fleet-unresolved-endpoint]')).toHaveCount(40);
    await expect(fleet).toContainText(
        'Observed in the bounded control snapshot event window; not a complete network topology.',
    );
    await expect(fleet.getByText(FLEET_EXPLICIT_ONLY_AGENT_ID, { exact: true }))
        .toHaveCount(0);

    await traverseFleetWindow({
        root: fleet,
        label: 'Fleet live agents',
        items: fleet.locator('#fleet-live-agents tbody tr'),
        ranges: [
            ['Showing 1–40 of 95 live agents.', 40],
            ['Showing 41–80 of 95 live agents.', 40],
            ['Showing 81–95 of 95 live agents.', 15],
        ],
    });
    await traverseFleetWindow({
        root: fleet,
        label: 'Fleet heatmap agents',
        items: fleet.locator('#fleet-heatmap tbody tr'),
        ranges: [
            ['Showing 1–32 of 100 agents.', 32],
            ['Showing 33–64 of 100 agents.', 32],
            ['Showing 65–96 of 100 agents.', 32],
            ['Showing 97–100 of 100 agents.', 4],
        ],
    });
    await traverseFleetWindow({
        root: fleet,
        label: 'Fleet resolved region locations',
        items: fleet.locator('[data-fleet-resolved-region-location]'),
        ranges: [
            ['Showing 1–24 of 69 resolved region locations.', 24],
            ['Showing 25–48 of 69 resolved region locations.', 24],
            ['Showing 49–69 of 69 resolved region locations.', 21],
        ],
    });
    await traverseFleetWindow({
        root: fleet,
        label: 'Fleet observed routes',
        items: fleet.locator('[data-fleet-route-evidence]'),
        ranges: [
            ['Showing 1–32 of 36 observed routes.', 32],
            ['Showing 33–36 of 36 observed routes.', 4],
        ],
    });
    await traverseFleetWindow({
        root: fleet,
        label: 'Fleet unresolved route endpoints',
        items: fleet.locator('[data-fleet-unresolved-endpoint]'),
        ranges: [
            ['Showing 1–40 of 45 unresolved route endpoints.', 40],
            ['Showing 41–45 of 45 unresolved route endpoints.', 5],
        ],
    });
    await traverseFleetWindow({
        root: fleet,
        label: 'Fleet failure groups',
        items: fleet.locator('[data-fleet-failure]'),
        ranges: [
            ['Showing 1–24 of 30 failure groups.', 24],
            ['Showing 25–30 of 30 failure groups.', 6],
        ],
    });

    const artifact = fleet.getByRole('region', {
        name: 'Selected report artifact',
    });
    await artifact.getByRole('button', { name: 'Load artifact bundle' }).click();
    await expect(artifact.locator('li')).toHaveCount(4);
    await expect(artifact).toContainText('fleet-report.json');
    await expect.poll(fixture.artifactRequestCount).toBe(1);
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        artifact.getByRole('button', { name: 'Export validated envelope' }).click(),
    ]);
    expect(download.suggestedFilename())
        .toBe(`${FLEET_REPORT_ID}-fleet-report-bundle.json`);

    const failure = fleet.locator(
        `[data-fleet-failure="${FLEET_PRIMARY_SIGNATURE_ID}"]`,
    );
    await expect(failure).toContainText('Observed route acknowledgement timeout');
    await expect(failure).toContainText('One receiver stopped acknowledging the explicit route.');
    const affectedWindow = failure.getByRole('group', {
        name: 'Observed route acknowledgement timeout affected agents window',
    });
    await expect(affectedWindow).toContainText(
        'Showing 1–40 of 45 affected agents.',
    );
    const nextAffected = affectedWindow.getByRole('button', { name: 'Next' });
    await nextAffected.focus();
    await nextAffected.press('Enter');
    await expect(affectedWindow).toContainText(
        'Showing 41–45 of 45 affected agents.',
    );
    await expect(failure.locator(
        `[data-failure-agent-id="${FLEET_PRIMARY_AGENT_ID}"]`,
    )).toBeVisible();
    await expect(failure.locator(
        '[data-fleet-window-focus-anchor="Observed route acknowledgement timeout affected agents"]',
    )).toBeFocused();

    const affectedAgent = failure.locator(
        `[data-failure-agent-id="${FLEET_PRIMARY_AGENT_ID}"]`,
    );
    await affectedAgent.focus();
    await affectedAgent.press('Enter');
    await expectFleetUrl(page, {
        view: 'fleet',
        agentId: FLEET_PRIMARY_AGENT_ID,
    });
    const inspector = page.locator('[data-inspector-host]');
    await expect(inspector).toContainText(FLEET_PRIMARY_AGENT_ID);
    await expectWindow(
        inspector,
        'Selected Fleet agent runs',
        'Showing 1–12 of 14 historical runs.',
    );
    await expectWindow(
        inspector,
        'Selected Fleet region providers',
        'Showing 1–24 of 39 provider rows.',
    );
    await expect(inspector).toHaveAttribute('data-mode', 'rail');
    await expect(inspector.getByRole('button', { name: 'Close inspector' }))
        .toHaveCount(0);
    await inspector.getByRole('button', { name: 'Open Analyze' }).click();
    await expect(page.locator('[data-analyze-workspace]')).toBeVisible();
    await expectFleetUrl(page, {
        view: 'analyze',
        controlRunId: FLEET_CONTROL_RUN_ID,
        distributedRunId: FLEET_REPORT_ID,
        agentId: FLEET_PRIMARY_AGENT_ID,
    });
    await page.goBack();
    await expect(fleet).toBeVisible();

    await failure.getByRole('button', { name: 'Open proving run' }).click();
    await expect(page.locator('[data-monitor-workspace]')).toBeVisible();
    await expectFleetUrl(page, {
        view: 'monitor',
        controlRunId: FLEET_CONTROL_RUN_ID,
        distributedRunId: FLEET_REPORT_ID,
        agentId: FLEET_PRIMARY_AGENT_ID,
    });
    await page.goBack();
    await expect(fleet).toBeVisible();

    await failure.getByRole('button', { name: 'Filter History' }).click();
    await expect(page.locator('[data-tune-workspace]')).toBeVisible();
    await expectFleetUrl(page, {
        view: 'tune',
        controlRunId: FLEET_CONTROL_RUN_ID,
        distributedRunId: FLEET_REPORT_ID,
        compareRight: FLEET_REPORT_ID,
        historyQuery: FLEET_REPORT_ID,
        historyGroup: 'monitor-group',
        historyRecipeId: FLEET_PRIMARY_RECIPE_ID,
    });
    await page.goBack();
    await expect(fleet).toBeVisible();

    fixture.failRootReads();
    const readsBeforeFailure = fixture.rootRequestCount();
    await fleet.getByLabel('Fleet recovery actions')
        .getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(fixture.rootRequestCount).toBeGreaterThan(readsBeforeFailure);
    await expect(fleet.locator('[data-fleet-operational-state="stale"]'))
        .toBeVisible();
    await expect(fleet.getByRole('heading', {
        name: 'Showing last-known Fleet evidence',
    })).toBeVisible();
    await expect(fleet.locator(
        `[data-fleet-retained-evidence] [data-fleet-failure="${FLEET_PRIMARY_SIGNATURE_ID}"]`,
    )).toBeVisible();

    fixture.recoverRootReads();
    const readsBeforeRecovery = fixture.rootRequestCount();
    await fleet.getByLabel('Fleet recovery actions')
        .getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(fixture.rootRequestCount).toBeGreaterThan(readsBeforeRecovery);
    await expect(fleet.locator('[data-fleet-operational-state="live"]'))
        .toBeVisible();
    expect(await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth
    )).toBe(0);
});

test('keeps empty partial and schema-error Fleet evidence honest', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleFleetFixture(context, page);
    await page.goto(FLEET_ROUTE);
    const fleet = page.locator('[data-fleet-workspace]');
    await expect(fleet.locator('[data-fleet-operational-state="live"]'))
        .toBeVisible();

    fixture.setFleetCollection('empty');
    await refreshFleet(fleet, fixture.rootRequestCount);
    await expect(fleet.locator('[data-fleet-operational-state="empty"]'))
        .toBeVisible();
    await expect(fleet.getByRole('heading', { name: 'No Fleet reports yet' }))
        .toBeVisible();
    await expect(fleet.getByRole('heading', { name: 'Live agent board' }))
        .toBeVisible();

    fixture.setFleetCollection('schema-error');
    await refreshFleet(fleet, fixture.rootRequestCount);
    await expect(fleet.locator('[data-fleet-operational-state="schema-error"]'))
        .toBeVisible();
    await expect(fleet.getByRole('heading', {
        name: 'Some Fleet reports were quarantined',
    })).toBeVisible();
    await expect(fleet).toContainText('14 of 15 reports accepted.');
    await expect(fleet.locator(
        `[data-fleet-failure="${FLEET_PRIMARY_SIGNATURE_ID}"]`,
    )).toBeVisible();

    fixture.setFleetCollection('absent');
    await refreshFleet(fleet, fixture.rootRequestCount);
    await expect(fleet.locator('[data-fleet-operational-state="partial"]'))
        .toBeVisible();
    await expect(fleet.getByRole('heading', { name: 'Fleet evidence is partial' }))
        .toBeVisible();
    await expect(fleet).toContainText('Fleet report collection unavailable.');
    await expect(fleet.locator('#fleet-live-agents tbody tr')).toHaveCount(40);

    fixture.setFleetCollection('present');
    await refreshFleet(fleet, fixture.rootRequestCount);
    await expect(fleet.locator('[data-fleet-operational-state="live"]'))
        .toBeVisible();
});

test('recovers an initially offline Fleet root snapshot', async ({
    context,
    page,
}) => {
    const fixture = await installRecipeConsoleFleetFixture(context, page);
    fixture.failRootReads();
    fixture.holdRootReads();
    await page.goto(FLEET_ROUTE);
    const fleet = page.locator('[data-fleet-workspace]');
    const connecting = fleet.locator(
        '[data-fleet-operational-state="connecting"]',
    );
    await expect(connecting).toBeVisible();
    const loading = connecting.locator('[data-state="empty"]');
    await expect(loading).toHaveAttribute('aria-live', 'polite');
    await expect(loading.getByRole('heading', {
        name: 'Connecting to Fleet evidence',
    })).toBeVisible();
    await expect(loading).toContainText(
        'The root control snapshot has not arrived yet.',
    );
    await expect(loading).toContainText('Fleet report collection unavailable.');

    fixture.releaseRootReads();
    await expect(fleet.locator('[data-fleet-operational-state="offline"]'))
        .toBeVisible();
    const error = fleet.locator('[data-state="error"]');
    await expect(error).toHaveAttribute('aria-live', 'assertive');
    await expect(error.getByRole('heading', { name: 'Fleet control is offline' }))
        .toBeVisible();
    await expect(error).toContainText('Fleet report collection unavailable.');

    fixture.recoverRootReads();
    await refreshFleet(fleet, fixture.rootRequestCount);
    await expect(fleet.locator('[data-fleet-operational-state="live"]'))
        .toBeVisible();
});

test.describe('touch and reduced-motion Fleet acceptance', () => {
    test.use({ hasTouch: true });

    test('keeps long bidirectional evidence usable in touch portrait and landscape', async ({
        context,
        page,
    }) => {
        test.setTimeout(45_000);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await installRecipeConsoleFleetFixture(context, page);
        for (const viewport of [
            { width: 430, height: 932 },
            { width: 932, height: 430 },
        ] as const) {
            await page.setViewportSize(viewport);
            await page.goto(FLEET_ROUTE);
            const fleet = page.locator('[data-fleet-workspace]');
            await expect(fleet.locator('[data-fleet-operational-state="live"]'))
                .toBeVisible();
            expect(await page.evaluate(() => ({
                hover: matchMedia('(hover: hover)').matches,
                reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
                overflow: document.documentElement.scrollWidth -
                    document.documentElement.clientWidth,
            }))).toEqual({ hover: false, reduced: true, overflow: 0 });

            const mapLayers = fleet.locator('[data-fleet-map-layer]');
            expect(await mapLayers.evaluateAll(buttons => buttons.map(button => {
                const bounds = button.getBoundingClientRect();
                return bounds.width >= 44 && bounds.height >= 44;
            }))).toEqual([true, true, true, true]);
            const undersized = await fleet.locator('button').evaluateAll(
                buttons => buttons.flatMap(button => {
                    const style = getComputedStyle(button);
                    if (
                        style.display === 'none' ||
                        style.visibility === 'hidden' ||
                        button.getClientRects().length === 0
                    ) return [];
                    const bounds = button.getBoundingClientRect();
                    return bounds.width + .5 < 44 || bounds.height + .5 < 44
                        ? [{
                            label: button.getAttribute('aria-label') ??
                                button.textContent?.trim(),
                            width: bounds.width,
                            height: bounds.height,
                        }]
                        : [];
                }),
            );
            expect(undersized).toEqual([]);

            const animated = await fleet.locator('*').evaluateAll(elements =>
                elements.flatMap(element => {
                    const style = getComputedStyle(element);
                    const active = (value: string) => value.split(',').some(
                        part => Number.parseFloat(part) > 0,
                    );
                    return active(style.transitionDuration) ||
                            active(style.animationDuration)
                        ? [element.tagName]
                        : [];
                })
            );
            expect(animated).toEqual([]);

            const longIdentifier = fleet.locator('[data-exact-identifier]')
                .filter({ hasText: FLEET_LONG_BIDI_AGENT_ID }).first();
            await expect(longIdentifier).toBeVisible();
            await expect(longIdentifier).toHaveAttribute('dir', 'ltr');
            await expect(longIdentifier).toHaveCSS(
                'unicode-bidi',
                'isolate-override',
            );

            if (viewport.width === 430) {
                const longAgent = fleet.locator('[data-agent-id]')
                    .filter({ hasText: FLEET_LONG_BIDI_AGENT_ID }).first();
                await longAgent.scrollIntoViewIfNeeded();
                await longAgent.tap();
                const dialog = page.getByRole('dialog', { name: 'Inspector' });
                await expect(dialog).toContainText(FLEET_LONG_BIDI_AGENT_ID);
                await expect(dialog.getByRole('button', {
                    name: 'Close inspector',
                })).toBeFocused();
                await page.keyboard.press('Escape');
                await expect(dialog).toHaveCount(0);
                await expect(longAgent).toBeFocused();
            } else {
                await expectShortLandscapeEvidenceReachable(page, fleet);
            }
        }
    });
});

async function expectShortLandscapeEvidenceReachable(
    page: Page,
    fleet: Locator,
): Promise<void> {
    const work = page.locator('[data-work-surface]');
    const workBounds = await work.boundingBox();
    if (!workBounds) throw new Error('Missing visible Fleet work surface');

    await resetFleetScrollOwner(fleet);
    await page.mouse.move(
        workBounds.x + workBounds.width / 2,
        workBounds.y + Math.min(120, workBounds.height / 2),
    );
    for (let index = 0; index < 6; index += 1) {
        await page.mouse.wheel(0, 10_000);
    }
    const wheel = await readFleetScrollMetrics(page);
    expectFleetScrollAtBottom('wheel', wheel);

    await resetFleetScrollOwner(fleet);
    await expect(fleet).toHaveAttribute('tabindex', '0');
    await expect(fleet).toHaveRole('region');
    await expect(fleet).toHaveAccessibleName('Fleet evidence');
    await fleet.focus();
    await expect(fleet).toBeFocused();
    await page.keyboard.press('End');
    await expect.poll(async () => fleetScrollAtBottom(
        await readFleetScrollMetrics(page),
    )).toBe(true);
    const keyboard = await readFleetScrollMetrics(page);
    expectFleetScrollAtBottom('keyboard', keyboard);

    await resetFleetScrollOwner(fleet);
    const cdp = await page.context().newCDPSession(page);
    const x = workBounds.x + workBounds.width / 2;
    const startY = workBounds.y + workBounds.height - 24;
    const endY = workBounds.y + 48;
    let touch = await readFleetScrollMetrics(page);
    for (let gesture = 0; gesture < 120 && !fleetScrollAtBottom(touch); gesture += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x, y: startY }],
        });
        for (const y of [
            startY - (startY - endY) / 3,
            startY - 2 * (startY - endY) / 3,
            endY,
        ]) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ x, y }],
            });
        }
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        });
        touch = await readFleetScrollMetrics(page);
    }
    await cdp.detach();
    expectFleetScrollAtBottom('touch', touch);

    await test.info().attach('short-landscape-scroll-evidence', {
        body: Buffer.from(`${JSON.stringify({ wheel, keyboard, touch }, null, 2)}\n`),
        contentType: 'application/json',
    });
}

type FleetScrollMetrics = Awaited<ReturnType<typeof readFleetScrollMetrics>>;

async function resetFleetScrollOwner(fleet: Locator): Promise<void> {
    await fleet.evaluate(element => {
        element.scrollTop = 0;
    });
    await expect.poll(() => fleet.evaluate(element => element.scrollTop)).toBe(0);
}

async function readFleetScrollMetrics(page: Page) {
    return page.evaluate(() => {
        const measure = (element: Element | null) => {
            if (!(element instanceof HTMLElement)) throw new Error('Missing scroll owner');
            return {
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
                scrollTop: element.scrollTop,
                overflowY: getComputedStyle(element).overflowY,
            };
        };
        const workSurface = document.querySelector('[data-work-surface]');
        return {
            work: measure(workSurface),
            route: measure(workSurface?.querySelector(':scope > section') ?? null),
            workspace: measure(document.querySelector('[data-fleet-workspace]')),
        };
    });
}

function fleetScrollAtBottom(metrics: FleetScrollMetrics): boolean {
    return Math.abs(
        metrics.workspace.scrollTop -
        (metrics.workspace.scrollHeight - metrics.workspace.clientHeight),
    ) <= 1;
}

function expectFleetScrollAtBottom(
    input: 'keyboard' | 'touch' | 'wheel',
    metrics: FleetScrollMetrics,
): void {
    if (!fleetScrollAtBottom(metrics)) {
        throw new Error(`Short-landscape Fleet evidence is not ${input} reachable: ${JSON.stringify(metrics)}`);
    }
}

async function expectMapLayerTruth(
    map: Locator,
    label: string,
    truth: Readonly<{ enabled: boolean; text: string }>,
): Promise<void> {
    const layer = map.getByRole('heading', {
        exact: true,
        level: 3,
        name: label,
    }).locator('..');
    await expect(layer).toHaveAttribute(
        'data-layer-enabled',
        String(truth.enabled),
    );
    await expect(layer.getByText(truth.text, { exact: true })).toBeVisible();
}

async function tabToFleetRegion(
    page: Page,
    fleet: Locator,
    target: Locator,
): Promise<void> {
    const regionButtons = fleet.locator('#fleet-regions [data-fleet-region]');
    const targetIndex = await regionButtons.evaluateAll((buttons, targetRegion) =>
        buttons.findIndex(button =>
            button.getAttribute('data-fleet-region') === targetRegion
        ), await target.getAttribute('data-fleet-region'));
    if (targetIndex < 0) throw new Error('Target Fleet region is not in the current window.');
    const predecessor = targetIndex === 0
        ? fleet.getByRole('group', { name: 'Fleet regions window' })
            .getByRole('button', { name: 'Next' })
        : regionButtons.nth(targetIndex - 1);
    await predecessor.scrollIntoViewIfNeeded();
    await predecessor.focus();
    await page.keyboard.press('Tab');
    if (!await target.evaluate(element => element === document.activeElement)) {
        throw new Error('Tab did not reach the adjacent Fleet region control.');
    }
    await expect(target).toBeFocused();
}

async function expectWindow(
    root: Locator,
    label: string,
    range: string,
): Promise<void> {
    await expect(root.getByRole('group', { name: `${label} window` }))
        .toContainText(range);
}

async function traverseFleetWindow(input: Readonly<{
    root: Locator;
    label: string;
    items: Locator;
    ranges: readonly (readonly [range: string, count: number])[];
}>): Promise<void> {
    const group = input.root.getByRole('group', {
        name: `${input.label} window`,
    });
    const anchor = input.root.locator(
        `[data-fleet-window-focus-anchor="${input.label}"]`,
    );
    await expect(group).toContainText(input.ranges[0]![0]);
    await expect(input.items).toHaveCount(input.ranges[0]![1]);
    for (let index = 1; index < input.ranges.length; index += 1) {
        await group.getByRole('button', { name: 'Next' }).click();
        await expect(group).toContainText(input.ranges[index]![0]);
        await expect(input.items).toHaveCount(input.ranges[index]![1]);
    }
    await expect(anchor).toBeFocused();
    for (let index = input.ranges.length - 2; index >= 0; index -= 1) {
        await group.getByRole('button', { name: 'Previous' }).click();
        await expect(group).toContainText(input.ranges[index]![0]);
        await expect(input.items).toHaveCount(input.ranges[index]![1]);
    }
    await expect(anchor).toBeFocused();
}

async function refreshFleet(
    fleet: Locator,
    requestCount: () => number,
): Promise<void> {
    const before = requestCount();
    await fleet.getByLabel('Fleet recovery actions')
        .getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(requestCount).toBeGreaterThan(before);
}

async function expectFleetUrl(
    page: Page,
    expected: Readonly<Record<string, string>>,
): Promise<void> {
    await expect.poll(() => Object.fromEntries(
        Object.keys(expected).map(key => [
            key,
            new URL(page.url()).searchParams.get(key),
        ]),
    )).toEqual(expected);
}
