import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

export class PGliteTestSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = WebSocket.OPEN;
    readonly url = 'ws://pglite-test.invalid';
    binaryType: BinaryType = 'blob';
    onclose: ((this: WebSocket, event: CloseEvent) => void) | null = null;
    onerror: ((this: WebSocket, event: Event) => void) | null = null;
    onmessage: ((this: WebSocket, event: MessageEvent) => void) | null = null;
    onopen: ((this: WebSocket, event: Event) => void) | null = null;
    private readonly messageListeners = new Set<EventListenerOrEventListenerObject>();

    override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: AddEventListenerOptions | boolean
    ): void {
        if (type === 'message' && callback !== null) {
            this.messageListeners.add(callback);
            return;
        }
        super.addEventListener(type, callback, options);
    }

    override removeEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: EventListenerOptions | boolean
    ): void {
        if (type === 'message' && callback !== null) {
            this.messageListeners.delete(callback);
            return;
        }
        super.removeEventListener(type, callback, options);
    }

    close(): void {}

    send(): void {}

    async dispatchMessage(message: ALMessage): Promise<void> {
        const event = new MessageEvent('message', { data: JSON.stringify(message) });
        for (const listener of this.messageListeners) {
            if (typeof listener === 'function') {
                await listener.call(this, event);
            }
            else {
                await listener.handleEvent(event);
            }
        }
        await this.onmessage?.call(this, event);
    }
}
