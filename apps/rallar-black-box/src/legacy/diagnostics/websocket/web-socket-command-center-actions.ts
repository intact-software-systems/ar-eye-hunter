import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type * as React from 'react';
import {
    createDirectRallarRuntimeEvent,
    type DirectRallarOperationContext,
    type DirectRallarOperationResult
} from '../../../direct-rallar-operations.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { writeTextToClipboard } from '../../shared/write-text-to-clipboard.ts';
import {
    completedActionFeedback,
    runningActionFeedback,
    type CommandCenterActionFeedback
} from '../shared/action-feedback.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import type { DiagnosticControllerLifecycle } from '../shared/diagnostic-controller-lifecycle.ts';
import type { WebSocketRecordedEvent } from './observe-raw-web-socket.ts';
import { toWebSocketCommandCenterRecipeText } from './to-web-socket-command-center-recipe-text.ts';
import type {
    UseWebSocketCommandCenterControllerInput,
    WebSocketCommandCenterValues,
    WebSocketDiagnostic,
    WebSocketRoutePreview,
    WebSocketSubscriptionState
} from './websocket-contracts.ts';
import { WEBSOCKET_PAYLOAD_PRESETS, webSocketPayloadPresetText } from './websocket-presets.ts';

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
            readonly value: RallarMessagePayload;
        } | { readonly ok: false; readonly error: string; };
        readonly lifetime: DiagnosticControllerLifecycle;
        readonly rawSocketLifetime: DiagnosticControllerLifecycle;
    }
    export interface Attempt {
        readonly label: string;
        readonly target: string;
        readonly runningMessage: string;
        readonly signal: AbortSignal | undefined;
        readonly failedWaitStatus: string | undefined;
        run(startedAtEpochMs: number): Promise<void> | void;
    }
    export interface Failure {
        readonly label: string;
        readonly target: string;
        readonly failedWaitStatus: string | undefined;
        readonly startedAtEpochMs: number;
        readonly message: string;
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
            contextId: isDefaultGroupContext(current)
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
            contextId: isDefaultScopeContext(current)
                ? toScopeDefaultContext(wsScope, current.groupId)
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
        const failed = result.status === 'failed';
        if (failed) {
            this.input.setLocalError(result.error?.message ?? failedAction);
        }
        this.input.setWaitStatus(failed ? 'failed' : 'completed');
        this.recordWebSocketEvent(
            {
                topic: `rallar.direct.websocket.${result.kind}.${result.status}`,
                payload: {
                    status: result.status,
                    durationMs: result.durationMs,
                    value: result.value,
                    error: result.error
                },
                lastAction: failed ? failedAction : completedAction,
                severity: failed ? 'error' : 'info',
                kind: 'state'
            }
        );
    };
    public readonly runAction = async (attempt: WebSocketCommandCenterActions.Attempt): Promise<void> => {
        const { label, target, signal } = attempt;
        if (signal?.aborted) {
            return;
        }
        this.input.setBusyAction(label);
        this.input.setLocalError(undefined);
        const startedAtEpochMs = this.input.nowMs();
        this.input.setActionFeedback(runningActionFeedback(label, target, attempt.runningMessage));
        try {
            await attempt.run(startedAtEpochMs);
        }
        catch (error) {
            if (signal?.aborted) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.failAction({ label, target, failedWaitStatus: attempt.failedWaitStatus, startedAtEpochMs, message });
        }
        finally {
            if (!signal?.aborted) {
                this.input.setBusyAction(undefined);
            }
        }
    };
    public readonly failAction = (failure: WebSocketCommandCenterActions.Failure): void => {
        const { label, target, failedWaitStatus, startedAtEpochMs, message } = failure;
        this.input.setLocalError(message);
        if (failedWaitStatus !== undefined) {
            this.input.setWaitStatus(failedWaitStatus);
        }
        this.input.setActionFeedback(
            completedActionFeedback({ label, startedAtEpochMs, target, ok: false, statusText: 'error', message })
        );
    };
    public readonly rejectAction = (label: string, statusText: string, message: string): void => {
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
    };
    public readonly configure = (): Promise<void> =>
        this.runAction({
            label: 'Configure WebSocket',
            target: this.input.values.connection,
            runningMessage: 'Recording the current WebSocket configuration.',
            signal: undefined,
            failedWaitStatus: undefined,
            run: (startedAtEpochMs) => this.recordConfiguration(startedAtEpochMs)
        });
    public readonly copyDiagnostics = (): Promise<void> =>
        this.copyText(
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
    public readonly copyRecipe = (includeRtcParity: boolean): Promise<void> => {
        if (!this.input.payloadResult.ok) {
            this.input.setLocalError(this.input.payloadResult.error);
            return Promise.resolve();
        }
        return this.copyText(
            toWebSocketCommandCenterRecipeText({
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

    private async copyText(text: string): Promise<void> {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        this.input.setLocalError(undefined);
        const written = await writeTextToClipboard(text);
        if (!signal.aborted) {
            written.foldLeft(this.input.setLocalError);
        }
    }

    private recordConfiguration(startedAtEpochMs: number): void {
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
                label: 'Configure WebSocket',
                startedAtEpochMs,
                target: this.input.values.connection,
                ok: true,
                status: 'configured',
                message: `Configured ${this.input.routePreview.destination}.`
            })
        );
    }
}

function isDefaultGroupContext(values: WebSocketCommandCenterValues): boolean {
    return [values.groupId, '', 'all', values.wsScope].includes(values.contextId);
}

function isDefaultScopeContext(values: WebSocketCommandCenterValues): boolean {
    return [values.wsScope, values.groupId, 'all', 'world', 'room'].includes(values.contextId);
}

function toScopeDefaultContext(
    wsScope: WebSocketCommandCenterValues['wsScope'],
    groupId: string
): string {
    return wsScope === 'room' ? groupId || 'room' : wsScope;
}
