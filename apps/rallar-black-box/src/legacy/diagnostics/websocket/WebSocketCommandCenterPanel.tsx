import { WebSocketCommandCenterView } from './WebSocketCommandCenterView.tsx';
import {
    type UseWebSocketCommandCenterControllerInput,
    useWebSocketCommandCenterController,
} from './use-websocket-command-center-controller.ts';

type WebSocketCommandCenterPanelProps =
    UseWebSocketCommandCenterControllerInput &
        Readonly<{
            busy: boolean;
            onSelectCommand(commandId: string): void;
        }>;

export function WebSocketCommandCenterPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
    browserStatus,
    busy,
    onSelectCommand,
}: WebSocketCommandCenterPanelProps) {
    const {
        providerMode, values, payloadPresetId, localError, busyAction,
        actionFeedback, waitStatus, ticket, subscription, diagnostics,
        activePreset, canSendViaRallarSignaling, routePreview,
        subscriptionStatusLabel, subscriptionStatusTone, receiveStatusText,
        payloadResult, updateValue, updateGroupId, updateWsScope,
        selectPayloadPreset, configure, open, send, close, reconnect, cleanup,
        subscribeWs, unsubscribeWs, createTicket, waitForMessage,
        waitForRallarWsOpen, copyDiagnostics, copyRecipe, openMissingTicket,
    } = useWebSocketCommandCenterController({
        state,
        bootstrap,
        authSession,
        globalValues,
        browserStatus,
    });

    return (
        <WebSocketCommandCenterView
            state={state}
            authSession={authSession}
            browserStatus={browserStatus}
            busy={busy}
            model={{
                providerMode,
                values,
                payloadPresetId,
                localError,
                busyAction,
                actionFeedback,
                waitStatus,
                ticket,
                subscription,
                diagnostics,
                activePreset,
                canSendViaRallarSignaling,
                routePreview,
                subscriptionStatusLabel,
                subscriptionStatusTone,
                receiveStatusText,
                payloadResult,
                updateValue,
                updateGroupId,
                updateWsScope,
                selectPayloadPreset,
                configure,
                open,
                send,
                close,
                reconnect,
                cleanup,
                subscribeWs,
                unsubscribeWs,
                createTicket,
                waitForMessage,
                waitForRallarWsOpen,
                copyDiagnostics,
                copyRecipe,
                openMissingTicket,
            }}
        />
    );
}
