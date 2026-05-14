// deno-lint-ignore-file no-explicit-any
import {
    type RtcProvider,
    rememberRtcCloseEvent,
    rememberRtcMessage,
    toRtcConnectionName,
    toRtcDeliveredMessages,
    toRtcDeliverTargets,
    toRtcExpectedConnectionName,
    toRtcFailureStatus,
    toRtcPayload,
    toRtcSuccessStatus,
    waitForRtcClose,
    waitForRtcMessage,
    waitForRtcMessages,
} from './rtc-provider.ts'

export function createRallarStubRtcProvider(): RtcProvider {
    return {
        connect: (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);

            context.rtcConnections[connectionName] = {
                provider: interaction.request.provider || 'rallar',
                actor: interaction.request.actor,
                roomId: interaction.request.roomId,
                connectedAtEpochMs: Date.now(),
                stub: true,
            };

            context.rtcMessages[connectionName] = context.rtcMessages[connectionName] || [];
            context.rtcCloseEvents[connectionName] = context.rtcCloseEvents[connectionName] || [];

            return Promise.resolve(toRtcSuccessStatus(config, interaction, {
                connection: connectionName,
                connected: true,
                stub: true,
            }));
        },

        send: (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const payload = toRtcPayload(interaction.request);
            const deliveredMessages = toRtcDeliveredMessages(interaction.request);
            const deliverTargets = toRtcDeliverTargets(interaction);

            if (!context.rtcConnections[connectionName]) {
                return Promise.resolve(toRtcFailureStatus(config, interaction, 'RTC connection is not open', {
                    connection: connectionName,
                    stub: true,
                }));
            }

            const sentAtEpochMs = Date.now();

            deliveredMessages.forEach((messagePayload, messageIndex) => {
                const sentMessage = {
                    data: messagePayload,
                    sentBy: connectionName,
                    sentAtEpochMs,
                    messageIndex,
                    stub: true,
                };

                rememberRtcMessage(connectionName, sentMessage, context);

                deliverTargets.forEach(target => {
                    rememberRtcMessage(target, {
                        ...sentMessage,
                        deliveredTo: target,
                        deliveredAtEpochMs: Date.now(),
                    }, context);
                });
            });

            if (interaction.response?.messages) {
                return waitForRtcMessages(interaction, config, context, {
                    sentConnection: connectionName,
                    sent: payload,
                    deliveredMessages,
                    deliverTargets,
                    stub: true,
                });
            }

            if (interaction.response?.message) {
                return waitForRtcMessage(interaction, config, context, {
                    sentConnection: connectionName,
                    sent: payload,
                    deliveredMessages,
                    deliverTargets,
                    stub: true,
                });
            }

            return Promise.resolve(toRtcSuccessStatus(config, interaction, {
                connection: connectionName,
                sent: payload,
                deliveredMessages,
                deliverTargets,
                stub: true,
            }));
        },

        wait: (interaction: any, config: any, context: any): Promise<any> => {
            if (interaction.response?.close !== undefined) {
                return waitForRtcClose(interaction, config, context, {
                    stub: true,
                });
            }

            if (interaction.response?.messages) {
                return waitForRtcMessages(interaction, config, context, {
                    stub: true,
                });
            }

            if (interaction.response?.message) {
                return waitForRtcMessage(interaction, config, context, {
                    stub: true,
                });
            }

            return Promise.resolve(toRtcFailureStatus(config, interaction, 'RTC wait expects expect.message, expect.messages, or expect.close', {
                stub: true,
                connection: toRtcExpectedConnectionName(interaction),
            }));
        },

        close: (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const wasOpen = context.rtcConnections[connectionName] !== undefined;

            delete context.rtcConnections[connectionName];

            rememberRtcCloseEvent(connectionName, {
                closedAtEpochMs: Date.now(),
                closeRequested: true,
                stub: true,
            }, context);

            return Promise.resolve(toRtcSuccessStatus(config, interaction, {
                connection: connectionName,
                closeRequested: true,
                closed: wasOpen,
                stub: true,
            }));
        },
    };
}