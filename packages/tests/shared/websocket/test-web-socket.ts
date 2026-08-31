export namespace TestWebSocket {
    export interface CloseDescription {
        readonly code: number | undefined;
        readonly reason: string | undefined;
    }
}

export class TestWebSocket extends EventTarget implements WebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: TestWebSocket[] = [];

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    onclose: WebSocket['onclose'] = null;
    onerror: WebSocket['onerror'] = null;
    onmessage: WebSocket['onmessage'] = null;
    onopen: WebSocket['onopen'] = null;
    readonly sent: string[] = [];
    readyState: WebSocket['readyState'] = TestWebSocket.CONNECTING;
    closedWith: TestWebSocket.CloseDescription | undefined;
    readonly url: string;

    constructor(url: string) {
        super();
        this.url = url;
        TestWebSocket.instances.push(this);
    }

    open(): void {
        this.readyState = TestWebSocket.OPEN;
        this.dispatchEvent(new Event('open'));
    }

    receive(text: string): void {
        this.dispatchEvent(new MessageEvent('message', { data: text }));
    }

    disconnect(code: number, reason: string): void {
        this.readyState = TestWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code, reason }));
    }

    override dispatchEvent(event: Event): boolean {
        const accepted = super.dispatchEvent(event);
        switch (event.type) {
            case 'open':
                this.onopen?.call(this, event);
                break;
            case 'error':
                this.onerror?.call(this, event);
                break;
            case 'message':
                if (event instanceof MessageEvent) {
                    this.onmessage?.call(this, event);
                }
                break;
            case 'close':
                if (event instanceof CloseEvent) {
                    this.onclose?.call(this, event);
                }
                break;
        }
        return accepted;
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data !== 'string') {
            throw new TypeError('The JSON transport must send text');
        }
        if (this.readyState === TestWebSocket.CONNECTING) {
            throw new DOMException('WebSocket is still connecting', 'InvalidStateError');
        }
        if (this.readyState === TestWebSocket.OPEN) {
            this.sent.push(data);
        }
    }

    close(code?: number, reason?: string): void {
        this.closedWith = { code, reason };
        this.readyState = TestWebSocket.CLOSED;
    }
}
