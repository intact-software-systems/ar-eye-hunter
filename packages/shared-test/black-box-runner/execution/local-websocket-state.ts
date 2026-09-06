// deno-lint-ignore-file no-explicit-any

export function toWsUrl(request: any): string | undefined {
    return request.url || request.path;
}

function toWsReadyStateName(readyState: any): string {
    if (readyState === WebSocket.CONNECTING) {
        return 'CONNECTING';
    }
    if (readyState === WebSocket.OPEN) {
        return 'OPEN';
    }
    if (readyState === WebSocket.CLOSING) {
        return 'CLOSING';
    }
    if (readyState === WebSocket.CLOSED) {
        return 'CLOSED';
    }

    return 'UNKNOWN';
}

export function toWsSocketState(ws: any): any {
    if (!ws) {
        return {
            readyState: undefined,
            readyStateName: 'MISSING'
        };
    }

    return {
        readyState: ws.readyState,
        readyStateName: toWsReadyStateName(ws.readyState),
        bufferedAmount: typeof ws.bufferedAmount === 'number'
            ? ws.bufferedAmount
            : undefined
    };
}

export function parseWsData(data: any): any {
    if (typeof data !== 'string') {
        return data;
    }

    try {
        return JSON.parse(data);
    }
    catch (_ignored) {
        return data;
    }
}

export function rememberWsMessage(connectionName: string, message: any, context: any): void {
    if (!context.wsMessages[connectionName]) {
        context.wsMessages[connectionName] = [];
    }

    context.wsMessages[connectionName].push(message);
}

export function rememberWsCloseEvent(connectionName: string, closeEvent: any, context: any): void {
    if (!context.wsCloseEvents[connectionName]) {
        context.wsCloseEvents[connectionName] = [];
    }

    context.wsCloseEvents[connectionName].push(closeEvent);
}
