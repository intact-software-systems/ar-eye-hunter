import { JsonWebSocketClient } from '@shared/websocket/JsonWebSocketClient.ts';

export interface NativeWebSocketClose {
    readonly code: number | undefined;
    readonly reason: string | undefined;
}

export class SimulatedWebSocket extends EventTarget implements WebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static readonly instances: SimulatedWebSocket[] = [];
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly protocol = '';
    readonly extensions = '';
    readonly bufferedAmount = 0;
    readonly sent: string[] = [];
    binaryType: BinaryType = 'blob';
    readyState: WebSocket['readyState'] = SimulatedWebSocket.CONNECTING;
    onclose: WebSocket['onclose'] = null;
    onerror: WebSocket['onerror'] = null;
    onmessage: WebSocket['onmessage'] = null;
    onopen: WebSocket['onopen'] = null;
    closedWith: NativeWebSocketClose | undefined;
    private readonly listeners = new Map<string, Map<EventListenerOrEventListenerObject, EventListener>>();
    private readonly pendingCallbacks: Promise<void>[] = [];

    constructor(url: string) {
        super();
        this.url = url;
        SimulatedWebSocket.instances.push(this);
    }

    override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
        if (!listener) {
            return;
        }
        let listenersForType = this.listeners.get(type);
        if (!listenersForType) {
            listenersForType = new Map();
            this.listeners.set(type, listenersForType);
        }
        let delivery = listenersForType.get(listener);
        if (!delivery) {
            delivery = (event) => {
                const result = typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
                this.pendingCallbacks.push(Promise.resolve(result));
            };
            listenersForType.set(listener, delivery);
        }
        super.addEventListener(type, delivery, options);
    }

    override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
        if (!listener) {
            return;
        }
        const delivery = this.listeners.get(type)?.get(listener);
        if (delivery) {
            super.removeEventListener(type, delivery, options);
            this.listeners.get(type)?.delete(listener);
        }
    }

    async open(): Promise<void> {
        this.readyState = SimulatedWebSocket.OPEN;
        await this.deliver(new Event('open'));
    }

    async receive(data: string): Promise<void> {
        await this.deliver(new MessageEvent('message', { data }));
    }

    async fail(): Promise<void> {
        await this.deliver(new Event('error'));
    }

    async receiveClose(code: number, reason: string): Promise<void> {
        this.readyState = SimulatedWebSocket.CLOSED;
        await this.deliver(new CloseEvent('close', { code, reason }));
    }

    close(code?: number, reason?: string): void {
        this.closedWith = { code, reason };
        this.readyState = SimulatedWebSocket.CLOSED;
    }

    send(data: Parameters<WebSocket['send']>[0]): void {
        if (this.readyState !== SimulatedWebSocket.OPEN) {
            throw new Error('Native WebSocket is not open');
        }
        if (typeof data !== 'string') {
            throw new Error('Binary WebSocket sends are outside this fixture');
        }
        this.sent.push(data);
    }

    private async deliver(event: Event): Promise<void> {
        if (event instanceof MessageEvent) {
            await this.onmessage?.call(this, event);
        }
        else if (event instanceof CloseEvent) {
            await this.onclose?.call(this, event);
        }
        else if (event.type === 'open') {
            await this.onopen?.call(this, event);
        }
        else if (event.type === 'error') {
            await this.onerror?.call(this, event);
        }
        this.dispatchEvent(event);
        await Promise.all(this.pendingCallbacks.splice(0));
    }
}

export async function openConnectingWebSocket(client: JsonWebSocketClient, connecting: Promise<void>): Promise<SimulatedWebSocket> {
    await Promise.resolve();
    const native = client.ws;
    if (!(native instanceof SimulatedWebSocket)) {
        throw new Error('Expected the installed native WebSocket fixture');
    }
    await native.open();
    await connecting;
    return native;
}
