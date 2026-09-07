import { toWsConnectionName, toWsFailureStatus, toWsSuccessStatus } from '../ws/ws-interaction-statuses.ts';
import {
    waitForWsClose,
    waitForWsMessage,
    waitForWsMessageAbsence,
    waitForWsMessageCount,
    waitForWsMessages,
    type WsInteraction,
    type WsInteractionResult,
    type WsWaitInput
} from '../ws/ws-wait-expectations.ts';
import {
    closeWs,
    openWs,
    toWsSocketState,
    type LocalWsContext,
    type LocalWsSocketState
} from './local-websocket-session.ts';

interface WsSendObservation extends LocalWsSocketState {
    readonly status: 'sent' | 'failed';
    readonly connection: string;
    readonly wirePayload: string;
    readonly wirePayloadLength: number;
    readonly exception?: string;
}

interface WsSendDetails {
    readonly sentConnection: string;
    readonly sent: unknown;
    readonly sendResult: WsSendObservation;
    readonly sendStartedAtEpochMs: number;
    readonly sendEndedAtEpochMs: number;
    readonly sendLatencyMs: number;
}

interface LocalWsInput extends Omit<WsWaitInput, 'context'> {
    readonly context: LocalWsContext;
}

function sendWsFrame(input: LocalWsInput, ws: WebSocket): WsSendDetails {
    const request = input.interaction.request;
    const payload = request.send !== undefined
        ? request.send
        : request.message !== undefined
        ? request.message
        : request.body;
    const wirePayload = typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? {} : payload);
    const connectionName = toWsConnectionName(request);
    const sendStartedAtEpochMs = Date.now();
    let exception: string | undefined;
    try {
        ws.send(wirePayload);
    }
    catch (error) {
        exception = error instanceof Error ? error.message : String(error);
    }
    const sendEndedAtEpochMs = Date.now();
    return {
        sentConnection: connectionName,
        sent: payload,
        sendStartedAtEpochMs,
        sendEndedAtEpochMs,
        sendLatencyMs: sendEndedAtEpochMs - sendStartedAtEpochMs,
        sendResult: {
            status: exception === undefined ? 'sent' : 'failed',
            connection: connectionName,
            ...toWsSocketState(ws),
            wirePayload,
            wirePayloadLength: wirePayload.length,
            ...(exception === undefined ? {} : { exception })
        }
    };
}

function sendWs(input: LocalWsInput): Promise<WsInteractionResult> {
    const { interaction, config, context } = input;
    const connectionName = toWsConnectionName(interaction.request);
    const ws = context.wsConnections[connectionName];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket connection is not open', {
            connection: connectionName,
            ...toWsSocketState(ws)
        }));
    }
    const details = sendWsFrame(input, ws);
    if (details.sendResult.status === 'failed') {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket send failed', {
            ...details,
            connection: connectionName,
            sendFailedAtEpochMs: details.sendEndedAtEpochMs,
            exception: details.sendResult.exception
        }));
    }
    if (interaction.response?.count !== undefined) {
        return waitForWsMessageCount({ ...input, details: { ...details }, observeCloseEvents: true });
    }
    if (interaction.response?.messages) {
        return waitForWsMessages({ ...input, details: { ...details } });
    }
    if (interaction.response?.message) {
        return waitForWsMessage({ ...input, details: { ...details } });
    }
    return Promise.resolve(toWsSuccessStatus(config, interaction, { connection: connectionName, ...details }));
}

export function executeLocalWsInteraction(
    interaction: WsInteraction,
    config: unknown,
    context: LocalWsContext
): Promise<unknown> {
    const action = interaction.request.action || 'send';
    if (action === 'connect' || action === 'open') {
        return openWs(interaction, config, context);
    }
    if (action === 'send') {
        return sendWs({ interaction, config, context });
    }
    if (action === 'close') {
        return closeWs(interaction, config, context);
    }
    if (action !== 'wait' && action !== 'expect') {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'Unsupported WebSocket action: ' + action));
    }
    if (interaction.response?.absent !== undefined) {
        return waitForWsMessageAbsence({ interaction, config, context });
    }
    if (interaction.response?.count !== undefined) {
        return waitForWsMessageCount({ interaction, config, context, observeCloseEvents: true });
    }
    if (interaction.response?.close !== undefined) {
        return waitForWsClose({ interaction, config, context });
    }
    if (interaction.response?.messages) {
        return waitForWsMessages({ interaction, config, context });
    }
    if (interaction.response?.message) {
        return waitForWsMessage({ interaction, config, context });
    }
    return Promise.resolve(
        toWsFailureStatus(
            config,
            interaction,
            'WebSocket wait expects expect.message, expect.messages, expect.count, expect.absent, or expect.close'
        )
    );
}
