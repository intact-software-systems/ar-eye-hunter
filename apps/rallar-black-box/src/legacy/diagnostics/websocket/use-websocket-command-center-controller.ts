import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    rallarBlackBoxProviderModeFromConfig,
    type RallarBlackBoxBootstrapConfig
} from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../shell/rallar-browser-status.ts';
import {
    idleActionFeedback,
    type CommandCenterActionFeedback
} from '../shared/action-feedback.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import { WebSocketCommandCenterActions } from './web-socket-command-center-actions.ts';
import type {
    WebSocketCommandCenterValues,
    WebSocketDiagnostic,
    WebSocketPayloadPreset,
    WebSocketRoutePreview,
    WebSocketSubscriptionState
} from './websocket-contracts.ts';
import { deriveWebSocketDiagnostics } from './websocket-diagnostics.ts';
import {
    DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID,
    webSocketPayloadPresetById,
    webSocketPayloadPresetText
} from './websocket-presets.ts';
import {
    defaultWebSocketApiUrl,
    defaultWebSocketScope,
    defaultWebSocketTopicId,
    defaultWebSocketTypeId,
    defaultWebSocketValuesFromContext,
    webSocketRoutePreview
} from './websocket-routing.ts';
import type { WebSocketCommandCenterViewModel } from './websocket-view-contracts.ts';
export interface UseWebSocketCommandCenterControllerInput {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
}
interface WebSocketCommandCenterControls {
    readonly values: WebSocketCommandCenterValues;
    readonly setValues: React.Dispatch<React.SetStateAction<WebSocketCommandCenterValues>>;
    readonly payloadPresetId: string;
    readonly setPayloadPresetId: React.Dispatch<React.SetStateAction<string>>;
    readonly sequence: number;
    readonly setSequence: React.Dispatch<React.SetStateAction<number>>;
    readonly localError: string | undefined;
    readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
    readonly busyAction: string | undefined;
    readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
    readonly actionFeedback: CommandCenterActionFeedback;
    readonly setActionFeedback: React.Dispatch<React.SetStateAction<CommandCenterActionFeedback>>;
    readonly waitStatus: string;
    readonly setWaitStatus: React.Dispatch<React.SetStateAction<string>>;
    readonly ticket: AuthCommandCenterTicket | undefined;
    readonly setTicket: React.Dispatch<React.SetStateAction<AuthCommandCenterTicket | undefined>>;
    readonly subscription: WebSocketSubscriptionState | undefined;
    readonly setSubscription: React.Dispatch<React.SetStateAction<WebSocketSubscriptionState | undefined>>;
}
function useWebSocketCommandCenterControls(
    defaultContext: ReturnType<typeof defaultWebSocketValuesFromContext>
): WebSocketCommandCenterControls {
    const [values, setValues] = useState<WebSocketCommandCenterValues>(() =>
        createWebSocketCommandCenterValues(defaultContext)
    );
    const [payloadPresetId, setPayloadPresetId] = useState(
        DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID
    );
    const [sequence, setSequence] = useState(1);
    const [localError, setLocalError] = useState<string | undefined>();
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [actionFeedback, setActionFeedback] = useState<CommandCenterActionFeedback>(() =>
        idleActionFeedback(
            'Run a WebSocket operation to see action status.'
        )
    );
    const [waitStatus, setWaitStatus] = useState<string>('idle');
    const [ticket, setTicket] = useState<AuthCommandCenterTicket | undefined>();
    const [subscription, setSubscription] = useState<WebSocketSubscriptionState | undefined>();
    return {
        values,
        setValues,
        payloadPresetId,
        setPayloadPresetId,
        sequence,
        setSequence,
        localError,
        setLocalError,
        busyAction,
        setBusyAction,
        actionFeedback,
        setActionFeedback,
        waitStatus,
        setWaitStatus,
        ticket,
        setTicket,
        subscription,
        setSubscription
    };
}
function createWebSocketCommandCenterValues(
    defaultContext: ReturnType<typeof defaultWebSocketValuesFromContext>
): WebSocketCommandCenterValues {
    return {
        apiBaseUrl: defaultContext.apiBaseUrl,
        connection: 'rallarApi',
        applicationId: defaultContext.applicationId,
        workspaceId: defaultContext.workspaceId,
        groupId: defaultContext.groupId,
        wsScope: defaultWebSocketScope(),
        typeId: defaultWebSocketTypeId(),
        topicId: defaultWebSocketTopicId(),
        contextId: webSocketPayloadPresetById(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID)
            .values?.contextId ?? defaultContext.contextId,
        resourceId: '',
        wsUrl: defaultWebSocketApiUrl(defaultContext.apiBaseUrl),
        protocols: '',
        payloadText: webSocketPayloadPresetText(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID) ??
            '{}',
        timeoutMs: 5_000,
        closeCode: 1000,
        closeReason: 'rallar-black-box cleanup'
    };
}
export function useWebSocketCommandCenterController(
    input: UseWebSocketCommandCenterControllerInput
): WebSocketCommandCenterViewModel {
    const config = selectRallarBlackBoxCurrentConfig(input.state);
    const providerMode = config ? rallarBlackBoxProviderModeFromConfig(config) : input.bootstrap.providerMode;
    const defaultContext = defaultWebSocketValuesFromContext(input.globalValues, config, input.bootstrap);
    const controls = useWebSocketCommandCenterControls(defaultContext);
    const lifecycle = useWebSocketCommandCenterLifecycle(input, controls, defaultContext);
    const projection = useWebSocketCommandCenterPresentation(input, controls, providerMode);
    const actions = new WebSocketCommandCenterActions({ ...input, ...controls, ...lifecycle, ...projection });
    return toWebSocketCommandCenterViewModel(controls, projection, actions);
}
interface WebSocketCommandCenterLifecycle {
    readonly rawSocketRef: React.RefObject<WebSocket | undefined>;
    readonly stateRef: React.RefObject<RallarBlackBoxTestState>;
}
function useWebSocketCommandCenterLifecycle(
    input: UseWebSocketCommandCenterControllerInput,
    controls: WebSocketCommandCenterControls,
    defaultContext: ReturnType<typeof defaultWebSocketValuesFromContext>
): WebSocketCommandCenterLifecycle {
    const { state, authSession } = input;
    const { subscription, setValues } = controls;
    const rawSocketAuthKey = authSession
        ? `${authSession.clientId}:${authSession.sessionId}`
        : 'anonymous';
    const rawSocketRef = useRef<WebSocket | undefined>(undefined);
    const stateRef = useRef(state);
    useEffect(() => {
        stateRef.current = state;
    }, [state]);
    useWebSocketContextDefaults(defaultContext, setValues);
    useEffect(() => () => subscription?.unsubscribe(), [subscription]);
    useEffect(() => {
        return () => {
            const socket = rawSocketRef.current;
            rawSocketRef.current = undefined;
            if (
                socket &&
                socket.readyState !== WebSocket.CLOSING &&
                socket.readyState !== WebSocket.CLOSED
            ) {
                socket.close(1000, 'rallar-black-box auth cleanup');
            }
        };
    }, [rawSocketAuthKey]);
    return { rawSocketRef, stateRef };
}

interface WebSocketCommandCenterPresentation {
    readonly providerMode: 'browser-rallar' | 'simulated';
    readonly diagnostics: WebSocketDiagnostic;
    readonly activePreset: WebSocketPayloadPreset;
    readonly canSendViaRallarSignaling: boolean;
    readonly routePreview: WebSocketRoutePreview;
    readonly subscriptionStatusLabel: string;
    readonly subscriptionStatusTone: 'good' | 'muted';
    readonly receiveStatusText: string;
    readonly payloadResult: WebSocketCommandCenterActions.Input['payloadResult'];
}
function useWebSocketCommandCenterPresentation(
    input: UseWebSocketCommandCenterControllerInput,
    controls: WebSocketCommandCenterControls,
    providerMode: 'browser-rallar' | 'simulated'
): WebSocketCommandCenterPresentation {
    const { state, browserStatus } = input;
    const { values, payloadPresetId, subscription } = controls;
    const diagnostics = useMemo(
        () => deriveWebSocketDiagnostics(state, values.connection),
        [state, values.connection]
    );
    const activePreset = useMemo(
        () => webSocketPayloadPresetById(payloadPresetId),
        [payloadPresetId]
    );
    const canSendViaRallarSignaling = providerMode === 'browser-rallar';
    const routePreview = useMemo(
        () =>
            webSocketRoutePreview({
                values,
                diagnostics,
                providerMode,
                browserStatus
            }),
        [browserStatus, diagnostics, providerMode, values]
    );
    const subscriptionStatusLabel = subscription
        ? 'listening'
        : 'not listening';
    const subscriptionStatusTone = subscription ? 'good' : 'muted';
    const receiveStatusText = subscription
        ? `Listening for ${subscription.label} at ${subscription.destination}.`
        : providerMode === 'browser-rallar'
        ? 'Not listening. Click Subscribe WS to receive app messages in this browser.'
        : 'Received messages appear here when WS message events are emitted.';
    const payloadResult = useMemo(() => toWebSocketCommandCenterPayload(values.payloadText), [values.payloadText]);

    return {
        providerMode,
        diagnostics,
        activePreset,
        canSendViaRallarSignaling,
        routePreview,
        subscriptionStatusLabel,
        subscriptionStatusTone,
        receiveStatusText,
        payloadResult
    };
}
function toWebSocketCommandCenterViewModel(
    controls: WebSocketCommandCenterControls,
    projection: WebSocketCommandCenterPresentation,
    actions: WebSocketCommandCenterActions
): WebSocketCommandCenterViewModel {
    return {
        providerMode: projection.providerMode,
        values: controls.values,
        payloadPresetId: controls.payloadPresetId,
        localError: controls.localError,
        busyAction: controls.busyAction,
        actionFeedback: controls.actionFeedback,
        waitStatus: controls.waitStatus,
        ticket: controls.ticket,
        subscription: controls.subscription,
        diagnostics: projection.diagnostics,
        activePreset: projection.activePreset,
        canSendViaRallarSignaling: projection.canSendViaRallarSignaling,
        routePreview: projection.routePreview,
        subscriptionStatusLabel: projection.subscriptionStatusLabel,
        subscriptionStatusTone: projection.subscriptionStatusTone,
        receiveStatusText: projection.receiveStatusText,
        payloadResult: projection.payloadResult,
        updateValue: actions.updateValue,
        updateGroupId: actions.updateGroupId,
        updateWsScope: actions.updateWsScope,
        selectPayloadPreset: actions.selectPayloadPreset,
        configure: actions.configure,
        open: actions.open,
        send: actions.send,
        close: actions.close,
        reconnect: actions.reconnect,
        cleanup: actions.cleanup,
        subscribeWs: actions.subscribeWs,
        unsubscribeWs: actions.unsubscribeWs,
        createTicket: actions.createTicket,
        waitForMessage: actions.waitForMessage,
        waitForRallarWsOpen: actions.waitForRallarWsOpen,
        copyDiagnostics: actions.copyDiagnostics,
        copyRecipe: actions.copyRecipe,
        openMissingTicket: actions.openMissingTicket
    };
}

function toWebSocketCommandCenterPayload(payloadText: string): WebSocketCommandCenterActions.Input['payloadResult'] {
    try {
        return {
            ok: true as const,
            value: JSON.parse(
                payloadText
            ) as import('@shared-web/browser/messages/rallar-message-contracts.ts').RallarMessagePayload
        };
    }
    catch (error) {
        return {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

function useWebSocketContextDefaults(
    defaultContext: ReturnType<typeof defaultWebSocketValuesFromContext>,
    setValues: WebSocketCommandCenterControls['setValues']
): void {
    const defaultContextRef = useRef(defaultContext);
    useEffect(() => {
        const previousDefault = defaultContextRef.current;
        defaultContextRef.current = defaultContext;
        setValues((current) => {
            const previousDefaultWsUrl = defaultWebSocketApiUrl(
                previousDefault.apiBaseUrl
            );
            const next = {
                ...current,
                apiBaseUrl: current.apiBaseUrl === previousDefault.apiBaseUrl
                    ? defaultContext.apiBaseUrl
                    : current.apiBaseUrl,
                applicationId: current.applicationId === previousDefault.applicationId
                    ? defaultContext.applicationId
                    : current.applicationId,
                workspaceId: current.workspaceId === previousDefault.workspaceId
                    ? defaultContext.workspaceId
                    : current.workspaceId,
                groupId: current.groupId === previousDefault.groupId ||
                        current.groupId === ''
                    ? defaultContext.groupId
                    : current.groupId,
                contextId: current.contextId === previousDefault.contextId ||
                        current.contextId === previousDefault.groupId ||
                        current.contextId === ''
                    ? defaultContext.contextId
                    : current.contextId,
                wsUrl: current.wsUrl === previousDefaultWsUrl
                    ? defaultWebSocketApiUrl(defaultContext.apiBaseUrl)
                    : current.wsUrl
            };

            return JSON.stringify(next) === JSON.stringify(current)
                ? current
                : next;
        });
    }, [
        defaultContext.apiBaseUrl,
        defaultContext.applicationId,
        defaultContext.workspaceId,
        defaultContext.groupId,
        defaultContext.contextId
    ]);
}
