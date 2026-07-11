import { expect, test } from '@playwright/test';

test('renders scoped shell geometry at every contract viewport', async ({ page }) => {
    const route = '/?provider=simulated&v=1&experience=recipe-console&view=';

    for (const contract of [
        { viewport: { width: 1440, height: 900 }, nav: 'rail', inspector: 'rail', command: 52, navSize: 184, inspectorSize: 352 },
        { viewport: { width: 900, height: 900 }, nav: 'compact-rail', inspector: 'overlay', command: 52, navSize: 64, inspectorSize: 360 },
        { viewport: { width: 430, height: 932 }, nav: 'bottom', inspector: 'sheet', command: 52, navSize: 64, inspectorSize: 0 },
        { viewport: { width: 932, height: 430 }, nav: 'compact-rail', inspector: 'overlay', command: 48, navSize: 60, inspectorSize: 320 },
    ] as const) {
        await page.setViewportSize(contract.viewport);
        await page.goto(`${route}${contract.viewport.height <= 520 ? 'tune' : 'execute'}`);
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
        if (contract.inspectorSize) {
            expect((await inspector.boundingBox())?.width).toBe(contract.inspectorSize);
        }
        if (contract.inspector === 'rail') {
            await expect(inspector).not.toHaveAttribute('role', 'dialog');
            await expect(inspector).not.toHaveAttribute('aria-modal', 'true');
        } else {
            await expect(inspector).toHaveAttribute('role', 'dialog');
            await expect(inspector).toHaveAttribute('aria-modal', 'true');
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
