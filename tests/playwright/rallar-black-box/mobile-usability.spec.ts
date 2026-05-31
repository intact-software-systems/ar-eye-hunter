import { expect, test, type Page } from '@playwright/test';

async function expectNoDocumentHorizontalOverflow(page: Page): Promise<void> {
    const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));

    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test.describe('iPhone Max layout', () => {
    test.use({
        viewport: { width: 430, height: 932 },
        isMobile: true,
        hasTouch: true,
    });

    test('keeps direct Rallar command-center tabs usable without page-wide overflow', async ({ page }) => {
        await page.goto('/?provider=simulated&roomId=mobile-room&tab=quick-test');

        await expect(page.getByRole('tab', { name: 'Quick Test' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByLabel('Rallar Quick Test')).toBeVisible();
        await expect(page.getByText('Rallar Kit').first()).toBeVisible();
        await expect(page.getByLabel('Run state')).toBeHidden();
        await page.getByRole('button', { name: 'Show status' }).click();
        await expect(page.getByLabel('Run state')).toBeVisible();
        await expectNoDocumentHorizontalOverflow(page);

        await page.getByRole('button', { name: 'Hide Rallar Browser Trace' }).click();
        await expect(page.locator('.rallar-trace-summary')).toBeHidden();
        await page.getByRole('button', { name: 'Show Rallar Browser Trace' }).click();
        await expect(page.locator('.rallar-trace-summary')).toBeVisible();

        await page.getByRole('button', { name: 'Hide Direct Rallar Operations' }).click();
        await expect(page.locator('.direct-rallar-grid')).toBeHidden();
        await page.getByRole('button', { name: 'Show Direct Rallar Operations' }).click();
        await expect(page.locator('.direct-rallar-grid')).toBeVisible();

        await page.getByRole('button', { name: 'Hide Quick Test Info' }).click();
        await expect(page.locator('.quick-rallar-summary-grid')).toBeHidden();
        await page.getByRole('button', { name: 'Show Quick Test Info' }).click();
        await expect(page.locator('.quick-rallar-summary-grid')).toBeVisible();

        await page.getByRole('button', { name: 'Hide Quick Test Inputs' }).click();
        await expect(page.locator('.quick-rallar-context-grid')).toBeHidden();
        await page.getByRole('button', { name: 'Show Quick Test Inputs' }).click();
        await expect(page.locator('.quick-rallar-context-grid')).toBeVisible();

        const quickTestTabHeight = await page
            .getByRole('tab', { name: 'Quick Test' })
            .evaluate(element => element.getBoundingClientRect().height);
        expect(quickTestTabHeight).toBeGreaterThanOrEqual(44);

        await expect(page.getByLabel('Global Room')).toBeHidden();
        await page.getByRole('button', { name: 'Show values' }).click();
        await expect(page.getByLabel('Global Room')).toBeVisible();
        const globalRoomFontSize = await page
            .getByLabel('Global Room')
            .evaluate(element => Number.parseFloat(window.getComputedStyle(element).fontSize));
        expect(globalRoomFontSize).toBeGreaterThanOrEqual(16);
        await page.getByRole('button', { name: 'Hide values' }).click();
        await expect(page.getByLabel('Global Room')).toBeHidden();

        const tabChecks = [
            {
                tab: 'Groups/Clients',
                panel: '#panel-rooms-clients',
                text: 'Groups/Clients',
            },
            {
                tab: 'WebSocket',
                panel: '#panel-websocket',
                text: 'WS subscribed',
            },
            {
                tab: 'RTC/Realtimes',
                panel: '#panel-rtc-realtime',
                text: 'RTC message sub',
            },
            {
                tab: 'RTC Diagnostics',
                panel: '#panel-rtc-diagnostics',
                text: 'Time Series',
            },
            {
                tab: 'Rallar Server',
                panel: '#panel-rallar-server',
                text: 'Rallar Server',
            },
        ] as const;

        for (const check of tabChecks) {
            await page.getByRole('tab', { name: check.tab }).click();
            const panel = page.locator(check.panel);
            await expect(panel).toBeVisible();
            await expect(panel).toContainText(check.text);
            await expectNoDocumentHorizontalOverflow(page);
        }
    });
});
