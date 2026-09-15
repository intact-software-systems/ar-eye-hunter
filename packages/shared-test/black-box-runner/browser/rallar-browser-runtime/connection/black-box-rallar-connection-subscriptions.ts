import type { BlackBoxRallarRuntimeDiagnostics } from '../black-box-rallar-diagnostics.ts';
import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';
import { blackBoxRallarScopeDiagnosticsOf } from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarMessagingResourceController } from '../messaging/create-black-box-rallar-messaging-resource-controller.ts';
import {
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarMessageSelector,
    resolveBlackBoxRallarTransport
} from './black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';

export interface ConnectionSubscriptionInput {
    readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
    readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
    readonly config: BlackBoxRallarConnectionConfig;
    readonly session: BlackBoxRallarConnectionState.Session;
}

export interface StopConnectionSubscriptionsInput {
    readonly state: BlackBoxRallarConnectionState.Value | undefined;
    /** Absent when a close knows no connection, so the stop is recorded nowhere. */
    readonly config: BlackBoxRallarConnectionConfig | undefined;
    readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
    readonly messagingResources: Pick<BlackBoxRallarMessagingResourceController, 'cleanupWsSubscriptions'>;
}

export function subscribeBlackBoxRallarRealtime(input: ConnectionSubscriptionInput): (() => void) | undefined {
    const { rallar, diagnostics, config, session } = input;
    const transport = resolveBlackBoxRallarTransport(config);
    if (transport !== 'realtime') {
        return undefined;
    }
    return rallar.realtime.onJson(resolveBlackBoxRallarLaneId(config), (message) => {
        diagnostics.emit({
            kind: 'message',
            topic: 'rallar.browser.realtime.message',
            connection: config.connection,
            actor: config.actor,
            transport,
            roomId: config.roomId,
            ...blackBoxRallarScopeDiagnosticsOf(config),
            laneId: message.laneId,
            peerId: session.sessionId,
            remotePeerId: message.peerId,
            data: message.data
        });
    });
}

export function subscribeBlackBoxRallarMessagesRtc(input: ConnectionSubscriptionInput): (() => void) | undefined {
    const { rallar, diagnostics, config, session } = input;
    const transport = resolveBlackBoxRallarTransport(config);
    if (transport !== 'messages.rtc') {
        return undefined;
    }
    return rallar.messages.rtc.onMessage(resolveBlackBoxRallarMessageSelector(config), (message) => {
        diagnostics.emit({
            kind: 'message',
            topic: 'rallar.browser.messages.rtc.message',
            connection: config.connection,
            actor: config.actor,
            transport,
            roomId: message.roomId ?? config.roomId,
            ...blackBoxRallarScopeDiagnosticsOf(config),
            peerId: session.sessionId,
            remotePeerId: message.senderId,
            senderId: message.senderId,
            typeId: message.typeId,
            topicId: message.topicId,
            contextId: message.contextId,
            resourceId: message.resourceId,
            data: message.payload
        });
    });
}

/** The console-warning restore runs but is not counted as a stopped subscription. */
export function stopBlackBoxRallarConnectionSubscriptions(input: StopConnectionSubscriptionsInput): number {
    const { state, config, diagnostics } = input;
    const counted = [
        state?.unsubscribeMessagesRtc,
        state?.unsubscribeRealtime,
        state?.unsubscribeRtcLifecycle,
        state?.unsubscribeFormationDiagnostics,
        state?.unsubscribeWsLifecycle
    ].filter((unsubscribe): unsubscribe is () => void => unsubscribe !== undefined);
    let unsubscribed = 0;
    for (const unsubscribe of counted) {
        unsubscribe();
        unsubscribed += 1;
    }
    state?.unsubscribeConsoleDiagnostics?.();
    unsubscribed += input.messagingResources.cleanupWsSubscriptions();
    if (unsubscribed > 0 && config) {
        diagnostics.emitDiagnostic(config, 'rallar.browser.cleanup.unsubscribe_completed', { unsubscribed });
    }
    return unsubscribed;
}
