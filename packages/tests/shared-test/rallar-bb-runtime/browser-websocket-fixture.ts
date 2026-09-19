import type {
    RallarBlackBoxBrowserWebSocket,
    RallarBlackBoxBrowserWebSocketData,
    RallarBlackBoxBrowserWebSocketEvent,
    RallarBlackBoxBrowserWebSocketListener
} from '../../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';

export namespace BrowserWebSocketFixture {
    export interface Options {
        readonly echoMessages?: boolean;
        readonly bufferedAmountAfterSend?: number;
    }
}

/** Owns browser socket event delivery and observable resource effects for adapter tests. */
export class BrowserWebSocketFixture implements RallarBlackBoxBrowserWebSocket {
    readonly protocol = '';
    readyState = 0;
    bufferedAmount = 0;
    closeCount = 0;
    readonly sent: RallarBlackBoxBrowserWebSocketData[] = [];
    private readonly listeners = new Map<string, RallarBlackBoxBrowserWebSocketListener[]>();

    readonly url: string;
    private readonly options: BrowserWebSocketFixture.Options;

    constructor(url: string, options: BrowserWebSocketFixture.Options = {}) {
        this.url = url;
        this.options = options;
        queueMicrotask(() => {
            this.readyState = 1;
            this.emit('open', {});
        });
    }

    addEventListener(type: string, listener: RallarBlackBoxBrowserWebSocketListener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    removeEventListener(type: string, listener: RallarBlackBoxBrowserWebSocketListener): void {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
    }

    send(data: RallarBlackBoxBrowserWebSocketData): void {
        this.sent.push(data);
        this.bufferedAmount = this.options.bufferedAmountAfterSend ?? 0;
        if (this.options.echoMessages) {
            // Inbound DOM message data is text, a Blob or an ArrayBuffer, never a view onto one.
            this.emit('message', { data: ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer : data });
        }
    }

    close(code?: number, reason?: string): void {
        this.closeCount += 1;
        this.readyState = 3;
        this.emit('close', { code, reason, wasClean: true });
    }

    private emit(type: string, event: RallarBlackBoxBrowserWebSocketEvent): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}
