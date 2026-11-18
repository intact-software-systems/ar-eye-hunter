import { expect, type Page, type Request } from '@playwright/test';
import { socialViewReadPath } from './assert-idle-view-reads.ts';
import { signInRoomPlayer } from './room-player-journey.ts';

/** Authentication mounts social panels before the connection-recovery reads have finished. */
export async function signInIdleSocialPlayers(host: Page, guest: Page, game: 'arena' | 'relic'): Promise<void> {
    const pending = new Set<Request>();
    let lastActivityAt = Date.now();
    const started = (request: Request): void => {
        if (request.method() === 'GET' && socialViewReadPath.test(new URL(request.url()).pathname)) {
            pending.add(request);
            lastActivityAt = Date.now();
        }
    };
    const finished = (request: Request): void => {
        if (pending.delete(request)) {
            lastActivityAt = Date.now();
        }
    };
    host.on('request', started);
    host.on('requestfinished', finished);
    host.on('requestfailed', finished);
    try {
        await signInRoomPlayer(host, 'alice', game);
        await signInRoomPlayer(guest, 'bob', game);
        for (const player of [host, guest]) {
            await expect(player.getByRole('button', { name: 'Refresh sessions', exact: true })).toBeEnabled();
        }
        // Start a fresh quiet window after connection; old navigation idleness cannot prove this.
        lastActivityAt = Date.now();
        await expect.poll(() => pending.size === 0 && Date.now() - lastActivityAt >= 500, {
            message: 'connection-recovery social reads must settle before measuring idle reads'
        }).toBe(true);
    }
    finally {
        host.off('request', started);
        host.off('requestfinished', finished);
        host.off('requestfailed', finished);
    }
}
