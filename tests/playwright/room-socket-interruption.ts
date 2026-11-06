import { expect, type Page, type WebSocket as ObservedSocket } from '@playwright/test';

/** Disconnects the real browser socket. Chromium offline mode alone leaves an established socket alive. */
export class RoomSocketInterruption {
    private readonly page: Page;
    private socket: ObservedSocket | undefined;

    private constructor(page: Page) {
        this.page = page;
        page.on('websocket', (socket) => {
            if (new URL(socket.url()).pathname.startsWith('/api/ws/')) {
                this.socket = socket;
            }
        });
    }

    static async install(page: Page): Promise<RoomSocketInterruption> {
        await page.addInitScript(() => {
            const NativeSocket = window.WebSocket;
            window.WebSocket = class extends NativeSocket {
                constructor(url: string | URL, protocols?: string | string[]) {
                    super(url, protocols);
                    if (new URL(this.url).pathname.startsWith('/api/ws/')) {
                        const disconnect = () => this.close(4001, 'test network interruption');
                        window.addEventListener('test-room-socket-loss', disconnect);
                        this.addEventListener(
                            'close',
                            () => window.removeEventListener('test-room-socket-loss', disconnect),
                            { once: true }
                        );
                    }
                }
            };
        });
        return new RoomSocketInterruption(page);
    }

    async disconnect(): Promise<void> {
        const socket = this.socket;
        expect(socket?.isClosed()).toBe(false);
        if (!socket) {
            throw new Error('The admitted spectator has no room socket');
        }
        const closed = socket.waitForEvent('close');
        // Let the real close handshake finish before preventing new connections.
        await this.page.evaluate(() => window.dispatchEvent(new Event('test-room-socket-loss')));
        await closed;
        await this.page.context().setOffline(true);
    }

    async reconnect(): Promise<void> {
        const connected = this.page.waitForEvent(
            'websocket',
            (socket) => new URL(socket.url()).pathname.startsWith('/api/ws/')
        )
            .then((socket) => socket.waitForEvent('framereceived'));
        await this.page.context().setOffline(false);
        await connected;
    }
}
