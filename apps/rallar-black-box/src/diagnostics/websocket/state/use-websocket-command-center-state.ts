import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { CommandCenterActionFeedback } from '../../../legacy/diagnostics/shared/action-feedback.ts';
import { idleActionFeedback } from '../../../legacy/diagnostics/shared/action-feedback.ts';
import type { AuthCommandCenterTicket } from '../../../legacy/diagnostics/shared/auth-command-center-ticket.ts';
import type { CommandCenterGlobalValues } from '../../../legacy/shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../../legacy/shell/rallar-browser-status.ts';
import { rallarBlackBoxProviderModeFromConfig, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { parseWebSocketJsonValue } from '../normalize-websocket-json-value.ts';
import type {
    WebSocketCommandCenterValues,
    WebSocketDiagnostic,
    WebSocketPayloadParseResult,
    WebSocketPayloadPreset,
    WebSocketRoutePreview,
    WebSocketSubscriptionState
} from '../websocket-contracts.ts';
import {
    DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID,
    WEBSOCKET_PAYLOAD_PRESETS,
    webSocketPayloadPresetById,
    webSocketPayloadPresetText
} from '../websocket-presets.ts';
import {
    defaultWebSocketScope,
    defaultWebSocketTopicId,
    defaultWebSocketTypeId,
    defaultWebSocketValuesFromContext,
    webSocketRoutePreview,
    type WebSocketDefaultValues
} from '../websocket-routing.ts';
import { defaultWebSocketApiUrl } from '../websocket-url-routing.ts';
import { deriveWebSocketDiagnostics } from './derive-web-socket-diagnostics.ts';

export interface UseWebSocketCommandCenterStateInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly globalValues: CommandCenterGlobalValues | undefined;
    readonly browserStatus: RallarBrowserStatusSummary;
}

export interface WebSocketCommandCenterState {
    readonly providerMode: 'simulated' | 'browser-rallar';
    readonly values: WebSocketCommandCenterValues;
    readonly setValues: Dispatch<SetStateAction<WebSocketCommandCenterValues>>;
    readonly payloadPresetId: string;
    readonly sequence: number;
    readonly setSequence: Dispatch<SetStateAction<number>>;
    readonly localError: string | undefined;
    readonly setLocalError: Dispatch<SetStateAction<string | undefined>>;
    readonly busyAction: string | undefined;
    readonly setBusyAction: Dispatch<SetStateAction<string | undefined>>;
    readonly actionFeedback: CommandCenterActionFeedback;
    readonly setActionFeedback: Dispatch<SetStateAction<CommandCenterActionFeedback>>;
    readonly waitStatus: string;
    readonly setWaitStatus: Dispatch<SetStateAction<string>>;
    readonly ticket: AuthCommandCenterTicket | undefined;
    readonly setTicket: Dispatch<SetStateAction<AuthCommandCenterTicket | undefined>>;
    readonly subscription: WebSocketSubscriptionState | undefined;
    readonly setSubscription: Dispatch<SetStateAction<WebSocketSubscriptionState | undefined>>;
    readonly stateRef: MutableRefObject<RallarBlackBoxTestState>;
    readonly diagnostics: WebSocketDiagnostic;
    readonly activePreset: WebSocketPayloadPreset;
    readonly routePreview: WebSocketRoutePreview;
    readonly payloadResult: WebSocketPayloadParseResult;
    readonly updateValue: <K extends keyof WebSocketCommandCenterValues>(
        key: K,
        value: WebSocketCommandCenterValues[K]
    ) => void;
    readonly updateGroupId: (groupId: string) => void;
    readonly updateWsScope: (wsScope: WebSocketCommandCenterValues['wsScope']) => void;
    readonly selectPayloadPreset: (presetId: string) => void;
}

interface WebSocketValuesState {
    readonly values: WebSocketCommandCenterValues;
    readonly setValues: Dispatch<SetStateAction<WebSocketCommandCenterValues>>;
    readonly payloadPresetId: string;
    readonly updateValue: WebSocketCommandCenterState['updateValue'];
    readonly updateGroupId: WebSocketCommandCenterState['updateGroupId'];
    readonly updateWsScope: WebSocketCommandCenterState['updateWsScope'];
    readonly selectPayloadPreset: WebSocketCommandCenterState['selectPayloadPreset'];
}

interface WebSocketOperationState {
    readonly sequence: number;
    readonly setSequence: Dispatch<SetStateAction<number>>;
    readonly localError: string | undefined;
    readonly setLocalError: Dispatch<SetStateAction<string | undefined>>;
    readonly busyAction: string | undefined;
    readonly setBusyAction: Dispatch<SetStateAction<string | undefined>>;
    readonly actionFeedback: CommandCenterActionFeedback;
    readonly setActionFeedback: Dispatch<SetStateAction<CommandCenterActionFeedback>>;
    readonly waitStatus: string;
    readonly setWaitStatus: Dispatch<SetStateAction<string>>;
    readonly ticket: AuthCommandCenterTicket | undefined;
    readonly setTicket: Dispatch<SetStateAction<AuthCommandCenterTicket | undefined>>;
    readonly subscription: WebSocketSubscriptionState | undefined;
    readonly setSubscription: Dispatch<SetStateAction<WebSocketSubscriptionState | undefined>>;
}

export function useWebSocketCommandCenterState(
    input: UseWebSocketCommandCenterStateInput
): WebSocketCommandCenterState {
    const config = selectRallarBlackBoxCurrentConfig(input.state);
    const providerMode = config
        ? rallarBlackBoxProviderModeFromConfig(config)
        : input.bootstrap.providerMode;
    const defaultValues = defaultWebSocketValuesFromContext(input.globalValues, config, input.bootstrap);
    const valueState = useWebSocketValues(defaultValues);
    const operationState = useWebSocketOperationState();
    const stateRef = useRef(input.state);
    useEffect(() => {
        stateRef.current = input.state;
    }, [input.state]);
    const diagnostics = useMemo(
        () => deriveWebSocketDiagnostics(input.state, valueState.values.connection),
        [input.state, valueState.values.connection]
    );

    return {
        providerMode,
        ...valueState,
        ...operationState,
        stateRef,
        diagnostics,
        activePreset: webSocketPayloadPresetById(valueState.payloadPresetId),
        routePreview: webSocketRoutePreview({
            values: valueState.values,
            diagnostics,
            providerMode,
            browserStatus: input.browserStatus
        }),
        payloadResult: parseWebSocketJsonValue(valueState.values.payloadText)
    };
}

function useWebSocketValues(defaultValues: WebSocketDefaultValues): WebSocketValuesState {
    const [values, setValues] = useState<WebSocketCommandCenterValues>(() => initialWebSocketValues(defaultValues));
    const [payloadPresetId, setPayloadPresetId] = useState(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID);
    const previousDefaultsRef = useRef(defaultValues);
    useEffect(() => {
        const previousDefaults = previousDefaultsRef.current;
        previousDefaultsRef.current = defaultValues;
        setValues((current) => computeSynchronizedWebSocketValues(current, previousDefaults, defaultValues));
    }, [defaultValues.apiBaseUrl, defaultValues.applicationId, defaultValues.workspaceId, defaultValues.groupId]);
    const updateValue = <K extends keyof WebSocketCommandCenterValues>(
        key: K,
        value: WebSocketCommandCenterValues[K]
    ): void => setValues((current) => ({ ...current, [key]: value }));
    const updateGroupId = (groupId: string): void =>
        setValues((current) => ({
            ...current,
            groupId,
            contextId: shouldFollowGroup(current) ? groupId || current.wsScope : current.contextId
        }));
    const updateWsScope = (wsScope: WebSocketCommandCenterValues['wsScope']): void =>
        setValues((current) => ({
            ...current,
            wsScope,
            contextId: shouldFollowScope(current)
                ? wsScope === 'room' ? current.groupId || 'room' : wsScope
                : current.contextId
        }));
    const selectPayloadPreset = (presetId: string): void => {
        setPayloadPresetId(presetId);
        setValues((current) => valuesForPayloadPreset(current, presetId));
    };
    return { values, setValues, payloadPresetId, updateValue, updateGroupId, updateWsScope, selectPayloadPreset };
}

function useWebSocketOperationState(): WebSocketOperationState {
    const [sequence, setSequence] = useState(1);
    const [localError, setLocalError] = useState<string | undefined>();
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [actionFeedback, setActionFeedback] = useState<CommandCenterActionFeedback>(() =>
        idleActionFeedback('Run a WebSocket operation to see action status.')
    );
    const [waitStatus, setWaitStatus] = useState('idle');
    const [ticket, setTicket] = useState<AuthCommandCenterTicket | undefined>();
    const [subscription, setSubscription] = useState<WebSocketSubscriptionState | undefined>();
    useEffect(() => () => subscription?.unsubscribe(), [subscription]);
    return {
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

function initialWebSocketValues(defaultValues: WebSocketDefaultValues): WebSocketCommandCenterValues {
    return {
        ...defaultValues,
        connection: 'rallarApi',
        wsScope: defaultWebSocketScope(),
        typeId: defaultWebSocketTypeId(),
        topicId: defaultWebSocketTopicId(),
        resourceId: '',
        wsUrl: defaultWebSocketApiUrl(defaultValues.apiBaseUrl),
        protocols: '',
        payloadText: webSocketPayloadPresetText(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID) ?? '{}',
        timeoutMs: 5_000,
        closeCode: 1000,
        closeReason: 'rallar-black-box cleanup'
    };
}

function computeSynchronizedWebSocketValues(
    current: WebSocketCommandCenterValues,
    previous: WebSocketDefaultValues,
    next: WebSocketDefaultValues
): WebSocketCommandCenterValues {
    const synchronized = {
        ...current,
        apiBaseUrl: current.apiBaseUrl === previous.apiBaseUrl ? next.apiBaseUrl : current.apiBaseUrl,
        applicationId: current.applicationId === previous.applicationId ? next.applicationId : current.applicationId,
        workspaceId: current.workspaceId === previous.workspaceId ? next.workspaceId : current.workspaceId,
        groupId: current.groupId === previous.groupId || current.groupId === '' ? next.groupId : current.groupId,
        contextId: current.contextId === previous.contextId || current.contextId === previous.groupId ||
                current.contextId === ''
            ? next.contextId
            : current.contextId,
        wsUrl: current.wsUrl === defaultWebSocketApiUrl(previous.apiBaseUrl)
            ? defaultWebSocketApiUrl(next.apiBaseUrl)
            : current.wsUrl
    };
    return JSON.stringify(synchronized) === JSON.stringify(current) ? current : synchronized;
}

function valuesForPayloadPreset(
    current: WebSocketCommandCenterValues,
    presetId: string
): WebSocketCommandCenterValues {
    const preset = WEBSOCKET_PAYLOAD_PRESETS.find((entry) => entry.presetId === presetId);
    const payloadText = webSocketPayloadPresetText(presetId);
    return {
        ...current,
        ...preset?.values,
        contextId: preset?.values?.contextId ?? current.groupId ?? current.contextId,
        payloadText: payloadText ?? current.payloadText
    };
}

function shouldFollowGroup(values: WebSocketCommandCenterValues): boolean {
    return values.contextId === values.groupId || values.contextId === '' ||
        values.contextId === 'all' || values.contextId === values.wsScope;
}

function shouldFollowScope(values: WebSocketCommandCenterValues): boolean {
    return values.contextId === values.wsScope || values.contextId === values.groupId ||
        values.contextId === 'all' || values.contextId === 'world' || values.contextId === 'room';
}
