// deno-lint-ignore-file no-explicit-any
import {
    toRtcDeliveredMessages,
    toRtcDeliverTargets,
    toRtcPayload,
    type RtcProvider
} from './rtc-provider.ts';
import {
    rememberRtcCloseEvent,
    rememberRtcMessage,
    toRtcConnectionName,
    toRtcExpectedConnectionName,
    toRtcFailureStatus,
    toRtcSuccessStatus,
    waitForRtcClose,
    waitForRtcMessage,
    waitForRtcMessageAbsence,
    waitForRtcMessages
} from './rtc/rtc-wait-expectations.ts';

interface StubRtcDeliveryInput {
    readonly connectionName: string;
    readonly deliveredMessages: readonly unknown[];
    readonly deliverTargets: readonly string[];
    readonly sentAtEpochMs: number;
}

interface StubRtcMessageObservation {
    readonly data: unknown;
    readonly sentBy: string;
    readonly sentAtEpochMs: number;
    readonly messageIndex: number;
    readonly stub: true;
    readonly deliveredTo?: string;
    readonly deliveredAtEpochMs?: number;
}

interface StubRtcMessageDelivery {
    readonly connectionName: string;
    readonly message: StubRtcMessageObservation;
}

export function createRallarStubRtcProvider(): RtcProvider {
    return {
        connect: connectRallarStubRtc,
        send: sendRallarStubRtc,
        wait: waitRallarStubRtc,
        close: closeRallarStubRtc
    };
}

function connectRallarStubRtc(interaction: any, config: any, context: any): Promise<any> {
    const connectionName = toRtcConnectionName(interaction.request);

    context.rtcConnections[connectionName] = {
        provider: interaction.request.provider || 'rallar',
        actor: interaction.request.actor,
        roomId: interaction.request.roomId,
        connectedAtEpochMs: Date.now(),
        stub: true
    };

    context.rtcMessages[connectionName] = context.rtcMessages[connectionName] || [];
    context.rtcCloseEvents[connectionName] = context.rtcCloseEvents[connectionName] || [];

    return Promise.resolve(toRtcSuccessStatus(config, interaction, {
        connection: connectionName,
        connected: true,
        stub: true
    }));
}

function sendRallarStubRtc(interaction: any, config: any, context: any): Promise<any> {
    const connectionName = toRtcConnectionName(interaction.request);
    const payload = toRtcPayload(interaction.request);
    const deliveredMessages = toRtcDeliveredMessages(interaction.request);
    const deliverTargets = toRtcDeliverTargets(interaction);

    if (!context.rtcConnections[connectionName]) {
        return Promise.resolve(
            toRtcFailureStatus({
                config,
                interaction,
                result: 'RTC connection is not open',
                details: {
                    connection: connectionName,
                    stub: true
                }
            })
        );
    }

    const sentAtEpochMs = Date.now();

    const deliveries = computeStubRtcDeliveries({ connectionName, deliveredMessages, deliverTargets, sentAtEpochMs });
    for (const delivery of deliveries) {
        rememberRtcMessage(delivery.connectionName, delivery.message, context);
    }
    const waitInput = {
        interaction,
        config,
        context,
        details: { sentConnection: connectionName, sent: payload, deliveredMessages, deliverTargets, stub: true }
    };

    if (interaction.response?.messages) {
        return waitForRtcMessages(waitInput);
    }

    if (interaction.response?.message) {
        return waitForRtcMessage(waitInput);
    }

    return Promise.resolve(toRtcSuccessStatus(config, interaction, {
        connection: connectionName,
        sent: payload,
        deliveredMessages,
        deliverTargets,
        stub: true
    }));
}

function waitRallarStubRtc(interaction: any, config: any, context: any): Promise<any> {
    const waitInput = { interaction, config, context, details: { stub: true } };
    if (interaction.response?.close !== undefined) {
        return waitForRtcClose(waitInput);
    }

    if (interaction.response?.absent !== undefined) {
        return waitForRtcMessageAbsence(waitInput);
    }

    if (interaction.response?.messages) {
        return waitForRtcMessages(waitInput);
    }

    if (interaction.response?.message) {
        return waitForRtcMessage(waitInput);
    }

    return Promise.resolve(
        toRtcFailureStatus({
            config,
            interaction,
            result: 'RTC wait expects expect.message, expect.messages, expect.absent, or expect.close',
            details: {
                stub: true,
                connection: toRtcExpectedConnectionName(interaction)
            }
        })
    );
}

function closeRallarStubRtc(interaction: any, config: any, context: any): Promise<any> {
    const connectionName = toRtcConnectionName(interaction.request);
    const wasOpen = context.rtcConnections[connectionName] !== undefined;

    delete context.rtcConnections[connectionName];

    rememberRtcCloseEvent(connectionName, {
        closedAtEpochMs: Date.now(),
        closeRequested: true,
        stub: true
    }, context);

    return Promise.resolve(toRtcSuccessStatus(config, interaction, {
        connection: connectionName,
        closeRequested: true,
        closed: wasOpen,
        stub: true
    }));
}

function computeStubRtcDeliveries(input: StubRtcDeliveryInput): readonly StubRtcMessageDelivery[] {
    return input.deliveredMessages.flatMap((data, messageIndex) => {
        const message: StubRtcMessageObservation = {
            data,
            sentBy: input.connectionName,
            sentAtEpochMs: input.sentAtEpochMs,
            messageIndex,
            stub: true
        };
        return [
            { connectionName: input.connectionName, message },
            ...input.deliverTargets.map((target) => ({
                connectionName: target,
                message: { ...message, deliveredTo: target, deliveredAtEpochMs: input.sentAtEpochMs }
            }))
        ];
    });
}
