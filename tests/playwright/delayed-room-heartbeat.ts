import { expect, type Page } from '@playwright/test';

/** Delivers overdue timers, verifies renewal without admission, then restores agreement with the live server clock. */
export async function renewRoomAfterDelayedCallbacks(page: Page, roomLink: string): Promise<void> {
    const fields = new URLSearchParams(new URL(roomLink).hash.slice('#rallar-room?'.length));
    const applicationId = fields.get('applicationId');
    const workspaceId = fields.get('workspaceId');
    const groupId = fields.get('groupId');
    if (!applicationId || !workspaceId || !groupId) {
        throw new Error('The created room must provide a complete scoped share link.');
    }
    const groupsPath = `/api/state/apps/${applicationId}/workspaces/${workspaceId}/groups`;
    const groupPath = `${groupsPath}/${groupId}`;
    const writes: string[] = [];
    page.on('request', (request) => {
        if (request.method() !== 'GET' && request.url().includes(groupPath)) {
            writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
        }
    });
    const recovery = page.waitForResponse((response) =>
        response.request().method() === 'GET' && new URL(response.url()).pathname === groupsPath
    );
    const renewal = page.waitForResponse((response) =>
        response.request().method() === 'POST' && response.url().includes(`${groupPath}/sessions/`) &&
        response.url().includes('/heartbeat/requests/')
    );
    // This expires browser snapshots while the real server lease stays live; it is not an OS suspension test.
    await page.clock.fastForward(65_000);
    const [recovered, renewed] = await Promise.all([recovery, renewal]);
    expect(recovered.ok()).toBe(true);
    expect(renewed.ok()).toBe(true);
    expect(writes.filter((write) => /\/join\/|PUT .*\/sessions\//.test(write))).toEqual([]);
    // Only the browser clock jumped. Subsequent timestamped game messages need wall-clock agreement again.
    await page.clock.setSystemTime(new Date());
    await page.clock.resume();
}
