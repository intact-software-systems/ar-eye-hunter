import { expect, test, type Locator } from '@playwright/test';
import {
    installRecipeConsoleMonitorFixture,
    MONITOR_FAILURE_AGENT_ID,
    MONITOR_FAILURE_COMMAND_ID,
    MONITOR_ROUTE,
} from './recipe-console-monitor-fixture.ts';

async function expectMinimumTargetHeight(locator: Locator, label: string): Promise<void> {
    await expect(locator.first(), `${label} should resolve a visible control`).toBeVisible();
    const count = await locator.count();
    expect(count, `${label} should resolve at least one control`).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
        const bounds = await locator.nth(index).boundingBox();
        expect(bounds, `${label} ${index + 1} should have rendered bounds`).not.toBeNull();
        if (bounds) {
            expect.soft(bounds.width, `${label} ${index + 1} target width`)
                .toBeGreaterThanOrEqual(44);
            expect.soft(bounds.height, `${label} ${index + 1} target height`)
                .toBeGreaterThanOrEqual(44);
        }
    }
}

test('renders scoped shell geometry at every contract viewport', async ({ page }) => {
    const route = '/?provider=simulated&v=1&experience=recipe-console&view=';

    for (const contract of [
        { viewport: { width: 1440, height: 900 }, nav: 'rail', inspector: 'rail', command: 52, navSize: 184, inspectorSize: 352 },
        { viewport: { width: 900, height: 900 }, nav: 'compact-rail', inspector: 'overlay', command: 52, navSize: 64, inspectorSize: 360 },
        { viewport: { width: 430, height: 932 }, nav: 'bottom', inspector: 'sheet', command: 52, navSize: 64, inspectorSize: 430 },
        { viewport: { width: 932, height: 430 }, nav: 'compact-rail', inspector: 'overlay', command: 48, navSize: 60, inspectorSize: 320 },
    ] as const) {
        await page.setViewportSize(contract.viewport);
        await page.goto(`${route}${contract.viewport.height <= 520 ? 'tune' : 'execute'}`);
        if (contract.viewport.height <= 520) {
            await expect(page.locator('[data-inspector-host]')).toHaveCount(0);
            const firstAgent = page.getByRole('gridcell', { name: /seed-agent-a/ });
            await firstAgent.focus();
            await page.keyboard.press('Enter');
            await expect(page.locator('[data-selected-agent]')).toHaveText('seed-agent-a');
        }
        const shell = page.locator('[data-recipe-console-shell]');
        await expect(shell).toHaveAttribute('data-navigation', contract.nav);
        await expect(shell).toHaveAttribute('data-inspector-mode', contract.inspector);
        await expect(page.locator('[data-command-bar]')).toHaveCSS('height', `${contract.command}px`);
        const navBox = await page.locator('[data-primary-navigation]').boundingBox();
        expect(contract.nav === 'bottom' ? navBox?.height : navBox?.width).toBe(contract.navSize);
        expect((await shell.boundingBox())?.height).toBe(contract.viewport.height);
        if (contract.nav === 'bottom') {
            expect((await page.locator('[data-selection-dock]').boundingBox())?.height).toBe(48);
        }
        const inspector = page.locator('[data-inspector-host]');
        const inspectorBox = await inspector.boundingBox();
        expect(inspectorBox?.width).toBe(contract.inspectorSize);
        if (contract.inspector === 'rail') {
            await expect(inspector).toHaveAttribute('role', 'complementary');
            await expect(inspector).not.toHaveAttribute('aria-modal', 'true');
        } else {
            await expect(inspector).toHaveAttribute('role', 'dialog');
            await expect(inspector).toHaveAttribute('aria-modal', 'true');
            expect((inspectorBox?.x ?? 0) + (inspectorBox?.width ?? 0)).toBe(contract.viewport.width);
            if (contract.inspector === 'sheet') {
                expect(inspectorBox?.x).toBe(0);
                expect((inspectorBox?.y ?? 0) + (inspectorBox?.height ?? 0))
                    .toBe(contract.viewport.height - 64);
            } else {
                expect(inspectorBox?.y).toBe(contract.command);
                expect((inspectorBox?.y ?? 0) + (inspectorBox?.height ?? 0))
                    .toBe(contract.viewport.height);
                expect((await page.locator('[data-work-surface]').boundingBox())?.width)
                    .toBe(contract.viewport.width - contract.navSize);
            }
        }
        const overflow = await page.evaluate(() => ({
            x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        }));
        expect(overflow).toEqual({ x: 0, y: 0 });

        if (contract.viewport.height <= 520) {
            const matrix = await page.locator('[data-landscape-matrix]').boundingBox();
            const divider = await page.locator('[data-landscape-divider]').boundingBox();
            const timing = await page.locator('[data-landscape-timing]').boundingBox();
            expect(divider?.width).toBe(12);
            expect((matrix?.width ?? 0) / ((matrix?.width ?? 0) + (timing?.width ?? 0)))
                .toBeCloseTo(0.52, 1);
        }
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(`${route}execute`);
    await expect(page.locator('[data-inspector-host]')).toHaveCSS('transition-duration', '0s');
});

test('keeps the 900px tablet inspector overlaid without squeezing work', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);

    const work = page.locator('[data-work-surface]');
    const before = await work.boundingBox();
    expect(before).not.toBeNull();
    expect(before?.x).toBe(64);
    expect(before?.width).toBe(836);
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);

    await page.locator(`[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`).click();
    const overlay = page.getByRole('dialog', { name: 'Inspector' });
    await expect(overlay).toHaveAttribute('data-mode', 'overlay');
    const after = await work.boundingBox();
    const overlayBounds = await overlay.boundingBox();
    expect(after).toEqual(before);
    expect(overlayBounds?.width).toBe(360);
    expect(overlayBounds?.x).toBe(540);
    expect(overlayBounds?.x ?? 900).toBeLessThan((after?.x ?? 0) + (after?.width ?? 0));
});

test('keeps short-landscape Monitor contained through a keyboard-only evidence path', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 932, height: 430 });
    const fixture = await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);

    const failure = page.locator(
        `[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`,
    );
    await failure.focus();
    await page.keyboard.press('Enter');
    const inspector = page.getByRole('dialog', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole('button', { name: 'Close inspector' }))
        .toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(inspector.getByRole('link', {
        name: 'Open this run in legacy Runs',
    })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
    await expect(failure).toBeFocused();

    const matrix = page.locator('[data-monitor-matrix-scroller]');
    expect(await matrix.evaluate(element => element.scrollWidth > element.clientWidth))
        .toBe(true);
    expect(await page.evaluate(() => ({
        x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }))).toEqual({ x: 0, y: 0 });

    fixture.setRunState('running');
    const actions = page.getByRole('region', { name: 'Monitor actions' });
    const refresh = actions.getByRole('button', { name: 'Refresh', exact: true });
    await refresh.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-monitor-section="verdict"]'))
        .toHaveAttribute('data-run-state', 'running');

    const arm = actions.getByRole('button', { name: 'Arm Cancel', exact: true });
    await arm.focus();
    await page.keyboard.press('Enter');
    await expect(actions.getByRole('button', { name: 'Cancel armed', exact: true }))
        .toBeFocused();
    const cancel = actions.getByRole('button', { name: 'Cancel run', exact: true });
    await cancel.focus();
    await page.keyboard.press('Space');
    const cancelDialog = page.getByRole('alertdialog', {
        name: 'Cancel distributed run?',
    });
    await expect(cancelDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cancelDialog).toHaveCount(0);
    await expect(cancel).toBeFocused();
    expect(await page.evaluate(() => ({
        x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }))).toEqual({ x: 0, y: 0 });
});

test('moves Tune matrix focus with every arrow without activating inspection', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=tune');

    const agentA = page.getByRole('gridcell', { name: /seed-agent-a/ });
    const agentB = page.getByRole('gridcell', { name: /seed-agent-b/ });
    const agentC = page.getByRole('gridcell', { name: /seed-agent-c/ });
    await agentA.focus();
    await page.keyboard.press('ArrowRight');
    await expect(agentB).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(agentC).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(agentA).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(agentC).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(agentB).toBeFocused();
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);

    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Inspector' })).toBeVisible();
    await expect(page.locator('[data-selected-agent]')).toHaveText('seed-agent-b');
});

test('keeps representative portrait touch controls at least 44px high', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=execute');
    await expectMinimumTargetHeight(
        page.locator('[data-command-bar] button'),
        'Execute command-bar button',
    );
    await expectMinimumTargetHeight(
        page.locator('[data-primary-navigation] button'),
        'primary navigation button',
    );
    await expectMinimumTargetHeight(
        page.getByRole('searchbox', { name: 'Search recipes' }),
        'recipe search',
    );
    await expectMinimumTargetHeight(
        page.getByRole('region', { name: 'Recipe ledger' }).locator('button'),
        'recipe row',
    );
    await expectMinimumTargetHeight(
        page.locator('[data-execute-manifest] summary'),
        'manifest summary',
    );
    await expectMinimumTargetHeight(
        page.locator('[data-execute-action-band] button'),
        'Execute action',
    );

    await page.goto(MONITOR_ROUTE);
    await expectMinimumTargetHeight(
        page.getByRole('region', { name: 'Monitor actions' }).locator('button'),
        'Monitor action',
    );
    const monitorActionOrder = await page
        .getByRole('region', { name: 'Monitor actions' })
        .locator('[data-monitor-action]')
        .evaluateAll(buttons => buttons.map(button => ({
            label: button.textContent?.trim() ?? '',
            left: button.getBoundingClientRect().left,
        })));
    expect(monitorActionOrder.map(action => action.label)).toEqual(
        ['Refresh', 'Cancel run', 'Load artifact', 'Export artifact'],
    );
    expect(monitorActionOrder.map(action => action.label)).toEqual(
        [...monitorActionOrder]
            .sort((left, right) => left.left - right.left)
            .map(action => action.label),
    );
    await expectMinimumTargetHeight(
        page.locator('[data-failure-key]'),
        'Monitor failure control',
    );
    await expectMinimumTargetHeight(
        page.locator('[data-monitor-section="timeline"] summary'),
        'Monitor timeline summary',
    );
    await expectMinimumTargetHeight(
        page.locator('[data-selection-dock] button'),
        'portrait selection-dock button',
    );

    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=tune');
    await expectMinimumTargetHeight(
        page.locator('[data-tune-agent]'),
        'Tune agent row',
    );
    await expectMinimumTargetHeight(
        page.getByRole('group', { name: 'Timing metric' }).locator('button'),
        'Tune timing segment',
    );

    for (const view of ['analyze', 'fleet', 'advanced']) {
        await page.goto(
            `/?provider=simulated&v=1&experience=recipe-console&view=${view}`,
        );
        await expectMinimumTargetHeight(
            page.locator('[data-command-bar] button'),
            `${view} command-bar button`,
        );
        await expectMinimumTargetHeight(
            page.locator('[data-primary-navigation] button'),
            `${view} primary navigation button`,
        );
    }
    await expectMinimumTargetHeight(
        page.locator('[data-preview-view="advanced"] a'),
        'Advanced compatibility link',
    );

    const navigationButtons = page.locator('[data-primary-navigation] button');
    const navigationBounds = await navigationButtons.evaluateAll(buttons =>
        buttons.map(button => {
            const bounds = button.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right };
        })
    );
    for (let index = 1; index < navigationBounds.length; index += 1) {
        expect(
            navigationBounds[index].left - navigationBounds[index - 1].right,
            `portrait navigation gap ${index}`,
        ).toBeGreaterThanOrEqual(8);
    }
});

test('reserves the portrait selection dock only for actionable evidence', async ({
    context,
    page,
}) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE.replace('view=monitor', 'view=analyze'));
    await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'analyze');
    await expect(page.getByRole('heading', { level: 1, name: 'Analyze' })).toBeVisible();
    await expect(page.locator('[data-selection-dock]')).toHaveCount(0);

    const workBounds = await page.locator('[data-work-surface]').boundingBox();
    const navigationBounds = await page.locator('[data-primary-navigation]').boundingBox();
    expect(workBounds).not.toBeNull();
    expect(navigationBounds).not.toBeNull();
    expect((workBounds?.y ?? 0) + (workBounds?.height ?? 0))
        .toBe(navigationBounds?.y);

    await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    const dock = page.locator('[data-selection-dock]');
    await expect(dock).toBeVisible();
    await expect(dock).toContainText(`Failure · ${MONITOR_FAILURE_AGENT_ID}`);
    await dock.getByRole('button', { name: 'Inspect' }).click();
    await expect(page.getByRole('dialog', { name: 'Inspector' })).toHaveCount(1);
});

test('disables Recipe Console motion when reduced motion is requested', async ({
    context,
    page,
}) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 900 });
    await installRecipeConsoleMonitorFixture(context);
    await page.goto(MONITOR_ROUTE);
    await page.locator(`[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`).click();

    const overlay = page.getByRole('dialog', { name: 'Inspector' });
    await expect(overlay).toHaveCSS('transition-duration', '0s');
    await expect(overlay).toHaveCSS('animation-name', 'none');
    await expect(page.getByRole('button', { name: 'Close inspector' }))
        .toHaveCSS('transition-duration', '0s');
});

test('renders all six views without relevant console warnings or errors', async ({ page }) => {
    const diagnostics: string[] = [];
    await page.route(
        /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/,
        route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ runs: [], distributedRuns: [] }),
        }),
    );
    page.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') {
            diagnostics.push(`${message.type()}: ${message.text()}`);
        }
    });
    page.on('pageerror', error => diagnostics.push(`pageerror: ${error.message}`));

    for (const view of ['execute', 'monitor', 'analyze', 'tune', 'fleet', 'advanced']) {
        await page.goto(
            `/?provider=simulated&v=1&experience=recipe-console&view=${view}`,
        );
        await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', view);
        await page.evaluate(() => new Promise<void>(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
    }

    expect(diagnostics).toEqual([]);
});

test('uses roving keyboard navigation without activating focus-only keys', async ({ page }) => {
    for (const contract of [
        { viewport: { width: 1440, height: 900 }, presentation: 'rail', activate: 'Enter' },
        { viewport: { width: 430, height: 932 }, presentation: 'bottom', activate: 'Space' },
    ] as const) {
        await page.setViewportSize(contract.viewport);
        await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=execute');

        const navigation = page.getByRole('navigation', { name: 'Recipe Console' });
        const items = navigation.getByRole('button');
        const execute = navigation.getByRole('button', { name: 'Execute' });
        const advanced = navigation.getByRole('button', { name: 'Advanced' });
        await expect(navigation).toHaveAttribute('data-presentation', contract.presentation);
        await expect(items).toHaveCount(6);
        expect(await items.evaluateAll(buttons => buttons.map(button => button.tabIndex)))
            .toEqual([0, -1, -1, -1, -1, -1]);
        await expect(execute).toHaveAttribute('aria-current', 'page');

        await execute.focus();
        for (const [key, focused] of [
            ['ArrowLeft', advanced],
            ['ArrowRight', execute],
            ['ArrowUp', advanced],
            ['ArrowDown', execute],
            ['End', advanced],
            ['Home', execute],
            ['End', advanced],
        ] as const) {
            await page.keyboard.press(key);
            await expect(focused).toBeFocused();
            await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'execute');
            expect(new URL(page.url()).searchParams.get('view')).toBe('execute');
            await expect(execute).toHaveAttribute('aria-current', 'page');
        }

        expect(await items.evaluateAll(buttons => buttons.map(button => button.tabIndex)))
            .toEqual([-1, -1, -1, -1, -1, 0]);
        await page.keyboard.press(contract.activate);
        await expect(page.locator('.recipe-console')).toHaveAttribute('data-view', 'advanced');
        expect(new URL(page.url()).searchParams.get('view')).toBe('advanced');
        await expect(advanced).toHaveAttribute('aria-current', 'page');
        await expect(execute).not.toHaveAttribute('aria-current', 'page');
        expect(await items.evaluateAll(buttons => buttons.map(button => button.tabIndex)))
            .toEqual([-1, -1, -1, -1, -1, 0]);
    }
});
