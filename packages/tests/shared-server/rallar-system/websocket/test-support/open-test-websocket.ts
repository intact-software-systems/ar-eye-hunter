export function createOpenTestWebSocket(): WebSocket {
    return new OpenTestWebSocket();
}

class OpenTestWebSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = WebSocket.OPEN;
    readonly url = 'ws://rallar-test';
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;

    close(): void {}

    send(): void {}
}
