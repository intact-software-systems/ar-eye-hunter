import { expect, type Page } from '@playwright/test';

export async function controlRoomConnection(page: Page, apiBaseUrl: string) {
    let cutConnection: (() => Promise<void>) | undefined;
    let disconnected = false;
    await page.routeWebSocket(url => url.host === new URL(apiBaseUrl).host, async socket => {
        if (disconnected) {
            await socket.close({ code: 1001 });
            return;
        }
        const server = socket.connectToServer();
        cutConnection = async () => {
            await Promise.all([socket.close({ code: 1001 }), server.close({ code: 1001 })]);
        };
    });
    return {
        async disconnect() {
            expect(cutConnection).toBeDefined();
            disconnected = true;
            await page.context().setOffline(true);
            await cutConnection!();
        },
        async reconnect() {
            disconnected = false;
            await page.context().setOffline(false);
        }
    };
}
