import { expect, test } from '@playwright/test';
import { TOWN_MATCH_BUILD } from '../../../apps/grumpy-town/src/match/match-protocol.ts';
import { decodeMatchWire, registerPlayer } from './match-browser.ts';

test('a friend sees reload guidance when the host sends a previous-build lobby', async ({ browser }) => {
    test.setTimeout(60000);
    const hostContext = await browser.newContext();
    const friendContext = await browser.newContext();
    let previousBuild = true;
    await friendContext.routeWebSocket(/\/api\/ws\//, socket => {
        const server = socket.connectToServer();
        server.onMessage(message => {
            if (previousBuild && decodeMatchWire(message)) {
                socket.send(String(message).replace(TOWN_MATCH_BUILD, 'grumpy-town-v6'));
            }
            else socket.send(message);
        });
    });
    try {
        const host = await hostContext.newPage();
        const friend = await friendContext.newPage();
        await registerPlayer(host, 'host-build-' + Date.now());
        await registerPlayer(friend, 'friend-build-' + Date.now());
        await host.getByRole('button', { name: 'Create town', exact: true }).click();
        await friend.getByLabel('Town code').fill(await host.getByLabel('Room code').inputValue());
        await friend.getByRole('button', { name: 'Join town', exact: true }).click();
        await expect(host.locator('#roster li')).toHaveCount(2);
        await host.getByRole('button', { name: 'Host match', exact: true }).click();
        await expect(friend.locator('#match-controls')).toContainText('Reload Grumpy Town on every device');
        await expect(friend.getByRole('button', { name: 'Ready', exact: true })).toHaveCount(0);
        await expect(host.locator('#match-controls')).toContainText('If a friend cannot ready up, reload Grumpy Town on their device.');
        previousBuild = false;
        await expect(friend.getByRole('button', { name: 'Ready', exact: true })).toBeEnabled({ timeout: 15000 });
        await expect(friend.locator('#match-controls')).not.toContainText('different game versions');
    }
    finally {
        await Promise.allSettled([hostContext.close(), friendContext.close()]);
    }
});
