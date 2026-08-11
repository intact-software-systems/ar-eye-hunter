// deno-lint-ignore-file no-explicit-any
// Compatibility boundary: waits/statuses/buffers live in rtc/rtc-wait-expectations.ts.
export * from './rtc/rtc-wait-expectations.ts';
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
    waitForRtcMessages,
} from './rtc/rtc-wait-expectations.ts';

export type RtcProvider = {
    connect: (interaction: any, config: any, context: any) => Promise<any>
    send: (interaction: any, config: any, context: any) => Promise<any>
    wait: (interaction: any, config: any, context: any) => Promise<any>
    close: (interaction: any, config: any, context: any) => Promise<any>
    command?: (interaction: any, config: any, context: any) => Promise<any>
}

export type RtcClient = {
    connect: () => Promise<void>
    send: (message: any, interaction?: any, config?: any, context?: any) => Promise<any>
    command?: (
        action: string,
        request: any,
        interaction?: any,
        config?: any,
        context?: any,
    ) => Promise<any>
    close: (interaction?: any, config?: any, context?: any) => Promise<void>
    onMessage?: (handler: (message: any) => void) => void
    onClose?: (handler: (event: any) => void) => void
    diagnostics?: () => any
}

export type RtcClientProviderOptions = {
    createClient: (request: any, config?: any, context?: any) => Promise<RtcClient> | RtcClient
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

function toStoredRtcCloseEvent(event: any, interaction: any): any {
    const eventFields = event && typeof event === 'object' && !Array.isArray(event)
        ? event
        : { value: event };

    return {
        ...eventFields,
        event,
        closedAtEpochMs: Date.now(),
        provider: interaction.request.provider,
        actor: interaction.request.actor,
        roomId: interaction.request.roomId,
    };
}

function isRtcDiagnosticMessage(message: any): boolean {
    return message?.kind === 'diagnostic';
}

function toStoredRtcDiagnostic(message: any, interaction: any, connectionName: string): any {
    return {
        kind: 'diagnostic',
        topic: message.topic,
        severity: message.severity ?? (message.error ? 'error' : 'info'),
        atEpochMs: message.atEpochMs ?? Date.now(),
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
        event: message,
    };
}

export function createRtcProviderFromClientFactory(options: RtcClientProviderOptions): RtcProvider {
    return {
        connect: async (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const connectStartedAtEpochMs = Date.now();

            try {
                const client = await options.createClient(interaction.request, config, context);

                client.onMessage?.((message: any) => {
                    if (isRtcDiagnosticMessage(message)) {
                        rememberRtcDiagnostic(
                            connectionName,
                            toStoredRtcDiagnostic(message, interaction, connectionName),
                            context,
                        );
                    }

                    rememberRtcMessage(connectionName, {
                        data: message,
                        receivedAtEpochMs: Date.now(),
                        provider: interaction.request.provider,
                        actor: interaction.request.actor,
                        roomId: interaction.request.roomId,
                        roomRef: message?.roomRef ?? interaction.request.roomRef,
                        scope: message?.scope ?? interaction.request.scope,
                        applicationId: message?.applicationId ??
                            interaction.request.applicationId,
                        workspaceId: message?.workspaceId ??
                            interaction.request.workspaceId,
                    }, context);
                });

                client.onClose?.((event: any) => {
                    rememberRtcCloseEvent(
                        connectionName,
                        toStoredRtcCloseEvent(event, interaction),
                        context,
                    );
                });

                await client.connect();
                const connectedAtEpochMs = Date.now();
                const diagnostics = client.diagnostics?.();

                context.rtcConnections[connectionName] = {
                    client,
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    request: interaction.request,
                    connectStartedAtEpochMs,
                    connectedAtEpochMs,
                    connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs,
                    diagnostics,
                };

                context.rtcMessages[connectionName] = context.rtcMessages[connectionName] || [];
                context.rtcDiagnostics = context.rtcDiagnostics || {};
                context.rtcDiagnostics[connectionName] =
                    context.rtcDiagnostics[connectionName] || [];
                context.rtcCloseEvents[connectionName] =
                    context.rtcCloseEvents[connectionName] || [];

                return toRtcSuccessStatus(config, interaction, {
                    connection: connectionName,
                    connected: true,
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    diagnostics,
                    connectStartedAtEpochMs,
                    connectedAtEpochMs,
                    connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs,
                });
            } catch (e) {
                const failedAtEpochMs = Date.now();
                return toRtcFailureStatus(config, interaction, 'RTC connect failed', {
                    connection: connectionName,
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    connectStartedAtEpochMs,
                    connectFailedAtEpochMs: failedAtEpochMs,
                    connectLatencyMs: failedAtEpochMs - connectStartedAtEpochMs,
                });
            }
        },

        send: async (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const connection = context.rtcConnections[connectionName];
            const client = connection?.client as RtcClient | undefined;
            const payload = toRtcPayload(interaction.request);
            let sendStartedAtEpochMs: number | undefined;

            if (!client) {
                return toRtcFailureStatus(config, interaction, 'RTC connection is not open', {
                    connection: connectionName,
                });
            }

            try {
                sendStartedAtEpochMs = Date.now();
                const sendResult = await client.send(payload, interaction, config, context);
                const sendEndedAtEpochMs = Date.now();
                const diagnostics = client.diagnostics?.();
                connection.lastSendStartedAtEpochMs = sendStartedAtEpochMs;
                connection.lastSendEndedAtEpochMs = sendEndedAtEpochMs;
                connection.lastSendLatencyMs = sendEndedAtEpochMs - sendStartedAtEpochMs;
                if (sendResult !== undefined) {
                    connection.lastSendResult = sendResult;
                }
                if (diagnostics !== undefined) {
                    connection.diagnostics = diagnostics;
                }
            } catch (e) {
                const sendFailedAtEpochMs = Date.now();
                const errorRecord = e && typeof e === 'object'
                    ? e as any
                    : {};
                const sendResult = errorRecord.sendResult ?? errorRecord.response;
                const diagnostics = errorRecord.diagnostics;
                return toRtcFailureStatus(config, interaction, 'RTC send failed', {
                    connection: connectionName,
                    sent: payload,
                    ...(sendResult !== undefined ? { sendResult } : {}),
                    ...(diagnostics !== undefined ? { diagnostics } : {}),
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    sendStartedAtEpochMs,
                    sendFailedAtEpochMs,
                    sendLatencyMs: sendStartedAtEpochMs !== undefined
                        ? sendFailedAtEpochMs - sendStartedAtEpochMs
                        : undefined,
                });
            }

            const sendWaitDetails = {
                sentConnection: connectionName,
                sent: payload,
                sendResult: connection.lastSendResult,
                sendStartedAtEpochMs: connection.lastSendStartedAtEpochMs,
                sendEndedAtEpochMs: connection.lastSendEndedAtEpochMs,
                sendLatencyMs: connection.lastSendLatencyMs,
                diagnostics: connection.diagnostics,
            };

            if (interaction.response?.messages) {
                return waitForRtcMessages(interaction, config, context, sendWaitDetails);
            }

            if (interaction.response?.diagnostics) {
                return waitForRtcDiagnostics(interaction, config, context, sendWaitDetails);
            }

            if (interaction.response?.diagnostic) {
                return waitForRtcDiagnostic(interaction, config, context, sendWaitDetails);
            }

            if (interaction.response?.health !== undefined) {
                return waitForRtcHealth(interaction, config, context, sendWaitDetails);
            }

            if (interaction.response?.message) {
                return waitForRtcMessage(interaction, config, context, sendWaitDetails);
            }

            return toRtcSuccessStatus(config, interaction, {
                connection: connectionName,
                sent: payload,
                provider: interaction.request.provider,
                actor: interaction.request.actor,
                roomId: interaction.request.roomId,
                sendResult: connection.lastSendResult,
                sendStartedAtEpochMs: connection.lastSendStartedAtEpochMs,
                sendEndedAtEpochMs: connection.lastSendEndedAtEpochMs,
                sendLatencyMs: connection.lastSendLatencyMs,
                diagnostics: connection.diagnostics,
            });
        },

        wait: async (interaction: any, config: any, context: any): Promise<any> => {
            if (interaction.response?.close !== undefined) {
                return waitForRtcClose(interaction, config, context);
            }

            if (interaction.response?.absent !== undefined) {
                return waitForRtcMessageAbsence({ interaction, config, context });
            }

            if (interaction.response?.diagnostics) {
                return waitForRtcDiagnostics(interaction, config, context);
            }

            if (interaction.response?.diagnostic) {
                return waitForRtcDiagnostic(interaction, config, context);
            }

            if (interaction.response?.health !== undefined) {
                return waitForRtcHealth(interaction, config, context);
            }

            if (interaction.response?.messages) {
                return waitForRtcMessages(interaction, config, context);
            }

            if (interaction.response?.message) {
                return waitForRtcMessage(interaction, config, context);
            }

            return toRtcFailureStatus(
                config,
                interaction,
                'RTC wait expects expect.message, expect.messages, expect.absent, ' +
                    'expect.diagnostic, expect.diagnostics, expect.health, or expect.close',
                {
                    connection: toRtcExpectedConnectionName(interaction),
                },
            );
        },

        close: async (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const connection = context.rtcConnections[connectionName];
            const client = connection?.client as RtcClient | undefined;

            try {
                if (client) {
                    await client.close(interaction, config, context);
                    delete context.rtcConnections[connectionName];
                }
            } catch (e) {
                return toRtcFailureStatus(config, interaction, 'RTC close failed', {
                    connection: connectionName,
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                });
            }

            rememberRtcCloseEvent(connectionName, {
                closeRequested: true,
                closed: client !== undefined,
                closedAtEpochMs: Date.now(),
                provider: interaction.request.provider,
                actor: interaction.request.actor,
                roomId: interaction.request.roomId,
            }, context);

            return toRtcSuccessStatus(config, interaction, {
                connection: connectionName,
                closeRequested: true,
                closed: client !== undefined,
                provider: interaction.request.provider,
                actor: interaction.request.actor,
                roomId: interaction.request.roomId,
            });
        },
    };
}
