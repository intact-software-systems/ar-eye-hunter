import type {
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/types.ts';
import type { RallarMessage, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { Either } from '@shared/resilience/Either.ts';
import type * as React from 'react';
import {
    createDirectRallarRuntimeEvent,
    runDirectRallarWsSend,
    runDirectRallarWsSubscribe,
    type DirectRallarOperationContext,
    type DirectRallarOperationResult
} from '../../../direct-rallar-operations.ts';
import {
    rallarBlackBoxRuntimeStore
} from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatDuration, formatTime } from '../../shared/time-format.ts';
import {
    completedActionFeedback,
    runningActionFeedback,
    type CommandCenterActionFeedback
} from '../shared/action-feedback.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import type { DiagnosticControllerLifecycle } from '../shared/diagnostic-controller-lifecycle.ts';
import { observeRawWebSocket, type WebSocketRecordedEvent } from './observe-raw-web-socket.ts';
import { requestWebSocketTicket } from './request-web-socket-ticket.ts';
import type { UseWebSocketCommandCenterControllerInput } from './use-websocket-command-center-controller.ts';
import type {
    WebSocketCommandCenterValues,
    WebSocketDiagnostic,
    WebSocketRoutePreview,
    WebSocketSubscriptionState
} from './websocket-contracts.ts';
import { deriveWebSocketDiagnostics } from './websocket-diagnostics.ts';
import {
    WEBSOCKET_PAYLOAD_PRESETS,
    webSocketPayloadPresetText
} from './websocket-presets.ts';
import { webSocketCommandCenterRecipe } from './websocket-recipes.ts';
import {
    resolveWebSocketUrlTemplate
} from './websocket-routing.ts';

export namespace WebSocketCommandCenterActions {
    export interface Input extends UseWebSocketCommandCenterControllerInput {
        nowMs(): number;
        createRequestId(): string;
        readonly providerMode: 'browser-rallar' | 'simulated';
        readonly values: WebSocketCommandCenterValues;
        readonly setValues: React.Dispatch<React.SetStateAction<WebSocketCommandCenterValues>>;
        readonly setPayloadPresetId: React.Dispatch<React.SetStateAction<string>>;
        readonly sequence: number;
        readonly setSequence: React.Dispatch<React.SetStateAction<number>>;
        readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly setActionFeedback: React.Dispatch<React.SetStateAction<CommandCenterActionFeedback>>;
        readonly waitStatus: string;
        readonly setWaitStatus: React.Dispatch<React.SetStateAction<string>>;
        readonly ticket: AuthCommandCenterTicket | undefined;
        readonly setTicket: React.Dispatch<React.SetStateAction<AuthCommandCenterTicket | undefined>>;
        readonly subscription: WebSocketSubscriptionState | undefined;
        readonly setSubscription: React.Dispatch<React.SetStateAction<WebSocketSubscriptionState | undefined>>;
        readonly rawSocketRef: React.RefObject<WebSocket | undefined>;
        readonly stateRef: React.RefObject<RallarBlackBoxTestState>;
        readonly diagnostics: WebSocketDiagnostic;
        readonly routePreview: WebSocketRoutePreview;
        readonly payloadResult: {
            readonly ok: true;
            readonly value: import('@shared-web/browser/messages/rallar-message-contracts.ts').RallarMessagePayload;
        } | { readonly ok: false; readonly error: string; };
        readonly lifetime: DiagnosticControllerLifecycle;
        readonly rawSocketLifetime: DiagnosticControllerLifecycle;
    }
    export interface OpenAttempt {
        readonly ticketRequestId: string | undefined;
        readonly url: string;
        readonly label: string;
        readonly startedAtEpochMs: number;
        readonly signal: AbortSignal;
    }
    export interface SubscribeAttempt {
        readonly label: string;
        readonly startedAtEpochMs: number;
    }
}
export class WebSocketCommandCenterActions {
    private readonly input: WebSocketCommandCenterActions.Input;
    constructor(input: WebSocketCommandCenterActions.Input) {
        this.input = input;
    }
    public readonly updateValue = <K extends keyof WebSocketCommandCenterValues>(
        key: K,
        value: WebSocketCommandCenterValues[K]
    ): void => {
        this.input.setValues((current) => ({
            ...current,
            [key]: value
        }));
    };
    public readonly updateGroupId = (groupId: string): void => {
        this.input.setValues((current) => ({
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
    public readonly updateWsScope = (
        wsScope: WebSocketCommandCenterValues['wsScope']
    ): void => {
        this.input.setValues((current) => ({
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
    public readonly selectPayloadPreset = (presetId: string): void => {
        this.input.setPayloadPresetId(presetId);
        const preset = WEBSOCKET_PAYLOAD_PRESETS.find(
            (entry) => entry.presetId === presetId
        );
        if (preset?.values) {
            this.input.setValues((current) => ({
                ...current,
                ...preset.values,
                contextId: preset.values?.contextId ??
                    current.groupId ??
                    current.contextId
            }));
        }
        const text = webSocketPayloadPresetText(presetId);
        if (text) {
            this.updateValue('payloadText', text);
        }
    };
    public readonly directContext = (): DirectRallarOperationContext => ({
        providerMode: this.input.providerMode,
        apiBaseUrl: this.input.values.apiBaseUrl,
        applicationId: this.input.values.applicationId,
        workspaceId: this.input.values.workspaceId,
        roomId: this.input.values.groupId.trim(),
        actor: this.input.authSession?.username ?? this.input.authSession?.clientId ?? this.input.bootstrap.actor,
        connection: this.input.values.connection,
        authSession: this.input.authSession,
        timeoutMs: this.input.values.timeoutMs
    });
    public readonly recordWebSocketEvent = (
        { topic, payload, lastAction, severity = 'info', kind = 'diagnostic' }: WebSocketRecordedEvent
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: this.directContext(),
                kind,
                transport: 'ws',
                severity,
                payload
            }),
            lastAction
        );
    };
    public readonly recordDirectResult = (
        result: DirectRallarOperationResult,
        completedAction: string,
        failedAction: string
    ): void => {
        result.events.forEach((event) => rallarBlackBoxRuntimeStore.recordRuntimeEvent(event));
        if (result.status === 'failed') {
            this.input.setLocalError(result.error?.message ?? failedAction);
            this.input.setWaitStatus('failed');
        }
        else {
            this.input.setWaitStatus('completed');
        }
        this.recordWebSocketEvent(
            {
                topic: `rallar.direct.websocket.${result.kind}.${result.status}`,
                payload: {
                    status: result.status,
                    durationMs: result.durationMs,
                    value: result.value,
                    error: result.error
                },
                lastAction: result.status === 'failed' ? failedAction : completedAction,
                severity: result.status === 'failed' ? 'error' : 'info',
                kind: 'state'
            }
        );
    };
    public readonly configure = async (): Promise<void> => {
        this.input.setBusyAction('Configure WebSocket');
        this.input.setLocalError(undefined);
        const label = 'Configure WebSocket';
        const startedAtEpochMs = this.input.nowMs();
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                this.input.values.connection,
                'Recording the current WebSocket configuration.'
            )
        );
        try {
            this.input.setSequence((current) => current + 1);
            this.recordWebSocketEvent(
                {
                    topic: 'rallar.direct.raw_ws.configure.completed',
                    payload: {
                        connection: this.input.values.connection,
                        apiBaseUrl: this.input.values.apiBaseUrl,
                        wsUrl: this.input.values.wsUrl,
                        groupId: this.input.values.groupId,
                        selector: {
                            typeId: this.input.values.typeId,
                            topicId: this.input.values.topicId
                        }
                    },
                    lastAction: 'Configure WebSocket'
                }
            );
            this.input.setWaitStatus('configured');
            this.input.setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: this.input.values.connection,
                    ok: true,
                    status: 'configured',
                    message: `Configured ${this.input.routePreview.destination}.`
                })
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.input.setLocalError(message);
            this.input.setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: this.input.values.connection,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            this.input.setBusyAction(undefined);
        }
    };
    public readonly requestWsTicket = async (
        requestId: string,
        signal: AbortSignal
    ): Promise<AuthCommandCenterTicket> => {
        const nextTicket = await requestWebSocketTicket({
            apiBaseUrl: this.input.values.apiBaseUrl,
            authSession: this.input.authSession,
            requestId,
            timeoutMs: this.input.values.timeoutMs
        });
        if (!signal.aborted) {
            this.input.setTicket(nextTicket);
        }
        return nextTicket;
    };
    public readonly open = async (
        url = this.input.values.wsUrl,
        options: { useTicket?: boolean; } = { useTicket: true }
    ): Promise<void> => {
        const signal = this.input.rawSocketLifetime.signal;
        if (signal.aborted) {
            return;
        }
        const ticketRequestId = options.useTicket === false
            ? undefined
            : this.input.createRequestId();
        this.input.setBusyAction('Open WebSocket');
        this.input.setLocalError(undefined);
        const label = options.useTicket === false
            ? 'Open WebSocket without ticket'
            : 'Open WebSocket';
        const startedAtEpochMs = this.input.nowMs();
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                url,
                options.useTicket === false
                    ? 'Opening raw WebSocket without acquiring a ticket.'
                    : 'Creating a ticket and opening the raw WebSocket.'
            )
        );
        try {
            await this.openRawSocket({ ticketRequestId, url, label, startedAtEpochMs, signal: signal });
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.input.setLocalError(message);
            this.input.setWaitStatus('raw ws open failed');
            this.input.setActionFeedback(
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
            if (signal.aborted) {
                return;
            }
            this.input.setBusyAction(undefined);
        }
    };
    public readonly send = async (): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        if (!this.input.payloadResult.ok) {
            this.rejectAction('Send WebSocket JSON', 'invalid payload', this.input.payloadResult.error);
            return;
        }
        if (this.input.values.wsScope === 'room' && !this.input.values.groupId.trim()) {
            const message = 'Room-scoped WS sends require a Group.';
            this.rejectAction('Send WebSocket JSON', 'invalid target', message);
            return;
        }
        this.input.setBusyAction('Send WebSocket JSON');
        this.input.setLocalError(undefined);
        const label = 'Send WebSocket JSON';
        const startedAtEpochMs = this.input.nowMs();
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                this.input.routePreview.destination,
                `Sending ${this.input.routePreview.selector} through Rallar WS messages.`
            )
        );
        try {
            await this.sendRoomMessage(label, startedAtEpochMs, this.input.payloadResult.value);
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.input.setLocalError(message);
            this.input.setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: this.input.routePreview.destination,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            if (signal.aborted) {
                return;
            }
            this.input.setBusyAction(undefined);
        }
    };
    public readonly close = async (reason = this.input.values.closeReason): Promise<void> => {
        this.input.setBusyAction('Close WebSocket');
        this.input.setLocalError(undefined);
        const label = 'Close WebSocket';
        const startedAtEpochMs = this.input.nowMs();
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                this.input.values.wsUrl,
                'Closing the raw WebSocket if one is open.'
            )
        );
        try {
            const socket = this.input.rawSocketRef.current;
            this.input.rawSocketRef.current = undefined;
            socket?.close(this.input.values.closeCode, reason);
            this.recordWebSocketEvent(
                {
                    topic: 'rallar.direct.raw_ws.close.requested',
                    payload: {
                        connection: this.input.values.connection,
                        closeCode: this.input.values.closeCode,
                        closeReason: reason
                    },
                    lastAction: 'Close WebSocket'
                }
            );
            this.input.setSequence((current) => current + 1);
            this.input.setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: this.input.values.wsUrl,
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
            this.input.setLocalError(message);
            this.input.setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: this.input.values.wsUrl,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            this.input.setBusyAction(undefined);
        }
    };
    public readonly reconnect = async (): Promise<void> => {
        await this.close('reconnect');
        await this.open(this.input.values.wsUrl);
    };
    public readonly cleanup = async (): Promise<void> => {
        this.input.setTicket(undefined);
        const closing = this.close('cleanup');
        this.input.rawSocketLifetime.close();
        this.input.rawSocketLifetime.activate();
        await closing;
    };
    public readonly subscribeWs = async (): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        if (!this.input.values.typeId.trim()) {
            const message = 'WS subscription requires a Type ID.';
            this.rejectAction('Subscribe WS', 'invalid selector', message);
            return;
        }
        if (this.input.values.wsScope === 'room' && !this.input.values.groupId.trim()) {
            const message = 'Room-scoped WS subscriptions require a Group.';
            this.rejectAction('Subscribe WS', 'invalid target', message);
            return;
        }
        this.input.setBusyAction('Subscribe WS');
        this.input.setLocalError(undefined);
        const label = 'Subscribe WS';
        const startedAtEpochMs = this.input.nowMs();
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                this.input.routePreview.destination,
                `Subscribing to ${this.input.routePreview.selector}.`
            )
        );
        try {
            await this.subscribeRoomMessages({ label, startedAtEpochMs }, signal);
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.input.setLocalError(message);
            this.input.setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: this.input.routePreview.destination,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            if (signal.aborted) {
                return;
            }
            this.input.setBusyAction(undefined);
        }
    };
    public readonly unsubscribeWs = (): void => {
        const startedAtEpochMs = this.input.nowMs();
        this.input.subscription?.unsubscribe();
        this.input.setSubscription(undefined);
        this.input.setWaitStatus('unsubscribed');
        this.input.setActionFeedback(
            completedActionFeedback({
                label: 'Unsubscribe WS',
                startedAtEpochMs,
                target: this.input.subscription?.destination ?? this.input.routePreview.destination,
                ok: true,
                status: this.input.subscription ? 'unsubscribed' : 'no subscription',
                message: this.input.subscription
                    ? 'Rallar WS subscription cleared.'
                    : 'No Rallar WS subscription was active.'
            })
        );
    };
    public readonly createTicket = async (): Promise<void> => {
        const signal = this.input.rawSocketLifetime.signal;
        if (signal.aborted) {
            return;
        }
        const requestId = this.input.createRequestId();
        this.input.setBusyAction('Create WS ticket');
        this.input.setLocalError(undefined);
        const label = 'Create WS ticket';
        const startedAtEpochMs = this.input.nowMs();
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                '/api/auth/ws-ticket',
                'Requesting a WebSocket ticket.'
            )
        );
        try {
            const nextTicket = await this.requestWsTicket(requestId, signal);
            if (signal.aborted) {
                return;
            }
            this.publishCreatedTicket(nextTicket, label, startedAtEpochMs);
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.input.setLocalError(message);
            this.input.setActionFeedback(
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
            if (signal.aborted) {
                return;
            }
            this.input.setBusyAction(undefined);
        }
    };
    public readonly waitForMessage = async (): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        const startCount = this.input.diagnostics.inboundCount;
        const startedAt = this.input.nowMs();
        const label = 'Wait for WS message';
        this.input.setWaitStatus('waiting');
        this.input.setBusyAction(label);
        this.input.setLocalError(undefined);
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                this.input.values.connection,
                `Waiting up to ${formatDuration(this.input.values.timeoutMs)} for inbound WS traffic.`
            )
        );
        try {
            const outcome = await this.waitForInboundMessage(startCount, startedAt);
            if (signal.aborted || outcome === 'aborted') {
                return;
            }
            if (outcome === 'timeout') {
                this.publishReceiveTimeout(startedAt);
                return;
            }
            this.input.setWaitStatus('message observed');
            this.input.setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs: startedAt,
                    target: this.input.values.connection,
                    ok: true,
                    status: 'observed',
                    message: 'A WebSocket message was observed.'
                })
            );
        }
        finally {
            if (signal.aborted) {
                return;
            }
            this.input.setBusyAction(undefined);
        }
    };
    public readonly waitForRallarWsOpen = async (): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        this.input.setBusyAction('Wait for Rallar WS open');
        this.input.setLocalError(undefined);
        const label = 'Wait for Rallar WS open';
        const startedAtEpochMs = this.input.nowMs();
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                this.input.values.apiBaseUrl,
                'Starting Rallar signaling and waiting for WS open.'
            )
        );
        try {
            await this.waitForSignalingOpen(label, startedAtEpochMs);
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }
            this.input.setWaitStatus('rallar ws wait failed');
            const message = error instanceof Error ? error.message : String(error);
            this.input.setLocalError(message);
            this.input.setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: this.input.values.apiBaseUrl,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
        }
        finally {
            if (signal.aborted) {
                return;
            }
            this.input.setBusyAction(undefined);
        }
    };
    public readonly copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    values: this.input.values,
                    diagnostics: this.input.diagnostics,
                    subscription: this.input.subscription
                        ? {
                            label: this.input.subscription.label,
                            destination: this.input.subscription.destination,
                            groupId: this.input.subscription.groupId,
                            subscribedAtEpochMs: this.input.subscription.subscribedAtEpochMs
                        }
                        : undefined,
                    ticket: this.input.ticket
                        ? {
                            ...this.input.ticket,
                            ticket: '<redacted:ws-ticket>',
                            expiresInMs: this.input.ticket.expiresAtEpochMs - this.input.nowMs()
                        }
                        : undefined,
                    waitStatus: this.input.waitStatus
                },
                this.input.state,
                this.input.authSession
            )
        );
    };
    public readonly copyRecipe = (includeRtcParity = false): void => {
        if (!this.input.payloadResult.ok) {
            this.input.setLocalError(this.input.payloadResult.error);
            return;
        }
        void navigator.clipboard?.writeText(
            webSocketCommandCenterRecipe({
                values: this.input.values,
                payload: this.input.payloadResult.value,
                bootstrap: this.input.bootstrap,
                providerMode: this.input.providerMode,
                authSession: this.input.authSession,
                sequence: this.input.sequence,
                includeRtcParity
            })
        );
    };
    public readonly openMissingTicket = (): Promise<void> =>
        this.open('{config.wsBaseUrl}/api/ws/{auth.sessionId}', {
            useTicket: false
        });

    private async waitForInboundMessage(
        startCount: number,
        startedAt: number
    ): Promise<DiagnosticControllerLifecycle.Observation> {
        return await this.input.lifetime.waitForObservation({
            hasObserved: () =>
                deriveWebSocketDiagnostics(this.input.stateRef.current, this.input.values.connection).inboundCount >
                    startCount,
            nowMs: this.input.nowMs,
            startedAtEpochMs: startedAt,
            timeoutMs: this.input.values.timeoutMs
        });
    }

    private async openRawSocket(attempt: WebSocketCommandCenterActions.OpenAttempt): Promise<void> {
        const { ticketRequestId, url, label, startedAtEpochMs, signal } = attempt;

        const nextTicket = ticketRequestId === undefined
            ? undefined
            : await this.requestWsTicket(ticketRequestId, signal);
        if (signal.aborted) {
            return;
        }
        const resolvedUrl = resolveWebSocketUrlTemplate(
            url,
            this.input.values.apiBaseUrl,
            this.input.authSession,
            nextTicket
        );
        this.input.setActionFeedback(
            runningActionFeedback(
                label,
                resolvedUrl,
                'Opening raw WebSocket connection.'
            )
        );
        this.installRawSocket(attempt, resolvedUrl);
    }

    private async subscribeRoomMessages(
        attempt: WebSocketCommandCenterActions.SubscribeAttempt,
        signal: AbortSignal
    ): Promise<void> {
        const { label, startedAtEpochMs } = attempt;

        this.input.subscription?.unsubscribe();
        const selector = {
            typeId: this.input.values.typeId,
            ...(this.input.values.topicId ? { topicId: this.input.values.topicId } : {})
        };
        const result = await runDirectRallarWsSubscribe(
            {
                context: this.directContext(),
                selector: selector,
                handler: (message) => this.receiveRoomMessage(message),
                loadFacade: loadBrowserRallarFacade,
                signal: signal,
                subscriptions: this.input.lifetime.subscriptions
            }
        );
        if (signal.aborted) {
            return;
        }
        this.recordDirectResult(
            result,
            'Rallar WS subscribed',
            'Rallar WS subscribe failed'
        );
        if (result.status === 'completed' && result.unsubscribe) {
            this.input.setSubscription({
                label: `${selector.topicId ?? '*'} / ${selector.typeId}`,
                destination: this.input.routePreview.destination,
                groupId: this.input.values.groupId,
                subscribedAtEpochMs: this.input.nowMs(),
                unsubscribe: result.unsubscribe
            });
            this.input.setWaitStatus('subscribed');
        }
        this.input.setActionFeedback(
            completedActionFeedback({
                label,
                startedAtEpochMs,
                target: this.input.routePreview.destination,
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

    private async sendRoomMessage(
        label: string,
        startedAtEpochMs: number,
        payload: import('@shared-web/browser/messages/rallar-message-contracts.ts').RallarMessagePayload
    ): Promise<void> {
        const signal = this.input.lifetime.signal;
        const result = await runDirectRallarWsSend(
            this.directContext(),
            {
                scope: this.input.values.wsScope,
                typeId: this.input.values.typeId,
                topicId: this.input.values.topicId,
                contextId: this.input.values.contextId,
                resourceId: this.input.values.resourceId || undefined,
                payload: payload
            },
            loadBrowserRallarFacade
        );
        if (signal.aborted) {
            return;
        }
        this.input.setSequence((current) => current + 1);
        this.recordDirectResult(
            result,
            'Rallar WS JSON sent',
            'Rallar WS send failed'
        );
        this.input.setActionFeedback(
            completedActionFeedback({
                label,
                startedAtEpochMs,
                target: this.input.routePreview.destination,
                ok: result.status === 'completed',
                status: result.status,
                durationMs: result.durationMs,
                message: result.status === 'completed'
                    ? `Sent ${this.input.routePreview.selector}.`
                    : (result.error?.message ??
                        'Rallar WS send failed.')
            })
        );
    }

    private async waitForSignalingOpen(label: string, startedAtEpochMs: number): Promise<void> {
        const signal = this.input.lifetime.signal;
        const outcome = await this.startSignalingFacade();
        if (signal.aborted) {
            return;
        }
        await outcome.fold(
            async (message) => this.publishSignalingFailure(label, startedAtEpochMs, message),
            async (facade) => {
                const result = await facade.ws.waitForOpen({
                    timeoutMs: this.input.values.timeoutMs
                });
                if (signal.aborted) {
                    return;
                }
                rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                    createDirectRallarRuntimeEvent({
                        topic: result.status === 'open'
                            ? 'rallar.direct.ws.wait_open.completed'
                            : 'rallar.direct.ws.wait_open.failed',
                        context: this.directContext(),
                        transport: 'ws',
                        severity: result.status === 'open' ? 'info' : 'error',
                        payload: result
                    }),
                    result.status === 'open'
                        ? 'Rallar WS open observed'
                        : 'Rallar WS open wait failed'
                );
                this.input.setWaitStatus(
                    result.status === 'open' ? 'rallar ws open' : result.status
                );
                this.input.setActionFeedback(
                    completedActionFeedback({
                        label,
                        startedAtEpochMs,
                        target: this.input.values.apiBaseUrl,
                        ok: result.status === 'open',
                        status: result.status,
                        message: result.status === 'open'
                            ? 'Rallar signaling WebSocket is open.'
                            : 'Rallar signaling WebSocket did not open.'
                    })
                );
            }
        );
    }

    private rejectAction(label: string, statusText: string, message: string): void {
        this.input.setLocalError(message);
        this.input.setActionFeedback(
            completedActionFeedback({
                label,
                startedAtEpochMs: this.input.nowMs(),
                target: this.input.routePreview.destination,
                ok: false,
                statusText,
                message
            })
        );
    }

    private receiveRoomMessage(message: RallarMessage<RallarMessagePayload>): void {
        this.recordWebSocketEvent(
            {
                topic: 'rallar.direct.ws.message',
                payload: {
                    roomId: message.roomId ?? this.input.values.groupId,
                    applicationId: this.input.values.applicationId,
                    workspaceId: this.input.values.workspaceId,
                    typeId: message.typeId,
                    topicId: message.topicId,
                    contextId: message.contextId,
                    resourceId: message.resourceId,
                    senderId: message.senderId,
                    data: message.payload,
                    raw: message
                },
                lastAction: 'Rallar WS message received',
                severity: 'info',
                kind: 'message'
            }
        );
    }

    private async startSignalingFacade(): Promise<Either<string, RallarFacade>> {
        const signal = this.input.lifetime.signal;
        if (this.input.providerMode !== 'browser-rallar') {
            return Either.ofLeft('Rallar WS wait requires provider=browser-rallar.');
        }
        if (!this.input.authSession) {
            return Either.ofLeft('Rallar WS wait requires a logged-in browser session.');
        }
        const facade = await loadBrowserRallarFacade();
        if (signal.aborted) {
            return Either.ofLeft('Rallar WS wait was abandoned.');
        }
        facade.configure({ apiBaseUrl: this.input.values.apiBaseUrl });
        facade.setDefaults({
            applicationId: this.input.values.applicationId,
            workspaceId: this.input.values.workspaceId,
            room: this.input.values.groupId
                ? {
                    roomId: this.input.values.groupId,
                    roomRef: {
                        applicationId: this.input.values.applicationId,
                        workspaceId: this.input.values.workspaceId,
                        groupId: this.input.values.groupId
                    }
                }
                : undefined
        });
        await facade.start({
            connect: true,
            refreshRooms: false,
            refreshPeople: false,
            timeoutMs: this.input.values.timeoutMs
        });
        return Either.ofRight(facade);
    }

    private publishSignalingFailure(label: string, startedAtEpochMs: number, message: string): void {
        this.input.setWaitStatus('rallar ws wait failed');
        this.input.setLocalError(message);
        this.input.setActionFeedback(
            completedActionFeedback({
                label,
                startedAtEpochMs,
                target: this.input.values.apiBaseUrl,
                ok: false,
                statusText: 'error',
                message
            })
        );
    }

    private publishReceiveTimeout(startedAt: number): void {
        const label = 'Wait for WS message';
        this.input.setWaitStatus('timeout');
        const message = 'Timed out waiting for WebSocket message.';
        this.input.setLocalError(message);
        this.input.setActionFeedback(
            completedActionFeedback({
                label,
                startedAtEpochMs: startedAt,
                target: this.input.values.connection,
                ok: false,
                statusText: 'timeout',
                message
            })
        );
    }

    private installRawSocket(attempt: WebSocketCommandCenterActions.OpenAttempt, resolvedUrl: string): void {
        const { label, startedAtEpochMs, signal } = attempt;
        const protocols = this.input.values.protocols
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
        this.input.rawSocketRef.current?.close(this.input.values.closeCode, 'replace raw socket');
        const socket = new WebSocket(
            resolvedUrl,
            protocols.length > 0 ? protocols : undefined
        );
        this.input.rawSocketRef.current = socket;
        this.input.rawSocketLifetime.subscriptions.add(() => {
            if (this.input.rawSocketRef.current === socket) {
                this.input.rawSocketRef.current = undefined;
            }
            if (socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) {
                socket.close(1000, 'rallar-black-box auth cleanup');
            }
        });
        this.input.setSequence((current) => current + 1);
        observeRawWebSocket({
            socket,
            connection: this.input.values.connection,
            url: resolvedUrl,
            label,
            startedAtEpochMs,
            recordEvent: this.recordWebSocketEvent,
            setWaitStatus: this.input.setWaitStatus,
            setActionFeedback: this.input.setActionFeedback,
            signal: signal
        });
        this.input.setActionFeedback(
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

    private publishCreatedTicket(nextTicket: AuthCommandCenterTicket, label: string, startedAtEpochMs: number): void {
        this.recordWebSocketEvent(
            {
                topic: 'rallar.direct.raw_ws.ticket.created',
                payload: {
                    sessionId: nextTicket.sessionId,
                    expiresAtEpochMs: nextTicket.expiresAtEpochMs,
                    ticket: '<redacted:ws-ticket>'
                },
                lastAction: 'Create WS ticket'
            }
        );
        this.input.setActionFeedback(
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
}
