// deno-lint-ignore-file no-explicit-any
import {
    rememberRtcCloseEvent,
    rememberRtcDiagnostic,
    rememberRtcMessage,
    toRtcConnectionName,
    toRtcExpectedConnectionName,
    toRtcFailureStatus,
    toRtcSuccessStatus,
    waitForRtcClose,
    waitForRtcDiagnostic,
    waitForRtcDiagnostics,
    waitForRtcHealth,
    waitForRtcMessage,
    waitForRtcMessageAbsence,
    waitForRtcMessageCount,
    waitForRtcMessages,
    type RtcWaitInput
} from './rtc/rtc-wait-expectations.ts';

export interface RtcProvider {
    connect: (interaction: any, config: any, context: any) => Promise<any>;
    send: (interaction: any, config: any, context: any) => Promise<any>;
    wait: (interaction: any, config: any, context: any) => Promise<any>;
    close: (interaction: any, config: any, context: any) => Promise<any>;
    command?: (interaction: any, config: any, context: any) => Promise<any>;
}

export interface RtcClient {
    connect: () => Promise<void>;
    send: (message: any, interaction?: any) => Promise<any>;
    command?: (action: string, request: any) => Promise<any>;
    close: (interaction?: any, config?: any, context?: any) => Promise<void>;
    onMessage?: (handler: (message: any) => void) => void;
    onClose?: (handler: (event: any) => void) => void;
    diagnostics?: () => any;
}

export interface RtcClientProviderOptions {
    createClient: (request: any, config?: any, context?: any) => Promise<RtcClient> | RtcClient;
}

interface RtcClientObservation {
    readonly interaction: any;
    readonly context: any;
    readonly connectionName: string;
}

interface RtcClientSendFailureInput {
    readonly config: any;
    readonly interaction: any;
    readonly connectionName: string;
    readonly payload: any;
    readonly sendStartedAtEpochMs: number | undefined;
    readonly sendFailedAtEpochMs: number;
    readonly error: unknown;
}

interface RtcClientOutcomeFailure {
    readonly code: string;
    readonly message: string;
}

interface RtcClientSendRecord {
    readonly startedAtEpochMs: number;
    readonly endedAtEpochMs: number;
    readonly sendResult: unknown;
    readonly diagnostics: unknown;
}

interface RtcSentMessageDetails {
    readonly sentConnection: string;
    readonly sent: unknown;
    readonly sendResult: unknown;
    readonly sendStartedAtEpochMs: number | undefined;
    readonly sendEndedAtEpochMs: number | undefined;
    readonly sendLatencyMs: number | undefined;
    readonly diagnostics: unknown;
}

interface RtcSendWaitInput extends RtcWaitInput {
    readonly details: RtcSentMessageDetails;
}

export function toRtcPayload(request: any): any {
    return request.send !== undefined
        ? request.send
        : request.message !== undefined
        ? request.message
        : request.body;
}

export function toRtcDeliveredMessages(request: any): any[] {
    const explicitDeliveredMessages = request.deliverMessages !== undefined
        ? request.deliverMessages
        : request.deliver;

    if (explicitDeliveredMessages !== undefined) {
        return Array.isArray(explicitDeliveredMessages)
            ? explicitDeliveredMessages
            : [explicitDeliveredMessages];
    }

    const payload = toRtcPayload(request);
    return payload !== undefined
        ? [payload]
        : [];
}

export function toRtcDeliverTargets(interaction: any): string[] {
    const explicitTarget = interaction.request.deliverTo !== undefined
        ? interaction.request.deliverTo
        : interaction.request.to;

    const expectedTarget = interaction.response?.connection !== undefined
        ? interaction.response.connection
        : interaction.response?.onConnection;

    const targets = explicitTarget !== undefined
        ? Array.isArray(explicitTarget) ? explicitTarget : [explicitTarget]
        : expectedTarget !== undefined
        ? [expectedTarget]
        : [];

    return targets.map(String);
}

function toStoredRtcCloseEvent(event: any, interaction: any, atEpochMs: number): any {
    const eventFields = event && typeof event === 'object' && !Array.isArray(event)
        ? event
        : { value: event };

    return {
        ...eventFields,
        event,
        closedAtEpochMs: atEpochMs,
        provider: interaction.request.provider,
        actor: interaction.request.actor,
        roomId: interaction.request.roomId
    };
}

function isRtcDiagnosticMessage(message: any): boolean {
    return message?.kind === 'diagnostic';
}

function toStoredRtcDiagnostic(message: any, observation: RtcClientObservation, atEpochMs: number): any {
    const { interaction, connectionName } = observation;
    return {
        kind: 'diagnostic',
        topic: message.topic,
        severity: message.severity ?? (message.error ? 'error' : 'info'),
        atEpochMs: message.atEpochMs ?? atEpochMs,
        connection: message.connection ?? connectionName,
        provider: message.provider ?? interaction.request.provider,
        actor: message.actor ?? interaction.request.actor,
        peerId: message.peerId ?? interaction.request.peerId,
        remotePeerId: message.remotePeerId ?? interaction.request.remotePeerId,
        roomId: message.roomId ?? interaction.request.roomId,
        roomRef: message.roomRef ?? interaction.request.roomRef,
        scope: message.scope ?? interaction.request.scope,
        applicationId: message.applicationId ?? interaction.request.applicationId,
        workspaceId: message.workspaceId ?? interaction.request.workspaceId,
        groupId: message.groupId ?? interaction.request.groupId,
        overlayId: message.overlayId ?? interaction.request.overlayId,
        data: message.data,
        error: message.error,
        event: message
    };
}

function registerRtcClientObservations(client: RtcClient, observation: RtcClientObservation): void {
    client.onMessage?.((message) =>
        writeRtcClientMessageObservation(message, observation, observation.context.dependencies.now())
    );
    client.onClose?.((event) => {
        const closeEvent = toStoredRtcCloseEvent(
            event,
            observation.interaction,
            observation.context.dependencies.now()
        );
        rememberRtcCloseEvent(observation.connectionName, closeEvent, observation.context);
    });
}

function writeRtcClientMessageObservation(message: any, observation: RtcClientObservation, atEpochMs: number): void {
    const { interaction, context, connectionName } = observation;
    const diagnostic = isRtcDiagnosticMessage(message)
        ? toStoredRtcDiagnostic(message, observation, atEpochMs)
        : undefined;
    const recordedMessage = {
        data: message,
        receivedAtEpochMs: atEpochMs,
        provider: interaction.request.provider,
        actor: interaction.request.actor,
        roomId: interaction.request.roomId,
        roomRef: message?.roomRef ?? interaction.request.roomRef,
        scope: message?.scope ?? interaction.request.scope,
        applicationId: message?.applicationId ?? interaction.request.applicationId,
        workspaceId: message?.workspaceId ?? interaction.request.workspaceId
    };
    if (diagnostic) {
        rememberRtcDiagnostic(connectionName, diagnostic, context);
    }
    rememberRtcMessage(connectionName, recordedMessage, context);
}

export function createRtcProviderFromClientFactory(options: RtcClientProviderOptions): RtcProvider {
    const provider = new RtcClientProvider(options);
    return {
        connect: provider.connect.bind(provider),
        send: provider.send.bind(provider),
        wait: provider.wait.bind(provider),
        close: provider.close.bind(provider)
    };
}

function toRtcClientSendFailure(input: RtcClientSendFailureInput): any {
    const { config, interaction, connectionName, payload, sendStartedAtEpochMs, sendFailedAtEpochMs, error } = input;
    const errorRecord = error && typeof error === 'object'
        ? error as any
        : {};
    const sendResult = errorRecord.sendResult ?? errorRecord.response;
    const diagnostics = errorRecord.diagnostics;
    return toRtcFailureStatus({
        config,
        interaction,
        result: 'RTC send failed',
        details: {
            connection: connectionName,
            sent: payload,
            ...(sendResult !== undefined ? { sendResult } : {}),
            ...(diagnostics !== undefined ? { diagnostics } : {}),
            exception: error instanceof Error ? error.message : String(error),
            provider: interaction.request.provider,
            actor: interaction.request.actor,
            roomId: interaction.request.roomId,
            sendStartedAtEpochMs,
            sendFailedAtEpochMs,
            sendLatencyMs: sendStartedAtEpochMs !== undefined
                ? sendFailedAtEpochMs - sendStartedAtEpochMs
                : undefined
        }
    });
}

/** An adapter that refuses a send reports it as a value; the step it came from has to fail with it. */
function toRtcClientOutcomeFailure(sendResult: any): RtcClientOutcomeFailure | undefined {
    if (sendResult?.status !== 'failed') {
        return undefined;
    }
    const error = sendResult.error ?? {};
    return {
        code: typeof error.code === 'string' ? error.code : 'rtc-send-refused',
        message: typeof error.message === 'string' ? error.message : 'RTC send was refused'
    };
}

function rememberRtcClientSend(connection: any, record: RtcClientSendRecord): void {
    connection.lastSendStartedAtEpochMs = record.startedAtEpochMs;
    connection.lastSendEndedAtEpochMs = record.endedAtEpochMs;
    connection.lastSendLatencyMs = record.endedAtEpochMs - record.startedAtEpochMs;
    if (record.sendResult !== undefined) {
        connection.lastSendResult = record.sendResult;
    }
    if (record.diagnostics !== undefined) {
        connection.diagnostics = record.diagnostics;
    }
}

function waitForRtcSendResult(input: RtcSendWaitInput): Promise<any> {
    const response = input.interaction.response;
    if (response?.count !== undefined) {
        return waitForRtcMessageCount(input);
    }
    if (response?.messages) {
        return waitForRtcMessages(input);
    }
    if (response?.diagnostics) {
        return waitForRtcDiagnostics(input);
    }
    if (response?.diagnostic) {
        return waitForRtcDiagnostic(input);
    }
    if (response?.health !== undefined) {
        return waitForRtcHealth(input);
    }
    if (response?.message) {
        return waitForRtcMessage(input);
    }
    const { sentConnection, ...sendDetails } = input.details;
    return Promise.resolve(
        toRtcSuccessStatus(input.config, input.interaction, { connection: sentConnection, ...sendDetails })
    );
}

class RtcClientProvider implements RtcProvider {
    private readonly options: RtcClientProviderOptions;

    constructor(options: RtcClientProviderOptions) {
        this.options = options;
    }

    async connect(interaction: any, config: any, context: any): Promise<any> {
        const connectionName = toRtcConnectionName(interaction.request);
        const connectStartedAtEpochMs = context.dependencies.now();

        try {
            const client = await this.options.createClient(interaction.request, config, context);

            registerRtcClientObservations(client, { interaction, context, connectionName });

            await client.connect();
            const connectedAtEpochMs = context.dependencies.now();
            const diagnostics = client.diagnostics?.();

            const connectionMetadata = {
                provider: interaction.request.provider,
                actor: interaction.request.actor,
                roomId: interaction.request.roomId,
                connectStartedAtEpochMs,
                connectedAtEpochMs,
                connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs,
                diagnostics
            };
            context.rtcConnections[connectionName] = { client, request: interaction.request, ...connectionMetadata };

            context.rtcMessages[connectionName] = context.rtcMessages[connectionName] || [];
            context.rtcDiagnostics = context.rtcDiagnostics || {};
            context.rtcDiagnostics[connectionName] = context.rtcDiagnostics[connectionName] || [];
            context.rtcCloseEvents[connectionName] = context.rtcCloseEvents[connectionName] || [];

            return toRtcSuccessStatus(config, interaction, {
                connection: connectionName,
                connected: true,
                ...connectionMetadata
            });
        }
        catch (e) {
            const failedAtEpochMs = context.dependencies.now();
            return toRtcFailureStatus({
                config,
                interaction,
                result: 'RTC connect failed',
                details: {
                    connection: connectionName,
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    connectStartedAtEpochMs,
                    connectFailedAtEpochMs: failedAtEpochMs,
                    connectLatencyMs: failedAtEpochMs - connectStartedAtEpochMs
                }
            });
        }
    }

    async send(interaction: any, config: any, context: any): Promise<any> {
        const connectionName = toRtcConnectionName(interaction.request);
        const connection = context.rtcConnections[connectionName];
        const client: RtcClient | undefined = connection?.client;
        const payload = toRtcPayload(interaction.request);
        let sendStartedAtEpochMs: number | undefined;

        if (!client) {
            return toRtcFailureStatus({
                config,
                interaction,
                result: 'RTC connection is not open',
                details: {
                    connection: connectionName
                }
            });
        }

        try {
            const startedAt: number = context.dependencies.now();
            sendStartedAtEpochMs = startedAt;
            const sendResult = await client.send(payload, interaction);
            const outcomeFailure = toRtcClientOutcomeFailure(sendResult);
            if (outcomeFailure) {
                return toRtcFailureStatus({
                    config,
                    interaction,
                    result: outcomeFailure.message,
                    details: { connection: connectionName, sent: payload, sendResult, code: outcomeFailure.code }
                });
            }
            rememberRtcClientSend(connection, {
                startedAtEpochMs: startedAt,
                endedAtEpochMs: context.dependencies.now(),
                sendResult,
                diagnostics: client.diagnostics?.()
            });
        }
        catch (e) {
            const sendFailedAtEpochMs = context.dependencies.now();
            return toRtcClientSendFailure({
                config,
                interaction,
                connectionName,
                payload,
                sendStartedAtEpochMs,
                sendFailedAtEpochMs,
                error: e
            });
        }

        const sendWaitDetails = {
            sentConnection: connectionName,
            sent: payload,
            sendResult: connection.lastSendResult,
            sendStartedAtEpochMs: connection.lastSendStartedAtEpochMs,
            sendEndedAtEpochMs: connection.lastSendEndedAtEpochMs,
            sendLatencyMs: connection.lastSendLatencyMs,
            diagnostics: connection.diagnostics
        };

        return waitForRtcSendResult({ interaction, config, context, details: sendWaitDetails });
    }

    async wait(interaction: any, config: any, context: any): Promise<any> {
        if (interaction.response?.close !== undefined) {
            return waitForRtcClose({ interaction, config, context: context });
        }

        if (interaction.response?.absent !== undefined) {
            return waitForRtcMessageAbsence({ interaction, config, context });
        }

        if (interaction.response?.count !== undefined) {
            return waitForRtcMessageCount({ interaction, config, context });
        }
        if (interaction.response?.diagnostics) {
            return waitForRtcDiagnostics({ interaction, config, context: context });
        }

        if (interaction.response?.diagnostic) {
            return waitForRtcDiagnostic({ interaction, config, context: context });
        }

        if (interaction.response?.health !== undefined) {
            return waitForRtcHealth({ interaction, config, context: context });
        }

        if (interaction.response?.messages) {
            return waitForRtcMessages({ interaction, config, context: context });
        }

        if (interaction.response?.message) {
            return waitForRtcMessage({ interaction, config, context: context });
        }

        return toRtcFailureStatus({
            config,
            interaction,
            result: 'RTC wait expects expect.message, expect.messages, expect.count, expect.absent, ' +
                'expect.diagnostic, expect.diagnostics, expect.health, or expect.close',
            details: {
                connection: toRtcExpectedConnectionName(interaction)
            }
        });
    }

    async close(interaction: any, config: any, context: any): Promise<any> {
        const connectionName = toRtcConnectionName(interaction.request);
        const connection = context.rtcConnections[connectionName];
        const client: RtcClient | undefined = connection?.client;

        try {
            if (client) {
                await client.close(interaction, config, context);
                delete context.rtcConnections[connectionName];
            }
        }
        catch (e) {
            return toRtcFailureStatus({
                config,
                interaction,
                result: 'RTC close failed',
                details: {
                    connection: connectionName,
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId
                }
            });
        }

        rememberRtcCloseEvent(connectionName, {
            closeRequested: true,
            closed: client !== undefined,
            closedAtEpochMs: context.dependencies.now(),
            provider: interaction.request.provider,
            actor: interaction.request.actor,
            roomId: interaction.request.roomId
        }, context);

        return toRtcSuccessStatus(config, interaction, {
            connection: connectionName,
            closeRequested: true,
            closed: client !== undefined,
            provider: interaction.request.provider,
            actor: interaction.request.actor,
            roomId: interaction.request.roomId
        });
    }
}
