import { expect, test } from '@playwright/test';

test.describe('AR Eye Hunter mobile controls', () => {
    test('landscape mobile exposes dual-stick controls and updates input diagnostics', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name === 'iphone-portrait', 'Landscape control contract only.');

        await page.goto('/');
        const canvas = page.locator('canvas.arena-canvas');
        await expect(canvas).toBeVisible();
        await expect.poll(() => canvasDataset(page, 'arenaRuntimeReady')).toBe('true');
        await expect.poll(() => canvasDataset(page, 'arenaSize')).toBe('120');

        await expect(page.locator('.mobile-fps-controls')).toBeVisible();
        await expect(page.locator('.mobile-stick-zone')).toBeVisible();
        await expect(page.locator('.mobile-look-zone')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Fire' })).toBeVisible();
        await expect(page.locator('.mobile-rotate-prompt')).toBeHidden();

        await dispatchPointer(page, '.mobile-stick-zone', 'pointerdown', 31, 82, 96);
        await dispatchPointer(page, '.mobile-stick-zone', 'pointermove', 31, 144, 36);
        await expect.poll(() => canvasDataset(page, 'arenaTouchMoveActive')).toBe('true');
        await expect.poll(() => canvasDataset(page, 'arenaInputMode')).toMatch(/touch/);
        await expect.poll(() => canvasDataset(page, 'arenaMobileControls')).toBe('true');

        await dispatchPointer(page, '.mobile-look-zone', 'pointerdown', 41, 90, 120);
        await dispatchPointer(page, '.mobile-look-zone', 'pointermove', 41, 150, 104);
        await expect.poll(() => canvasDataset(page, 'arenaTouchLookActive')).toBe('true');

        const beforeEffects = Number(await canvasDataset(page, 'arenaEffectCount'));
        await dispatchPointer(page, '.mobile-action--fire', 'pointerdown', 51, 18, 18);
        await page.waitForTimeout(180);
        await dispatchPointer(page, '.mobile-action--fire', 'pointerup', 51, 18, 18);
        await expect.poll(async () =>
            Number(await canvasDataset(page, 'arenaEffectCount'))
        ).toBeGreaterThan(beforeEffects);

        await dispatchPointer(page, '.mobile-stick-zone', 'pointerup', 31, 144, 36);
        await dispatchPointer(page, '.mobile-look-zone', 'pointerup', 41, 150, 104);
        await expect.poll(() => canvasDataset(page, 'arenaTouchMoveActive')).toBe('false');
        await expect.poll(() => canvasDataset(page, 'arenaTouchLookActive')).toBe('false');
    });

    test('portrait phone shows rotate prompt instead of combat controls', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'iphone-portrait', 'Portrait contract only.');

        await page.goto('/');
        await expect(page.locator('canvas.arena-canvas')).toBeVisible();
        await expect.poll(() => canvasDataset(page, 'arenaRuntimeReady')).toBe('true');
        await expect(page.locator('.mobile-rotate-prompt')).toBeVisible();
        await expect(page.locator('.mobile-fps-controls')).toBeHidden();
        await expect(page.getByText('Rotate for combat')).toBeVisible();
    });
});

async function canvasDataset(page: import('@playwright/test').Page, key: string): Promise<string | undefined> {
    return page.locator('canvas.arena-canvas').evaluate((canvas, datasetKey) =>
        (canvas as HTMLCanvasElement).dataset[datasetKey],
    key);
}

async function dispatchPointer(
    page: import('@playwright/test').Page,
    selector: string,
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    pointerId: number,
    offsetX: number,
    offsetY: number,
): Promise<void> {
    const box = await page.locator(selector).boundingBox();
    if (!box) {
        throw new Error(`Missing pointer target: ${selector}`);
    }
    await page.locator(selector).dispatchEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: pointerId === 31,
        button: 0,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        clientX: box.x + offsetX,
        clientY: box.y + offsetY,
    });
}
