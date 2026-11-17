import {
    expect,
    test,
    type Page
} from '@playwright/test';

interface MobilePointerInput {
    readonly selector: string;
    readonly type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
    readonly pointerId: number;
    readonly offsetX: number;
    readonly offsetY: number;
}

test.describe('AR Eye Hunter mobile controls', () => {
    test('landscape mobile exposes dual-stick controls and updates input diagnostics', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name === 'iphone-portrait', 'Landscape control contract only.');

        await page.goto('/');
        const canvas = page.locator('canvas.arena-canvas');
        await expect(canvas).toBeVisible();
        await expect.poll(() => readCanvasDataset(page, 'arenaRuntimeReady')).toBe('true');
        await expect.poll(() => readCanvasDataset(page, 'arenaSize')).toBe('120');

        await expect(page.locator('.mobile-fps-controls')).toBeVisible();
        await expect(page.locator('.mobile-stick-zone')).toBeVisible();
        await expect(page.locator('.mobile-look-zone')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Fire' })).toBeVisible();
        await expect(page.locator('.mobile-rotate-prompt')).toBeHidden();

        await dispatchPointer(page, {
            selector: '.mobile-stick-zone',
            type: 'pointerdown',
            pointerId: 31,
            offsetX: 82,
            offsetY: 96
        });
        await dispatchPointer(page, {
            selector: '.mobile-stick-zone',
            type: 'pointermove',
            pointerId: 31,
            offsetX: 144,
            offsetY: 36
        });
        await expect.poll(() => readCanvasDataset(page, 'arenaTouchMoveActive')).toBe('true');
        await expect.poll(() => readCanvasDataset(page, 'arenaInputMode')).toMatch(/touch/);
        await expect.poll(() => readCanvasDataset(page, 'arenaMobileControls')).toBe('true');

        await dispatchPointer(page, {
            selector: '.mobile-look-zone',
            type: 'pointerdown',
            pointerId: 41,
            offsetX: 90,
            offsetY: 120
        });
        await dispatchPointer(page, {
            selector: '.mobile-look-zone',
            type: 'pointermove',
            pointerId: 41,
            offsetX: 150,
            offsetY: 104
        });
        await expect.poll(() => readCanvasDataset(page, 'arenaTouchLookActive')).toBe('true');

        const beforeEffects = Number(await readCanvasDataset(page, 'arenaEffectCount'));
        const beforeShot = Number(await readCanvasDataset(page, 'arenaShotSequence'));
        await dispatchPointer(page, {
            selector: '.mobile-action--fire',
            type: 'pointerdown',
            pointerId: 51,
            offsetX: 18,
            offsetY: 18
        });
        await expect.poll(async () => Number(await readCanvasDataset(page, 'arenaShotSequence'))).toBeGreaterThan(
            beforeShot
        );
        await expect.poll(async () => Number(await readCanvasDataset(page, 'arenaEffectCount'))).toBeGreaterThan(
            beforeEffects
        );
        await dispatchPointer(page, {
            selector: '.mobile-action--fire',
            type: 'pointerup',
            pointerId: 51,
            offsetX: 18,
            offsetY: 18
        });

        await dispatchPointer(page, {
            selector: '.mobile-stick-zone',
            type: 'pointerup',
            pointerId: 31,
            offsetX: 144,
            offsetY: 36
        });
        await dispatchPointer(page, {
            selector: '.mobile-look-zone',
            type: 'pointerup',
            pointerId: 41,
            offsetX: 150,
            offsetY: 104
        });
        await expect.poll(() => readCanvasDataset(page, 'arenaTouchMoveActive')).toBe('false');
        await expect.poll(() => readCanvasDataset(page, 'arenaTouchLookActive')).toBe('false');
    });

    test('portrait phone shows rotate prompt instead of combat controls', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'iphone-portrait', 'Portrait contract only.');

        await page.goto('/');
        await expect(page.locator('canvas.arena-canvas')).toBeVisible();
        await expect.poll(() => readCanvasDataset(page, 'arenaRuntimeReady')).toBe('true');
        await expect(page.locator('.mobile-rotate-prompt')).toBeVisible();
        await expect(page.locator('.mobile-fps-controls')).toBeHidden();
        await expect(page.getByText('Rotate for combat')).toBeVisible();
    });
});

async function readCanvasDataset(page: Page, key: string): Promise<string | undefined> {
    return page.locator('canvas.arena-canvas').evaluate(
        (canvas, datasetKey) => (canvas as HTMLCanvasElement).dataset[datasetKey],
        key
    );
}

async function dispatchPointer(page: Page, input: MobilePointerInput): Promise<void> {
    const { selector, type, pointerId, offsetX, offsetY } = input;
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
        clientY: box.y + offsetY
    });
}
