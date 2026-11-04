import { expect, type Page } from '@playwright/test';
import { observeBrowserWebGlContexts } from '../../../packages/shared-test/observe-browser-web-gl-contexts.ts';
import { tournamentBrowserTest } from '../tournament-browser-fixture.ts';
import {
    recoverTournamentFromHistory,
    registerTournament,
    startTournamentMatch,
    tournamentMatch
} from '../tournament-journey.ts';
import { playRelicTournament } from './tournament-native-play.ts';

tournamentBrowserTest(
    'four accounts play both semifinals and a final with native scores and bracket advancement',
    async ({ page, players }) => {
        tournamentBrowserTest.skip(
            process.env.RELIC_HUNTERS_FULL_STACK !== '1',
            'Requires the native game server and SPA.'
        );
        // Four-account setup, three native matches and champion recovery share this budget.
        // Individual actions and recovery assertions keep their own shorter deadlines.
        tournamentBrowserTest.setTimeout(900000);
        for (const player of players) {
            await player.addInitScript(observeBrowserWebGlContexts);
        }
        const title = await registerTournament(players, 'relic');
        const champion = await page.getByRole('region', { name: 'Tournaments', exact: true })
            .locator('ol li').first().innerText();
        for (
            const [slot, winner, opponent] of [
                ['semifinal-1', players[0], players[1]],
                ['semifinal-2', players[2], players[3]],
                ['final', players[0], players[2]]
            ] as const
        ) {
            await startTournamentMatch(page, [winner, opponent], slot);
            await expectRenderingAdvances(winner);
            if (slot === 'semifinal-1') {
                await tournamentMatch(players[2], slot).getByRole('button', {
                    name: 'Watch tournament match',
                    exact: true
                }).click();
                await expect(
                    players[2].getByLabel('Current turn summary', { exact: true }).getByText('Watching', {
                        exact: true
                    })
                ).toBeVisible();
                await expectRenderingAdvances(players[2]);
            }
            await playRelicTournament(winner, opponent);
            await expectTerminalSceneSettles(winner);
            await expectTerminalSceneSettles(opponent);
            if (slot === 'semifinal-1') {
                await expect(players[2].locator('.victory-panel')).toBeVisible();
                await expectTerminalSceneSettles(players[2]);
            }
            const winnerId = await winner.locator('.victory-panel h2').innerText();
            await expect(tournamentMatch(page, slot)).toContainText(`Winner: ${winnerId} · score`, {
                timeout: 30000
            });
        }
        await expect(page.getByRole('status').filter({ hasText: `Champion: ${champion}` })).toBeVisible();
        await recoverTournamentFromHistory(page, 'relic', title);
        await expect(page.getByRole('status').filter({ hasText: `Champion: ${champion}` })).toBeVisible();
    }
);

tournamentBrowserTest(
    'cancels a playing tournament and returns both competitors to the bracket',
    async ({ players }) => {
        tournamentBrowserTest.skip(
            process.env.RELIC_HUNTERS_FULL_STACK !== '1',
            'Requires the native game server and SPA.'
        );
        tournamentBrowserTest.setTimeout(180000);
        for (const player of players) {
            await player.addInitScript(observeBrowserWebGlContexts);
        }
        await registerTournament(players, 'relic');
        await startTournamentMatch(players[0], [players[0], players[1]], 'semifinal-1');
        const ownerCanvas = players[0].getByLabel('Relic Hunters neon cyber-dojo canvas', { exact: true });
        await players[0].getByRole('button', { name: 'First-person view', exact: true }).click();
        await expect(ownerCanvas).toHaveAttribute('data-camera-mode', 'first-person');
        const panel = players[0].getByRole('region', { name: 'Tournaments', exact: true });
        await panel.getByRole('button', { name: 'Cancel tournament', exact: true }).click();
        await panel.getByRole('button', { name: 'Confirm cancel tournament', exact: true }).click();
        for (const player of [players[0], players[1]]) {
            await expect(player.getByRole('alert').filter({ hasText: 'This tournament match was cancelled.' }))
                .toBeVisible();
            await expect(player.getByRole('button', { name: /^Submit Plan/ })).toHaveCount(0);
            await expect(player.getByRole('button', { name: 'Pick Up', exact: true })).toHaveCount(0);
            const bracket = player.getByRole('region', { name: 'Tournaments', exact: true });
            await expect(bracket.getByText('Tournament cancelled', { exact: true })).toBeVisible();
            await expect(bracket.getByRole('button', { name: 'New tournament', exact: true })).toBeEnabled();
            await expect(bracket.getByText(/^Champion:/)).toHaveCount(0);
        }
        await expectTerminalSceneSettles(players[0]);
        await expectTerminalSceneSettles(players[1]);
        await expect(ownerCanvas).toHaveAttribute('data-scene-first-person-rig', 'true');
        await expect(ownerCanvas).toHaveAttribute('data-scene-local-avatar-visible', 'false');
        await players[0].getByRole('button', { name: 'Overview view', exact: true }).click();
        await expect(ownerCanvas).toHaveAttribute('data-scene-first-person-rig', 'false');
        await expect(ownerCanvas).toHaveAttribute('data-scene-local-avatar-visible', 'true');
        await expectTerminalSceneSettles(players[0]);
    }
);

async function expectRenderingAdvances(page: Page): Promise<void> {
    const canvas = page.getByLabel('Relic Hunters neon cyber-dojo canvas', { exact: true });
    await expect(canvas).toHaveAttribute('data-scene-ready', 'true');
    const stamp = await canvas.getAttribute('data-scene-render-count');
    await expect(canvas).not.toHaveAttribute('data-scene-render-count', stamp!);
}

async function expectTerminalSceneSettles(page: Page): Promise<void> {
    const canvas = page.getByLabel('Relic Hunters neon cyber-dojo canvas', { exact: true });
    await expect(canvas).toHaveAttribute('data-scene-ready', 'true');
    const contexts = await page.locator('html').getAttribute('data-test-webgl-contexts');
    await expect(async () => {
        await expect(canvas).toHaveAttribute('data-scene-ready', 'true');
        const stamp = await canvas.getAttribute('data-scene-render-count');
        expect(stamp).not.toBeNull();
        await page.waitForTimeout(1800);
        expect(await canvas.getAttribute('data-scene-render-count'), 'native terminal rendering must idle').toBe(stamp);
        const animations = await page.evaluate(() =>
            document.getAnimations()
                .filter((animation) => animation.playState === 'running')
                .map((animation) => ({
                    name: animation instanceof CSSAnimation ? animation.animationName : animation.id,
                    iterations: animation.effect?.getTiming().iterations
                }))
        );
        expect(animations, 'native terminal presentation animations must settle').toEqual([]);
    }).toPass({ timeout: 15000 });
    const stamp = await canvas.getAttribute('data-scene-render-count');
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const previousWidth = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
    await page.setViewportSize({ width: viewport!.width - 80, height: viewport!.height - 40 });
    await expect(canvas).not.toHaveAttribute('data-scene-render-count', stamp!);
    await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).not.toBe(previousWidth);
    await expect(async () => {
        const resizedStamp = await canvas.getAttribute('data-scene-render-count');
        await page.waitForTimeout(3500);
        expect(await canvas.getAttribute('data-scene-render-count'), 'resized terminal image must settle across polls')
            .toBe(resizedStamp);
    }).toPass({ timeout: 15000 });
    await expect(page.locator('html')).toHaveAttribute('data-test-webgl-contexts', contexts!);
    await expectTerminalPixels(page);
    await page.setViewportSize(viewport!);
}

async function expectTerminalPixels(page: Page): Promise<void> {
    const image = await page.getByLabel('Relic Hunters neon cyber-dojo canvas', { exact: true }).evaluate(
        (canvas: HTMLCanvasElement) => {
            const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
            if (!gl) {
                throw new Error('The terminal scene must retain its WebGL context.');
            }
            const colors = new Set<string>();
            const pixel = new Uint8Array(4);
            for (let x = 1; x <= 7; x += 1) {
                for (let y = 1; y <= 5; y += 1) {
                    gl.readPixels(
                        Math.floor(gl.drawingBufferWidth * x / 8),
                        Math.floor(gl.drawingBufferHeight * y / 6),
                        1,
                        1,
                        gl.RGBA,
                        gl.UNSIGNED_BYTE,
                        pixel
                    );
                    colors.add(`${pixel[0]},${pixel[1]},${pixel[2]}`);
                }
            }
            return {
                colors: colors.size,
                activeMeshes: Number(canvas.dataset.sceneActiveMeshCount),
                ready: canvas.dataset.sceneReady
            };
        }
    );
    expect(image.ready).toBe('true');
    expect(image.activeMeshes).toBeGreaterThan(0);
    expect(image.colors, 'the final idle image must contain rendered geometry, not a uniform clear color')
        .toBeGreaterThan(2);
}
