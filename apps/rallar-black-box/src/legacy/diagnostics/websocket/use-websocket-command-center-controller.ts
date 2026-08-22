import { selectRallarBlackBoxCurrentConfig } from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    createDirectRallarRuntimeEvent,
    runDirectRallarStatusCheck,
    runDirectRallarWsSend,
    runDirectRallarWsSubscribe,
    type DirectRallarOperationResult
} from '../../../direct-rallar-operations.ts';
import {
    rallarBlackBoxProviderModeFromConfig,
    rallarBlackBoxRuntimeStore,
    type RallarBlackBoxBootstrapConfig
} from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { recordValue as optionalRecord } from '../../shared/record-value.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatDuration, formatTime } from '../../shared/time-format.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../shell/rallar-browser-status.ts';
import {
    completedActionFeedback,
    idleActionFeedback,
    runningActionFeedback,
    type CommandCenterActionFeedback
} from '../shared/action-feedback.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import { observeRawWebSocket } from './observe-raw-web-socket.ts';
import { requestWebSocketTicket } from './request-web-socket-ticket.ts';
import type { WebSocketCommandCenterValues, WebSocketSubscriptionState } from './websocket-contracts.ts';
import { deriveWebSocketDiagnostics } from './websocket-diagnostics.ts';
import {
    DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID,
    WEBSOCKET_PAYLOAD_PRESETS,
    webSocketPayloadPresetById,
    webSocketPayloadPresetText
} from './websocket-presets.ts';
import { webSocketCommandCenterRecipe } from './websocket-recipes.ts';
import {
    defaultWebSocketApiUrl,
    defaultWebSocketScope,
    defaultWebSocketTopicId,
    defaultWebSocketTypeId,
    defaultWebSocketValuesFromContext,
    resolveWebSocketUrlTemplate,
    webSocketRoutePreview
} from './websocket-routing.ts';
import type { WebSocketCommandCenterViewModel } from './websocket-view-contracts.ts';

export type UseWebSocketCommandCenterControllerInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues?: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
}>;

export function useWebSocketCommandCenterController({
    state,
    bootstrap,
    authSession,
    globalValues,
    browserStatus
}: UseWebSocketCommandCenterControllerInput): WebSocketCommandCenterViewModel {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const providerMode = config
        ? rallarBlackBoxProviderModeFromConfig(config)
        : bootstrap.providerMode;
    const defaultContext = defaultWebSocketValuesFromContext(
        globalValues,
        config,
        bootstrap
    );
    const [values, setValues] = useState<WebSocketCommandCenterValues>(() => ({
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
    }));
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
    const rawSocketRef = useRef<WebSocket | undefined>(undefined);
    const rawSocketAuthKey = authSession
        ? `${authSession.clientId}:${authSession.sessionId}`
        : 'anonymous';
    const stateRef = useRef(state);
    const defaultContextRef = useRef(defaultContext);
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
    const payloadResult = useMemo(() => {
        try {
            return {
                ok: true as const,
                value: JSON.parse(values.payloadText) as unknown
            };
        }
        catch (error) {
            return {
                ok: false as const,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }, [values.payloadText]);

    useEffect(() => {
        stateRef.current = state;
    }, [state]);

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

    const updateValue = <K extends keyof WebSocketCommandCenterValues>(
        key: K,
        value: WebSocketCommandCenterValues[K]
    ): void => {
        setValues((current) => ({
            ...current,
            [key]: value
        }));
    };

    const updateGroupId = (groupId: string): void => {
        setValues((current) => ({
            ...current,
            groupId,
            contextId: current.contextId === current.groupId ||
                    current.contextId === '' ||
                    current.contextId === 'all' ||
                    current.contextId === current.wsScope
                ? groupId || current.wsScope
                : current.contextId
        }));
    };

    const updateWsScope = (
        wsScope: WebSocketCommandCenterValues['wsScope']
    ): void => {
        setValues((current) => ({
            ...current,
            wsScope,
            contextId: current.contextId === current.wsScope ||
                    current.contextId === current.groupId ||
                    current.contextId === 'all' ||
                    current.contextId === 'world' ||
                    current.contextId === 'room'
                ? wsScope === 'room'
                    ? current.groupId || 'room'
                    : wsScope
                : current.contextId
        }));
    };

    const selectPayloadPreset = (presetId: string): void => {
        setPayloadPresetId(presetId);
        const preset = WEBSOCKET_PAYLOAD_PRESETS.find(
            (entry) => entry.presetId === presetId
        );
        if (preset?.values) {
            setValues((current) => ({
                ...current,
                ...preset.values,
                contextId: preset.values?.contextId ??
                    current.groupId ??
                    current.contextId
            }));
        }
        const text = webSocketPayloadPresetText(presetId);
        if (text) {
            updateValue('payloadText', text);
        }
    };

    const directContext = (): Parameters<typeof runDirectRallarStatusCheck>[0] => ({
        providerMode,
        apiBaseUrl: values.apiBaseUrl,
        applicationId: values.applicationId,
        workspaceId: values.workspaceId,
        roomId: values.groupId.trim(),
        actor: authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        connection: values.connection,
        authSession,
        timeoutMs: values.timeoutMs
    });

    const recordWebSocketEvent = (
        topic: string,
        payload: unknown,
        lastAction: string,
        severity: RallarBlackBoxTestRuntimeEventInput['severity'] = 'info',
        kind: RallarBlackBoxTestRuntimeEventInput['kind'] = 'diagnostic'
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: directContext(),
                kind,
                transport: 'ws',
                severity,
                payload
            }),
            lastAction
        );
    };

    const recordDirectResult = (
        result: DirectRallarOperationResult,
        completedAction: string,
        failedAction: string
    ): void => {
        result.events.forEach((event) => rallarBlackBoxRuntimeStore.recordRuntimeEvent(event));
        if (result.status === 'failed') {
            setLocalError(result.error?.message ?? failedAction);
            setWaitStatus('failed');
        }
        else {
            setWaitStatus('completed');
        }
        recordWebSocketEvent(
            `rallar.direct.websocket.${result.kind}.${result.status}`,
            {
                status: result.status,
                durationMs: result.durationMs,
                value: result.value,
                error: result.error
            },
            result.status === 'failed' ? failedAction : completedAction,
            result.status === 'failed' ? 'error' : 'info',
            'state'
        );
    };

    const configure = async (): Promise<void> => {
        setBusyAction('Configure WebSocket');
        setLocalError(undefined);
        const label = 'Configure WebSocket';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                values.connection,
                'Recording the current WebSocket configuration.'
            )
        );
        try {
            setSequence((current) => current + 1);
            recordWebSocketEvent(
                'rallar.direct.raw_ws.configure.completed',
                {
                    connection: values.connection,
                    apiBaseUrl: values.apiBaseUrl,
                    wsUrl: values.wsUrl,
                    groupId: values.groupId,
                    selector: {
                        typeId: values.typeId,
                        topicId: values.topicId
                    }
                },
                'Configure WebSocket'
            );
            setWaitStatus('configured');
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.connection,
                    ok: true,
                    status: 'configured',
                    message: `Configured ${routePreview.destination}.`
                })
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.connection,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const requestWsTicket = async (
        requestId: string
    ): Promise<AuthCommandCenterTicket> => {
        const nextTicket = await requestWebSocketTicket({
            apiBaseUrl: values.apiBaseUrl,
            authSession,
            requestId,
            timeoutMs: values.timeoutMs
        });
        setTicket(nextTicket);
        return nextTicket;
    };

    const open = async (
        url = values.wsUrl,
        options: { useTicket?: boolean; } = { useTicket: true }
    ): Promise<void> => {
        const ticketRequestId = options.useTicket === false
            ? undefined
            : crypto.randomUUID();
        setBusyAction('Open WebSocket');
        setLocalError(undefined);
        const label = options.useTicket === false
            ? 'Open WebSocket without ticket'
            : 'Open WebSocket';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                url,
                options.useTicket === false
                    ? 'Opening raw WebSocket without acquiring a ticket.'
                    : 'Creating a ticket and opening the raw WebSocket.'
            )
        );
        try {
            const nextTicket = ticketRequestId === undefined
                ? undefined
                : await requestWsTicket(ticketRequestId);
            const resolvedUrl = resolveWebSocketUrlTemplate(
                url,
                values.apiBaseUrl,
                authSession,
                nextTicket
            );
            setActionFeedback(
                runningActionFeedback(
                    label,
                    resolvedUrl,
                    'Opening raw WebSocket connection.'
                )
            );
            const protocols = values.protocols
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            rawSocketRef.current?.close(values.closeCode, 'replace raw socket');
            const socket = new WebSocket(
                resolvedUrl,
                protocols.length > 0 ? protocols : undefined
            );
            rawSocketRef.current = socket;
            setSequence((current) => current + 1);
            observeRawWebSocket({
                socket,
                connection: values.connection,
                url: resolvedUrl,
                label,
                startedAtEpochMs,
                recordEvent: recordWebSocketEvent,
                setWaitStatus,
                setActionFeedback
            });
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: resolvedUrl,
                    ok: true,
                    status: 'requested',
                    message: 'Raw WebSocket open was requested.'
                })
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setWaitStatus('raw ws open failed');
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: url,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const send = async (): Promise<void> => {
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            setActionFeedback(
                completedActionFeedback({
                    label: 'Send WebSocket JSON',
                    startedAtEpochMs: Date.now(),
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'invalid payload',
                    message: payloadResult.error
                })
            );
            return;
        }
        if (values.wsScope === 'room' && !values.groupId.trim()) {
            const message = 'Room-scoped WS sends require a Group.';
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label: 'Send WebSocket JSON',
                    startedAtEpochMs: Date.now(),
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'invalid target',
                    message
                })
            );
            return;
        }
        setBusyAction('Send WebSocket JSON');
        setLocalError(undefined);
        const label = 'Send WebSocket JSON';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                routePreview.destination,
                `Sending ${routePreview.selector} through Rallar WS messages.`
            )
        );
        try {
            const result = await runDirectRallarWsSend(
                directContext(),
                {
                    scope: values.wsScope,
                    typeId: values.typeId,
                    topicId: values.topicId,
                    contextId: values.contextId,
                    resourceId: values.resourceId || undefined,
                    payload: payloadResult.value
                },
                loadBrowserRallarFacade
            );
            setSequence((current) => current + 1);
            recordDirectResult(
                result,
                'Rallar WS JSON sent',
                'Rallar WS send failed'
            );
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: routePreview.destination,
                    ok: result.status === 'completed',
                    status: result.status,
                    durationMs: result.durationMs,
                    message: result.status === 'completed'
                        ? `Sent ${routePreview.selector}.`
                        : (result.error?.message ??
                            'Rallar WS send failed.')
                })
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const close = async (reason = values.closeReason): Promise<void> => {
        setBusyAction('Close WebSocket');
        setLocalError(undefined);
        const label = 'Close WebSocket';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                values.wsUrl,
                'Closing the raw WebSocket if one is open.'
            )
        );
        try {
            const socket = rawSocketRef.current;
            rawSocketRef.current = undefined;
            socket?.close(values.closeCode, reason);
            recordWebSocketEvent(
                'rallar.direct.raw_ws.close.requested',
                {
                    connection: values.connection,
                    closeCode: values.closeCode,
                    closeReason: reason
                },
                'Close WebSocket'
            );
            setSequence((current) => current + 1);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.wsUrl,
                    ok: true,
                    status: socket ? 'close requested' : 'no socket',
                    message: socket
                        ? 'Raw WebSocket close was requested.'
                        : 'No raw WebSocket was open.'
                })
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.wsUrl,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const reconnect = async (): Promise<void> => {
        await close('reconnect');
        await open(values.wsUrl);
    };

    const cleanup = async (): Promise<void> => {
        setTicket(undefined);
        await close('cleanup');
    };

    const subscribeWs = async (): Promise<void> => {
        if (!values.typeId.trim()) {
            const message = 'WS subscription requires a Type ID.';
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label: 'Subscribe WS',
                    startedAtEpochMs: Date.now(),
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'invalid selector',
                    message
                })
            );
            return;
        }
        if (values.wsScope === 'room' && !values.groupId.trim()) {
            const message = 'Room-scoped WS subscriptions require a Group.';
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label: 'Subscribe WS',
                    startedAtEpochMs: Date.now(),
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'invalid target',
                    message
                })
            );
            return;
        }
        setBusyAction('Subscribe WS');
        setLocalError(undefined);
        const label = 'Subscribe WS';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                routePreview.destination,
                `Subscribing to ${routePreview.selector}.`
            )
        );
        try {
            subscription?.unsubscribe();
            const selector = {
                typeId: values.typeId,
                ...(values.topicId ? { topicId: values.topicId } : {})
            };
            const result = await runDirectRallarWsSubscribe(
                directContext(),
                selector,
                (message) => {
                    const record = optionalRecord(message);
                    recordWebSocketEvent(
                        'rallar.direct.ws.message',
                        {
                            roomId: record.roomId ??
                                record.groupId ??
                                values.groupId,
                            applicationId: values.applicationId,
                            workspaceId: values.workspaceId,
                            typeId: record.typeId ?? values.typeId,
                            topicId: record.topicId ?? values.topicId,
                            contextId: record.contextId ?? values.contextId,
                            resourceId: record.resourceId,
                            senderId: record.senderId,
                            data: record.payload ?? message,
                            raw: message
                        },
                        'Rallar WS message received',
                        'info',
                        'message'
                    );
                },
                loadBrowserRallarFacade
            );
            recordDirectResult(
                result,
                'Rallar WS subscribed',
                'Rallar WS subscribe failed'
            );
            if (result.status === 'completed' && result.unsubscribe) {
                setSubscription({
                    label: `${selector.topicId ?? '*'} / ${selector.typeId}`,
                    destination: routePreview.destination,
                    groupId: values.groupId,
                    subscribedAtEpochMs: Date.now(),
                    unsubscribe: result.unsubscribe
                });
                setWaitStatus('subscribed');
            }
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: routePreview.destination,
                    ok: result.status === 'completed',
                    status: result.status,
                    durationMs: result.durationMs,
                    message: result.status === 'completed'
                        ? `Subscribed to ${selector.topicId ?? '*'} / ${selector.typeId}.`
                        : (result.error?.message ??
                            'Rallar WS subscribe failed.')
                })
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: routePreview.destination,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const unsubscribeWs = (): void => {
        const startedAtEpochMs = Date.now();
        subscription?.unsubscribe();
        setSubscription(undefined);
        setWaitStatus('unsubscribed');
        setActionFeedback(
            completedActionFeedback({
                label: 'Unsubscribe WS',
                startedAtEpochMs,
                target: subscription?.destination ?? routePreview.destination,
                ok: true,
                status: subscription ? 'unsubscribed' : 'no subscription',
                message: subscription
                    ? 'Rallar WS subscription cleared.'
                    : 'No Rallar WS subscription was active.'
            })
        );
    };

    const createTicket = async (): Promise<void> => {
        const requestId = crypto.randomUUID();
        setBusyAction('Create WS ticket');
        setLocalError(undefined);
        const label = 'Create WS ticket';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                '/api/auth/ws-ticket',
                'Requesting a WebSocket ticket.'
            )
        );
        try {
            const nextTicket = await requestWsTicket(requestId);
            recordWebSocketEvent(
                'rallar.direct.raw_ws.ticket.created',
                {
                    sessionId: nextTicket.sessionId,
                    expiresAtEpochMs: nextTicket.expiresAtEpochMs,
                    ticket: '<redacted:ws-ticket>'
                },
                'Create WS ticket'
            );
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: '/api/auth/ws-ticket',
                    ok: true,
                    status: 'created',
                    message: `Ticket expires at ${formatTime(nextTicket.expiresAtEpochMs)}.`
                })
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: '/api/auth/ws-ticket',
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const waitForMessage = async (): Promise<void> => {
        const startCount = diagnostics.inboundCount;
        const startedAt = Date.now();
        const label = 'Wait for WS message';
        setWaitStatus('waiting');
        setBusyAction(label);
        setLocalError(undefined);
        setActionFeedback(
            runningActionFeedback(
                label,
                values.connection,
                `Waiting up to ${formatDuration(values.timeoutMs)} for inbound WS traffic.`
            )
        );
        try {
            await new Promise<void>((resolve, reject) => {
                const interval = window.setInterval(() => {
                    const latest = deriveWebSocketDiagnostics(
                        stateRef.current,
                        values.connection
                    );
                    if (latest.inboundCount > startCount) {
                        window.clearInterval(interval);
                        resolve();
                        return;
                    }
                    if (Date.now() - startedAt > values.timeoutMs) {
                        window.clearInterval(interval);
                        reject(
                            new Error(
                                'Timed out waiting for WebSocket message.'
                            )
                        );
                    }
                }, 100);
            });
            setWaitStatus('message observed');
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs: startedAt,
                    target: values.connection,
                    ok: true,
                    status: 'observed',
                    message: 'A WebSocket message was observed.'
                })
            );
        }
        catch (error) {
            setWaitStatus('timeout');
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs: startedAt,
                    target: values.connection,
                    ok: false,
                    statusText: 'timeout',
                    message
                })
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const waitForRallarWsOpen = async (): Promise<void> => {
        setBusyAction('Wait for Rallar WS open');
        setLocalError(undefined);
        const label = 'Wait for Rallar WS open';
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                values.apiBaseUrl,
                'Starting Rallar signaling and waiting for WS open.'
            )
        );
        try {
            if (providerMode !== 'browser-rallar') {
                throw new Error(
                    'Rallar WS wait requires provider=browser-rallar.'
                );
            }
            if (!authSession) {
                throw new Error(
                    'Rallar WS wait requires a logged-in browser session.'
                );
            }
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: values.apiBaseUrl });
            facade.setDefaults({
                applicationId: values.applicationId,
                workspaceId: values.workspaceId,
                room: values.groupId
                    ? {
                        roomId: values.groupId,
                        roomRef: {
                            applicationId: values.applicationId,
                            workspaceId: values.workspaceId,
                            groupId: values.groupId
                        }
                    }
                    : undefined
            });
            await facade.start({
                connect: true,
                refreshRooms: false,
                refreshPeople: false,
                timeoutMs: values.timeoutMs
            });
            const result = await facade.ws.waitForOpen({
                timeoutMs: values.timeoutMs
            });
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                createDirectRallarRuntimeEvent({
                    topic: result.status === 'open'
                        ? 'rallar.direct.ws.wait_open.completed'
                        : 'rallar.direct.ws.wait_open.failed',
                    context: {
                        providerMode,
                        apiBaseUrl: values.apiBaseUrl,
                        applicationId: values.applicationId,
                        workspaceId: values.workspaceId,
                        roomId: values.groupId,
                        actor: authSession.username ??
                            authSession.clientId ??
                            bootstrap.actor,
                        connection: values.connection,
                        authSession,
                        timeoutMs: values.timeoutMs
                    },
                    transport: 'ws',
                    severity: result.status === 'open' ? 'info' : 'error',
                    payload: result
                }),
                result.status === 'open'
                    ? 'Rallar WS open observed'
                    : 'Rallar WS open wait failed'
            );
            setWaitStatus(
                result.status === 'open' ? 'rallar ws open' : result.status
            );
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.apiBaseUrl,
                    ok: result.status === 'open',
                    status: result.status,
                    message: result.status === 'open'
                        ? 'Rallar signaling WebSocket is open.'
                        : 'Rallar signaling WebSocket did not open.'
                })
            );
        }
        catch (error) {
            setWaitStatus('rallar ws wait failed');
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: values.apiBaseUrl,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    values,
                    diagnostics,
                    subscription: subscription
                        ? {
                            label: subscription.label,
                            destination: subscription.destination,
                            groupId: subscription.groupId,
                            subscribedAtEpochMs: subscription.subscribedAtEpochMs
                        }
                        : undefined,
                    ticket: ticket
                        ? {
                            ...ticket,
                            ticket: '<redacted:ws-ticket>',
                            expiresInMs: ticket.expiresAtEpochMs - Date.now()
                        }
                        : undefined,
                    waitStatus
                },
                state,
                authSession
            )
        );
    };

    const copyRecipe = (includeRtcParity = false): void => {
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            return;
        }
        void navigator.clipboard?.writeText(
            webSocketCommandCenterRecipe({
                values,
                payload: payloadResult.value,
                bootstrap,
                providerMode,
                authSession,
                sequence,
                includeRtcParity
            })
        );
    };

    const openMissingTicket = (): Promise<void> =>
        open('{config.wsBaseUrl}/api/ws/{auth.sessionId}', {
            useTicket: false
        });

    return {
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
        openMissingTicket
    };
}

export type WebSocketCommandCenterControllerModel = ReturnType<typeof useWebSocketCommandCenterController>;
