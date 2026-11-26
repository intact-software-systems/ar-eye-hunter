import { expect, test } from '@playwright/test';

import { decodeMatchWire, startTownMatch } from './match-browser.ts';
import { installGrumpyTownRtcTrial } from './match-rtc-browser.ts';

for (const initialTransport of ['rtc', 'ws'] as const) {
    test(`live controls and host poses use ${initialTransport} without waiting for checkpoint agreement`, async ({ browser }) => {
        test.setTimeout(60000);
        const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
        for (const context of contexts) {
            await context.addInitScript(installGrumpyTownRtcTrial);
            if (initialTransport === 'ws') {
                await context.addInitScript(() => window.__grumpyTownRtcTrial.setBlocked(true));
            }
        }
        const [host, guest] = await Promise.all(contexts.map((context) => context.newPage()));
        let holdCheckpoints = false;
        let checkpointWithheld = false;
        await contexts[1].routeWebSocket(/\/api\/ws\//, (socket) => {
            const server = socket.connectToServer();
            server.onMessage((message) => {
                const frame = decodeMatchWire(message);
                if (holdCheckpoints && frame && ['proposal', 'commit'].includes(frame.action.kind)) {
                    checkpointWithheld = true;
                    return;
                }
                socket.send(message);
            });
        });
        try {
            await startTownMatch([host, guest]);
            await expect(guest.locator('#online-game')).toHaveAttribute('data-pose-transport', initialTransport, {
                timeout: 10000
            });
            await expect(host.locator('#online-game')).toHaveAttribute('data-input-transport', initialTransport, {
                timeout: 10000
            });
            if (initialTransport === 'rtc') {
                for (const page of [host, guest]) {
                    expect(await page.evaluate(() => window.__grumpyTownRtcTrial.received)).toBeGreaterThan(0);
                }
            }
            const initialGuestX = Number(await guest.locator('#online-game').getAttribute('data-x'));
            await guest.keyboard.down('KeyD');
            await expect.poll(async () => Number(await host.locator('#online-game').getAttribute('data-peer-x')))
                .toBeGreaterThan(initialGuestX + 0.3);
            await guest.keyboard.up('KeyD');
            // Start the partition immediately after a fresh agreement. This gives the guest its full recovery window.
            const previous = Number(await guest.locator('#online-game').getAttribute('data-tick'));
            await expect.poll(async () => Number(await guest.locator('#online-game').getAttribute('data-tick')), {
                intervals: [20]
            }).toBeGreaterThan(previous);
            holdCheckpoints = true;
            // Measure the live channel from the injected delivery fault, once the route has actually withheld agreement.
            await expect.poll(() => checkpointWithheld, { timeout: 1000, intervals: [20] }).toBe(true);
            const tick = Number(await guest.locator('#online-game').getAttribute('data-tick'));
            const before = Number(await guest.locator('#online-game').getAttribute('data-render-peer-x'));
            await host.keyboard.down('KeyD');
            await Promise.all([
                expect.poll(
                    async () => Number(await guest.locator('#online-game').getAttribute('data-pose-tick')) - tick,
                    { timeout: 1000, intervals: [20] }
                ).toBeGreaterThan(9),
                expect.poll(
                    async () => Number(await guest.locator('#online-game').getAttribute('data-render-peer-x')),
                    { timeout: 1000, intervals: [20] }
                ).toBeGreaterThan(before + 0.1)
            ]);
            await host.keyboard.up('KeyD');
            expect(Number(await guest.locator('#online-game').getAttribute('data-tick'))).toBe(tick);
            expect(Number(await guest.locator('#online-game').getAttribute('data-pose-tick'))).toBeGreaterThan(
                tick + 6
            );
            holdCheckpoints = false;
            if (initialTransport === 'rtc') {
                await Promise.all(
                    [host, guest].map((page) => page.evaluate(() => window.__grumpyTownRtcTrial.setBlocked(true)))
                );
                await expect(guest.locator('#online-game')).toHaveAttribute('data-pose-transport', 'ws', {
                    timeout: 5000
                });
                await expect(host.locator('#online-game')).toHaveAttribute('data-input-transport', 'ws', {
                    timeout: 5000
                });
            }
            // Resume from a confirmed checkpoint before sending fresh input back towards spawn.
            await expect.poll(async () => Number(await guest.locator('#online-game').getAttribute('data-tick')))
                .toBeGreaterThan(tick);
            const hostGame = host.locator('#online-game');
            const guestX = Number(await hostGame.getAttribute('data-peer-x'));
            await guest.keyboard.down('KeyA');
            await expect.poll(async () => Number(await hostGame.getAttribute('data-peer-x')))
                .toBeLessThan(guestX - 0.3);
            await guest.keyboard.up('KeyA');
            await guest.getByRole('button', { name: 'Dash and drop', exact: true }).tap();
            await expect(guest.locator('#online-game')).toHaveAttribute('data-dashes', '1');
            await guest.screenshot({ path: test.info().outputPath(`live-${initialTransport}-phone.png`) });
        }
        finally {
            holdCheckpoints = false;
            await Promise.allSettled(contexts.map((context) => context.close()));
        }
    });
}
