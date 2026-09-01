// deno-lint-ignore-file no-explicit-any
import {
    toWsConnectionName,
    toWsFailureStatus,
    toWsSuccessStatus
} from '../ws/ws-wait-expectations.ts';

function toWsUrl(request: any): string | undefined {
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

function parseWsData(data: any): any {
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

function rememberWsMessage(connectionName: string, message: any, context: any): void {
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

export function openWs(interaction: any, config: any, context: any): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsConnectionName(request);
    const url = toWsUrl(request);

    if (!url) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket URL is missing'));
    }

    return new Promise((resolve) => {
        const ws = new WebSocket(url);
        const timeoutMs = Number.parseInt(request.timeoutMs || 5000);
        let settled = false;

        const resolveOnce = (result: any): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };

        const timeout = setTimeout(() => {
            resolveOnce(toWsFailureStatus(config, interaction, 'WebSocket connect timed out', {
                connection: connectionName,
                url,
                timeoutMs
            }));

            try {
                ws.close();
            }
            catch (_ignored) {
                // ignored
            }
        }, timeoutMs);

        ws.onopen = () => {
            context.wsConnections[connectionName] = ws;
            context.wsMessages[connectionName] = context.wsMessages[connectionName] || [];
            context.wsCloseEvents[connectionName] = context.wsCloseEvents[connectionName] || [];

            resolveOnce(toWsSuccessStatus(config, interaction, {
                connection: connectionName,
                url,
                readyState: ws.readyState
            }));
        };

        ws.onmessage = (event) => {
            rememberWsMessage(connectionName, {
                data: parseWsData(event.data),
                receivedAtEpochMs: Date.now()
            }, context);
        };

        ws.onclose = (event) => {
            rememberWsCloseEvent(connectionName, {
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean,
                closedAtEpochMs: Date.now()
            }, context);

            if (context.wsConnections[connectionName] === ws) {
                delete context.wsConnections[connectionName];
            }

            if (!settled) {
                resolveOnce(toWsFailureStatus(config, interaction, 'WebSocket closed before opening', {
                    connection: connectionName,
                    url,
                    code: event.code,
                    reason: event.reason,
                    wasClean: event.wasClean
                }));
            }
        };

        ws.onerror = (event) => {
            resolveOnce(toWsFailureStatus(config, interaction, 'WebSocket connection failed', {
                connection: connectionName,
                url,
                eventType: event?.type,
                readyState: ws.readyState
            }));
        };
    });
}

export function closeWs(interaction: any, config: any, context: any): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsConnectionName(request);
    const ws = context.wsConnections[connectionName];
    const closeCode = request.closeCode !== undefined ? request.closeCode : request.code;
    const closeReason = request.closeReason !== undefined ? request.closeReason : request.reason;

    if (!ws) {
        return Promise.resolve(toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            closed: false,
            reason: 'WebSocket connection was not open'
        }));
    }

    try {
        if (closeCode !== undefined || closeReason !== undefined) {
            ws.close(closeCode, closeReason);
        }
        else {
            ws.close();
        }

        delete context.wsConnections[connectionName];

        return Promise.resolve(toWsSuccessStatus(config, interaction, {
            connection: connectionName,
            closeRequested: true,
            closed: true,
            closeCode,
            closeReason
        }));
    }
    catch (e) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'Failed to close WebSocket connection', {
            connection: connectionName,
            closeCode,
            closeReason,
            exception: e instanceof Error ? e.message : String(e)
        }));
    }
}
