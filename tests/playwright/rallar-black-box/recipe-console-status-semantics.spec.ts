import { expect, test } from '@playwright/test';
import {
    installRecipeConsoleMonitorFixture,
    MONITOR_FAILURE_AGENT_ID,
    MONITOR_FAILURE_COMMAND_ID,
    MONITOR_FAILURE_CODE,
    MONITOR_FAILURE_MESSAGE,
    MONITOR_ROUTE,
} from './recipe-console-monitor-fixture.ts';

type Rgb = readonly [red: number, green: number, blue: number];

function parseCssRgb(value: string): Rgb {
    const match = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/u.exec(value);
    if (!match) throw new Error(`Unsupported CSS RGB color: ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance([red, green, blue]: Rgb): number {
    const linear = [red, green, blue].map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (linear[0] ?? 0) +
        0.7152 * (linear[1] ?? 0) +
        0.0722 * (linear[2] ?? 0);
}

function contrastRatio(first: Rgb, second: Rgb): number {
    const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
    const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
    return (lighter + 0.05) / (darker + 0.05);
}

function renderedContrast(first: string, second: string): number {
    return contrastRatio(parseCssRgb(first), parseCssRgb(second));
}

test('pairs every operational status with text and shape', async ({ page }) => {
    await page.goto('/test/fixtures/recipe-console-css-isolation.html?mode=recipe-console');
    const contracts = {
        running: { shape: 'notched-ring', part: 'notch', background: 'rgb(228, 245, 247)', foreground: 'rgb(6, 93, 107)', border: 'rgb(22, 128, 143)' },
        passed: { shape: 'check-circle', part: 'check', background: 'rgb(231, 245, 237)', foreground: 'rgb(20, 99, 63)', border: 'rgb(46, 129, 92)' },
        failed: { shape: 'x-octagon', part: 'x', background: 'rgb(252, 235, 237)', foreground: 'rgb(152, 31, 44)', border: 'rgb(195, 66, 79)' },
        warning: { shape: 'warning-triangle', part: 'mark', background: 'rgb(255, 242, 213)', foreground: 'rgb(119, 70, 0)', border: 'rgb(168, 102, 0)' },
        stale: { shape: 'clock', part: 'hands', background: 'rgb(238, 241, 244)', foreground: 'rgb(78, 89, 106)', border: 'rgb(112, 123, 140)' },
        partial: { shape: 'half-circle', part: 'fill', background: 'rgb(241, 235, 255)', foreground: 'rgb(89, 55, 154)', border: 'rgb(122, 85, 184)' },
        disabled: { shape: 'barred-square', part: 'bar', background: 'rgb(238, 241, 244)', foreground: 'rgb(97, 107, 121)', border: 'rgb(122, 132, 146)' },
    } as const;
    for (const [status, contract] of Object.entries(contracts)) {
        const mark = page.locator(`[data-status="${status}"]`);
        await expect(mark).toContainText(new RegExp(status, 'i'));
        await expect(mark.locator('[data-status-shape]')).toHaveCount(1);
        await expect(mark.locator('[data-status-shape]')).toHaveAttribute('data-shape', contract.shape);
        await expect(mark.locator(`[data-status-part="${contract.part}"]`)).toHaveCount(1);
        await expect(mark).toHaveCSS('background-color', contract.background);
        await expect(mark).toHaveCSS('color', contract.foreground);
        await expect(mark).toHaveCSS('border-top-color', contract.border);
        const rendered = await mark.evaluate(element => {
            const style = getComputedStyle(element);
            return {
                background: style.backgroundColor,
                border: style.borderTopColor,
                foreground: style.color,
            };
        });
        expect(
            renderedContrast(rendered.foreground, rendered.background),
            `${status} status text contrast is ${renderedContrast(rendered.foreground, rendered.background).toFixed(3)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
            renderedContrast(rendered.border, rendered.background),
            `${status} status border contrast is ${renderedContrast(rendered.border, rendered.background).toFixed(3)}:1`,
        ).toBeGreaterThanOrEqual(3);
    }
    await expect(page.locator('[data-status="failed"]')).toHaveCSS('border-left-width', '4px');

    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=execute');
    const primaryNavigation = page.locator('[data-primary-navigation]');
    const selectedNavigation = primaryNavigation.locator(
        'button[aria-current="page"]',
    );
    await selectedNavigation.focus();
    await expect(selectedNavigation).toHaveCSS('outline-style', 'solid');
    await expect(selectedNavigation).toHaveCSS('outline-width', '2px');
    const navigationColors = await selectedNavigation.evaluate(element => {
        const style = getComputedStyle(element);
        const navigationStyle = getComputedStyle(element.parentElement as HTMLElement);
        return {
            background: style.backgroundColor,
            border: style.borderTopColor,
            foreground: style.color,
            outline: style.outlineColor,
            surroundingBackground: navigationStyle.backgroundColor,
        };
    });
    expect(
        renderedContrast(
            navigationColors.foreground,
            navigationColors.background,
        ),
        'selected primary navigation text contrast',
    ).toBeGreaterThanOrEqual(4.5);
    expect(
        renderedContrast(navigationColors.border, navigationColors.background),
        'selected primary navigation border contrast',
    ).toBeGreaterThanOrEqual(3);
    expect(
        renderedContrast(
            navigationColors.outline,
            navigationColors.surroundingBackground,
        ),
        'selected primary navigation focus outline contrast',
    ).toBeGreaterThanOrEqual(3);
});

test('keeps empty stale and error states explicit without discarding evidence', async ({
    context,
    page,
}) => {
    const monitorFixture = await installRecipeConsoleMonitorFixture(context);
    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=analyze');
    const analyze = page.locator('[data-analyze-workspace]');
    const source = analyze.locator('[data-analyze-source]');
    await expect(analyze).toBeVisible();
    await expect(source).toBeVisible();
    await expect(source.getByText('Choose files', { exact: true })).toBeVisible();
    await expect(source.locator('[data-analyze-file-input]')).toBeAttached();
    const empty = page.locator('[data-state="empty"]');
    await expect(empty).toHaveAttribute('aria-live', 'polite');
    await expect(empty.getByRole('heading', {
        name: 'Import distributed-run evidence',
    })).toBeVisible();
    await expect(page.locator('[data-inspector-host]')).toHaveCount(0);

    await page.goto('/?provider=simulated&v=1&experience=recipe-console&view=fleet');
    await expect(page.locator('[data-analyze-workspace]')).toHaveCount(0);
    const partialFleet = page.locator('[data-fleet-operational-state="partial"]');
    const partialState = partialFleet.locator('[data-state="stale"]');
    await expect(partialState).toHaveAttribute('aria-live', 'polite');
    await expect(partialState.getByRole('heading', {
        name: 'Fleet evidence is partial',
    })).toBeVisible();
    await expect(partialState).toContainText(
        'Some root control collections are unavailable; supported evidence remains visible.',
    );
    await expect(partialState).toContainText('Fleet report collection unavailable.');
    await expect(partialFleet.locator('[data-fleet-retained-evidence]'))
        .toContainText(MONITOR_FAILURE_AGENT_ID);

    await page.goto(MONITOR_ROUTE);
    const verdict = page.locator('[data-monitor-section="verdict"]');
    const failure = page.locator(
        `[data-failure-key="${MONITOR_FAILURE_COMMAND_ID}"]`,
    );
    await expect(verdict).toHaveAttribute('aria-live', 'polite');
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(failure).toContainText(MONITOR_FAILURE_CODE);
    await expect(failure).toContainText(MONITOR_FAILURE_MESSAGE);
    const matrix = page.getByRole('region', { name: 'Agent by phase matrix' });
    await expect(matrix.getByText(MONITOR_FAILURE_AGENT_ID, { exact: true })).toBeVisible();

    monitorFixture.failNextRunRead();
    const readsBeforeFailure = monitorFixture.runRequestCount();
    const actions = page.getByRole('region', { name: 'Monitor actions' });
    await actions.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(monitorFixture.runRequestCount).toBeGreaterThan(readsBeforeFailure);

    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'last-known');
    await expect(verdict).toHaveAttribute('data-evidence-completeness', 'complete');
    await expect(verdict).toContainText('Last-known evidence — remote actions blocked');
    await expect(page.locator('[data-monitor-run-selector]'))
        .toContainText('Last-known truth');
    await expect(failure).toContainText(MONITOR_FAILURE_MESSAGE);
    await expect(matrix.getByText(MONITOR_FAILURE_AGENT_ID, { exact: true })).toBeVisible();

    monitorFixture.recoverRunReads();
    const readsBeforeRecovery = monitorFixture.runRequestCount();
    await actions.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(monitorFixture.runRequestCount).toBeGreaterThan(readsBeforeRecovery);
    await expect(verdict).toHaveAttribute('data-evidence-freshness', 'current');
    await expect(verdict).toContainText('Current complete evidence');
});
