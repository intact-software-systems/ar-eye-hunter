// deno-lint-ignore-file no-explicit-any
import {
    toWsConnectionName,
    toWsFailureStatus,
    toWsSuccessStatus,
    waitForWsClose,
    waitForWsMessage,
    waitForWsMessageAbsence,
    waitForWsMessages
} from '../ws/ws-wait-expectations.ts';
import {
    closeWs,
    openWs,
    toWsSocketState
} from './local-websocket-session.ts';

interface ToWsSendResultInput {
    readonly status: string;
    readonly ws: any;
    readonly connectionName: string;
    readonly wirePayload: string;
    readonly details?: any;
}

function toWsSendResult(input: ToWsSendResultInput): any {
    const { status, ws, connectionName, wirePayload, details = {} } = input;
    return {
        status,
        connection: connectionName,
        ...toWsSocketState(ws),
        wirePayload,
        wirePayloadLength: wirePayload.length,
        ...details
    };
}

function sendWs(interaction: any, config: any, context: any): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsConnectionName(request);
    const ws = context.wsConnections[connectionName];

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket connection is not open', {
            connection: connectionName,
            ...toWsSocketState(ws)
        }));
    }

    const payload = request.send !== undefined
        ? request.send
        : request.message !== undefined
        ? request.message
        : request.body;

    const wirePayload = typeof payload === 'string'
        ? payload
        : JSON.stringify(payload !== undefined ? payload : {});

    const sendStartedAtEpochMs = Date.now();
    try {
        ws.send(wirePayload);
    }
    catch (e) {
        const sendFailedAtEpochMs = Date.now();
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket send failed', {
            connection: connectionName,
            sent: payload,
            sendResult: toWsSendResult({
                status: 'failed',
                ws,
                connectionName,
                wirePayload,
                details: {
                    exception: e instanceof Error ? e.message : String(e)
                }
            }),
            sendStartedAtEpochMs,
            sendFailedAtEpochMs,
            sendLatencyMs: sendFailedAtEpochMs - sendStartedAtEpochMs,
            exception: e instanceof Error ? e.message : String(e)
        }));
    }

    const sendEndedAtEpochMs = Date.now();
    const sendResult = toWsSendResult({ status: 'sent', ws, connectionName, wirePayload });
    const details = {
        sentConnection: connectionName,
        sent: payload,
        sendResult,
        sendStartedAtEpochMs,
        sendEndedAtEpochMs,
        sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs
    };

    if (interaction.response?.messages) {
        return waitForWsMessages(interaction, config, context, details);
    }

    if (interaction.response?.message) {
        return waitForWsMessage(interaction, config, context, details);
    }

    return Promise.resolve(toWsSuccessStatus(config, interaction, {
        connection: connectionName,
        ...details
    }));
}

export function executeLocalWsInteraction(interaction: any, config: any, context: any): Promise<any> {
    const action = interaction.request.action || 'send';

    if (action === 'connect' || action === 'open') {
        return openWs(interaction, config, context);
    }

    if (action === 'send') {
        return sendWs(interaction, config, context);
    }

    if (action === 'wait' || action === 'expect') {
        if (interaction.response?.absent !== undefined) {
            return waitForWsMessageAbsence({ interaction, config, context });
        }

        if (interaction.response?.close !== undefined) {
            return waitForWsClose(interaction, config, context);
        }

        if (interaction.response?.messages) {
            return waitForWsMessages(interaction, config, context);
        }

        if (interaction.response?.message) {
            return waitForWsMessage(interaction, config, context);
        }

        return Promise.resolve(
            toWsFailureStatus(
                config,
                interaction,
                'WebSocket wait expects expect.message, expect.messages, expect.absent, or expect.close'
            )
        );
    }

    if (action === 'close') {
        return closeWs(interaction, config, context);
    }

    return Promise.resolve(toWsFailureStatus(config, interaction, 'Unsupported WebSocket action: ' + action));
}
