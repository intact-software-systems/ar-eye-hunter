import { expect, test, type Locator, type Page } from '@playwright/test';

import { observeBrowserWebGlContexts } from '../../../packages/shared-test/observe-browser-web-gl-contexts.ts';

import { initBrowserTestTransport, startRelicBrowserBackend } from './relic-browser-backend.ts';
import { createRelicSnapshotWithPlayers } from './relic-browser-snapshots.ts';

interface OpeningArtworkObservation {
    readonly decoded: boolean;
    readonly hasGateAndRelic: boolean;
}

test('shows decoded responsive gate artwork without allocating WebGL before room entry', async ({ page }) => {
    await page.addInitScript(observeBrowserWebGlContexts);
    await initBrowserTestTransport(page);
    await startRelicBrowserBackend(page, { rooms: [] });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible();
    // interaction: a decorative opening must not allocate a native graphics lifetime.
    expect(await page.locator('html').getAttribute('data-test-webgl-contexts')).toBeNull();
    const artwork = page.getByRole('img', { name: 'Relic Hunters opening scene', exact: true });
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1040, height: 680 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await expect(artwork).toBeVisible();
        await expect.poll(() => readOpeningArtwork(artwork)).toEqual({ decoded: true, hasGateAndRelic: true });
        await expect(artwork).toHaveCSS('object-fit', 'cover');
        await expect.poll(async () => (await artwork.boundingBox())?.width).toBe(viewport.width);
        expect(await artwork.boundingBox()).toEqual(await page.locator('.scene-layer').boundingBox());
        await page.screenshot({ path: test.info().outputPath(`opening-${viewport.width}x${viewport.height}.png`) });
        expect(await page.locator('html').getAttribute('data-test-webgl-contexts')).toBeNull();
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('opening-observer');
    await page.getByLabel('Display name', { exact: true }).fill('Opening Observer');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('opening-observer');
    expect(await readOpeningArtwork(artwork)).toEqual({ decoded: true, hasGateAndRelic: true });
    expect(await page.locator('html').getAttribute('data-test-webgl-contexts')).toBeNull();
    await artwork.evaluate((image: HTMLImageElement) => {
        const blank = document.createElement('canvas');
        blank.width = 1280;
        blank.height = 720;
        image.src = blank.toDataURL();
    });
    expect(await readOpeningArtwork(artwork)).toEqual({ decoded: true, hasGateAndRelic: false });
});

test('replaces opening artwork with an advancing native expedition on user room entry', async ({ page }) => {
    await page.addInitScript(observeBrowserWebGlContexts);
    await initBrowserTestTransport(page);
    await startRelicBrowserBackend(page, {
        rooms: [],
        relicSnapshot: createRelicSnapshotWithPlayers(1, 'planning')
    });
    await page.goto('/');
    const artwork = page.getByRole('img', { name: 'Relic Hunters opening scene', exact: true });
    await expect.poll(() => readOpeningArtwork(artwork)).toEqual({ decoded: true, hasGateAndRelic: true });
    await registerOpeningHunter(page);
    expect(await page.locator('html').getAttribute('data-test-webgl-contexts')).toBeNull();
    await page.getByRole('button', { name: 'New Room', exact: true }).click();
    const expedition = page.getByLabel('Relic Hunters neon cyber-dojo canvas', { exact: true });
    await expect(expedition).toHaveAttribute('data-scene-ready', 'true');
    await expect(artwork).toHaveCount(0);
    // interaction: only the actual expedition allocates a graphics context.
    await expect(page.locator('html')).toHaveAttribute('data-test-webgl-contexts', '1');
    const frame = await expedition.getAttribute('data-scene-render-count');
    await expect(expedition).not.toHaveAttribute('data-scene-render-count', frame!);
    await expect(page.getByRole('button', { name: /^Submit Plan/ })).toBeEnabled();
});

async function readOpeningArtwork(artwork: Locator): Promise<OpeningArtworkObservation> {
    return await artwork.evaluate(async (image: HTMLImageElement) => {
        await image.decode();
        const surface = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
        const context = surface.getContext('2d');
        if (!context) {
            throw new Error('Opening artwork analysis requires a 2D surface');
        }
        context.drawImage(image, 0, 0);
        let gate = 0;
        let relic = 0;
        for (let x = 1; x <= 7; x += 1) {
            for (let y = 1; y <= 5; y += 1) {
                const pixel = context.getImageData(
                    Math.floor(image.naturalWidth * (0.28 + x * 0.04)),
                    Math.floor(image.naturalHeight * (0.18 + y * 0.08)),
                    1,
                    1
                ).data;
                if (pixel[0] > 75 && pixel[1] > 35 && pixel[0] > pixel[1] * 1.1 && pixel[2] < pixel[0] * 0.75) {
                    gate += 1;
                }
                if (pixel[1] > 170 && pixel[2] > 170 && pixel[0] < 150 && pixel[1] - pixel[0] > 60) {
                    relic += 1;
                }
            }
        }
        return { decoded: image.complete && image.naturalWidth > 0, hasGateAndRelic: gate >= 3 && relic > 0 };
    });
}

async function registerOpeningHunter(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('opening-observer');
    await page.getByLabel('Display name', { exact: true }).fill('Opening Observer');
    await page.getByLabel('Password', { exact: true }).fill('correct-horse');
    await page.getByRole('button', { name: 'Create Hunter', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New Room', exact: true })).toBeVisible();
}
