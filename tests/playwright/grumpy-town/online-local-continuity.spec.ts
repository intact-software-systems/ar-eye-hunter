import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

import { decodeMatchWire, startTownMatch } from './match-browser.ts';

interface LocalMotionSample {
    readonly at: number;
    readonly x: number;
    readonly tick: number;
    readonly poseTick: number;
}

test('local movement and dash stay responsive while live poses lead checkpoint agreement', async ({ browser }) => {
    test.setTimeout(60000);
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    const [host, guest] = await Promise.all(contexts.map((context) => context.newPage()));
    let delayCheckpoints = false;
    const pending = new Set<ReturnType<typeof setTimeout>>();
    await contexts[1].routeWebSocket(/\/api\/ws\//, (socket) => {
        const server = socket.connectToServer();
        server.onMessage((message) => {
            const frame = decodeMatchWire(message);
            if (delayCheckpoints && frame && ['proposal', 'commit'].includes(frame.action.kind)) {
                const timer = setTimeout(() => {
                    pending.delete(timer);
                    socket.send(message);
                }, 200);
                pending.add(timer);
            }
            else {
                socket.send(message);
            }
        });
    });
    try {
        await startTownMatch([host, guest]);
        await expect(guest.locator('#online-game')).toHaveAttribute('data-pose-transport', 'rtc', { timeout: 10000 });
        delayCheckpoints = true;
        await guest.keyboard.down('KeyD');
        const samples = await guest.locator('#online-game').evaluate((root) =>
            new Promise<LocalMotionSample[]>((resolve) => {
                const observations: LocalMotionSample[] = [];
                const started = performance.now();
                const observe = (): void => {
                    observations.push({
                        at: performance.now() - started,
                        x: Number(root.getAttribute('data-render-x')),
                        tick: Number(root.getAttribute('data-tick')),
                        poseTick: Number(root.getAttribute('data-pose-tick'))
                    });
                    if (performance.now() - started >= 700) {
                        resolve(observations);
                    }
                    else {
                        requestAnimationFrame(observe);
                    }
                };
                requestAnimationFrame(observe);
            })
        );
        await guest.keyboard.up('KeyD');
        await writeFile(test.info().outputPath('local-continuity.json'), JSON.stringify({ samples }));
        await guest.getByRole('button', { name: 'Dash and drop', exact: true }).tap({ timeout: 500 });
        const dashRendered = await guest.locator('#online-game').getAttribute('data-render-dashes');
        await writeFile(test.info().outputPath('local-continuity.json'), JSON.stringify({ samples, dashRendered }));
        expect(samples.at(-1)!.poseTick - samples.at(-1)!.tick).toBeGreaterThan(6);
        expect(samples.at(-1)!.x - samples[0].x).toBeGreaterThan(1.7);
        expect(samples.filter((sample, index) => index > 0 && sample.x > samples[index - 1].x + 0.001).length)
            .toBeGreaterThan(samples.length * 0.7);
        await expect(guest.locator('#online-game')).toHaveAttribute('data-render-pranks', '1', { timeout: 200 });
        await expect(guest.getByRole('button', { name: 'Dash and drop', exact: true })).toBeDisabled();
        await expect(guest.locator('#dash')).toContainText('WAIT');
        delayCheckpoints = false;
        await expect(guest.locator('#online-game')).toHaveAttribute('data-pranks', '1');
        await expect(guest.getByRole('button', { name: 'Dash and drop', exact: true })).toBeEnabled({ timeout: 5000 });
        await guest.getByRole('button', { name: 'Dash and drop', exact: true }).tap();
        await expect(guest.locator('#online-game')).toHaveAttribute('data-render-pranks', '2', { timeout: 200 });
        await expect(guest.locator('#online-game')).toHaveAttribute('data-pranks', '2');
    }
    finally {
        delayCheckpoints = false;
        pending.forEach(clearTimeout);
        await Promise.allSettled(contexts.map((context) => context.close()));
    }
});
