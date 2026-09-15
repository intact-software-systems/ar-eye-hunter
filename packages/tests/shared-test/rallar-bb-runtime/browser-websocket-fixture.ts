import type { RallarBlackBoxBrowserWebSocket } from '../../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';

type BrowserWebSocketData = Parameters<RallarBlackBoxBrowserWebSocket['send']>[0];
type BrowserWebSocketListener = NonNullable<RallarBlackBoxBrowserWebSocket['onmessage']>;
type BrowserWebSocketEvent = Parameters<BrowserWebSocketListener>[0];

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
    readonly sent: BrowserWebSocketData[] = [];
    private readonly listeners = new Map<string, BrowserWebSocketListener[]>();

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

    addEventListener(type: string, listener: BrowserWebSocketListener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    removeEventListener(type: string, listener: BrowserWebSocketListener): void {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
    }

    send(data: BrowserWebSocketData): void {
        this.sent.push(data);
        this.bufferedAmount = this.options.bufferedAmountAfterSend ?? 0;
        if (this.options.echoMessages) {
            this.emit('message', { data });
        }
    }

    close(code?: number, reason?: string): void {
        this.closeCount += 1;
        this.readyState = 3;
        this.emit('close', { code, reason, wasClean: true });
    }

    private emit(type: string, event: BrowserWebSocketEvent): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}
