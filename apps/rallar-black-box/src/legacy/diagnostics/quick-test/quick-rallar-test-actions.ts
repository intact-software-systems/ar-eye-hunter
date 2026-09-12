import type { RallarBlackBoxTestConfig, RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarMessage, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type * as React from 'react';
import {
    createDirectRallarRuntimeEvent,
    runDirectRallarGroupCreate,
    runDirectRallarGroupJoin,
    runDirectRallarWsSend,
    runDirectRallarWsSubscribe,
    type DirectRallarOperationContext,
    type DirectRallarOperationResult
} from '../../../direct-rallar-operations.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { recordValue } from '../../shared/record-value.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { stringValue } from '../../shared/string-value.ts';
import type { DiagnosticControllerLifecycle } from '../shared/diagnostic-controller-lifecycle.ts';
import type {
    QuickRallarReceivedMessageRow,
    QuickRallarSubscriptionState,
    QuickRallarValues
} from './quick-rallar-contracts.ts';
import type { UseQuickRallarTestControllerInput } from './use-quick-rallar-test-controller.ts';

export namespace QuickRallarTestActions {
    export interface Input extends UseQuickRallarTestControllerInput {
        nowMs(): number;
        createRowId(): string;
        readonly values: QuickRallarValues;
        readonly setValues: React.Dispatch<React.SetStateAction<QuickRallarValues>>;
        readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly localError: string | undefined;
        readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly lastResult: DirectRallarOperationResult | undefined;
        readonly setLastResult: React.Dispatch<React.SetStateAction<DirectRallarOperationResult | undefined>>;
        readonly subscription: QuickRallarSubscriptionState | undefined;
        readonly setSubscription: React.Dispatch<React.SetStateAction<QuickRallarSubscriptionState | undefined>>;
        readonly receivedMessages: readonly QuickRallarReceivedMessageRow[];
        readonly setReceivedMessages: React.Dispatch<React.SetStateAction<readonly QuickRallarReceivedMessageRow[]>>;
        readonly waitStatus: string;
        readonly setWaitStatus: React.Dispatch<React.SetStateAction<string>>;
        readonly subscriptionRef: React.RefObject<QuickRallarSubscriptionState | undefined>;
        readonly receivedCountRef: React.RefObject<number>;
        readonly providerMode: 'browser-rallar' | 'simulated';
        readonly activeGroupId: string;
        readonly activeTypeId: string;
        readonly activeTopicId: string;
        readonly activeContextId: string;
        readonly selectorLabel: string;
        readonly payloadResult: {
            readonly ok: true;
            readonly value: import('@shared-web/browser/messages/rallar-message-contracts.ts').RallarMessagePayload;
        } | { readonly ok: false; readonly error: string; };
        readonly lifetime: DiagnosticControllerLifecycle;
    }
    export interface Operation {
        readonly busyLabel: string;
        readonly action: () => Promise<DirectRallarOperationResult>;
        readonly completedAction: string;
        readonly failedAction: string;
        readonly onCompleted?: (result: DirectRallarOperationResult) => void;
    }
    export interface RunnerRecipe extends RallarBlackBoxTestRecipe {
        readonly requirements: readonly string[];
    }
    export interface RunnerConfiguration extends RallarBlackBoxTestConfig {
        readonly providerMode: QuickRallarTestActions.Input['providerMode'];
    }
}
export class QuickRallarTestActions {
    private readonly input: QuickRallarTestActions.Input;
    constructor(input: QuickRallarTestActions.Input) {
        this.input = input;
    }
    public readonly operationContext = (): DirectRallarOperationContext => ({
        providerMode: this.input.providerMode,
        apiBaseUrl: this.input.globalValues.apiBaseUrl,
        applicationId: this.input.globalValues.applicationId,
        workspaceId: this.input.globalValues.workspaceId,
        roomId: this.input.activeGroupId,
        actor: this.input.authSession?.username ?? this.input.authSession?.clientId ?? this.input.bootstrap.actor,
        connection: 'quick-test',
        authSession: this.input.authSession,
        timeoutMs: this.input.values.timeoutMs
    });
    public readonly updateValue = <K extends keyof QuickRallarValues>(
        key: K,
        value: QuickRallarValues[K]
    ): void => {
        this.input.setValues((current) => ({
            ...current,
            [key]: value
        }));
    };
    public readonly updateGroupId = (groupId: string): void => {
        const previousGroupId = this.input.globalValues.roomId;
        this.input.onGlobalValueChange('roomId', groupId);
        this.input.setValues((current) => ({
            ...current,
            contextId: !current.contextId || current.contextId === previousGroupId
                ? groupId || 'room'
                : current.contextId
        }));
    };
    public readonly recordDirectResult = (
        result: DirectRallarOperationResult,
        completedAction: string,
        failedAction: string
    ): void => {
        result.events.forEach((event) => {
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(event);
        });
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            {
                kind: 'state',
                topic: `rallar.direct.quick.${result.kind}.${result.status}`,
                transport: result.kind.startsWith('ws.') ? 'ws' : undefined,
                severity: result.status === 'failed' ? 'error' : 'info',
                actor: this.input.authSession?.username ??
                    this.input.authSession?.clientId ??
                    this.input.bootstrap.actor,
                payload: {
                    status: result.status,
                    durationMs: result.durationMs,
                    groupId: this.input.activeGroupId,
                    selector: {
                        typeId: this.input.activeTypeId,
                        topicId: this.input.activeTopicId,
                        contextId: this.input.activeContextId
                    },
                    error: result.error
                }
            },
            result.status === 'failed' ? failedAction : completedAction
        );
        this.input.setLastResult(result);
        if (result.status === 'failed') {
            this.input.setLocalError(result.error?.message ?? failedAction);
        }
    };
    public readonly runOperation = async (
        { busyLabel, action, completedAction, failedAction, onCompleted }: QuickRallarTestActions.Operation
    ): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        this.input.setBusyAction(busyLabel);
        this.input.setLocalError(undefined);
        try {
            const result = await action();
            if (signal.aborted) {
                return;
            }
            this.recordDirectResult(result, completedAction, failedAction);
            if (result.status === 'completed') {
                onCompleted?.(result);
            }
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }
            this.input.setLocalError(
                error instanceof Error ? error.message : String(error)
            );
        }
        finally {
            if (signal.aborted) {
                return;
            }
            this.input.setBusyAction(undefined);
        }
    };
    public readonly createGroup = (): Promise<void> =>
        this.runOperation(
            {
                busyLabel: 'Create and join group',
                action: () =>
                    runDirectRallarGroupCreate(
                        this.operationContext(),
                        loadBrowserRallarFacade
                    ),
                completedAction: 'Quick Test group created and joined',
                failedAction: 'Quick Test group create failed',
                onCompleted: (result) => {
                    const groupId = stringValue(
                        recordValue(result.value).groupId
                    );
                    if (groupId) {
                        this.updateGroupId(groupId);
                    }
                }
            }
        );
    public readonly joinGroup = (): Promise<void> =>
        this.runOperation(
            {
                busyLabel: 'Join group',
                action: () =>
                    runDirectRallarGroupJoin(
                        this.operationContext(),
                        loadBrowserRallarFacade
                    ),
                completedAction: 'Quick Test group joined',
                failedAction: 'Quick Test group join failed'
            }
        );
    public readonly subscribeWs = async (): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        if (!this.input.activeTypeId) {
            this.input.setLocalError('WS subscribe requires a Type ID.');
            return;
        }
        if (!this.input.activeGroupId) {
            this.input.setLocalError('WS subscribe requires a group.');
            return;
        }
        this.input.setBusyAction('Subscribe WS');
        this.input.setLocalError(undefined);
        this.input.subscriptionRef.current?.unsubscribe();
        this.input.setSubscription(undefined);
        const context = this.operationContext();
        const selector = {
            typeId: this.input.activeTypeId,
            ...(this.input.activeTopicId ? { topicId: this.input.activeTopicId } : {})
        };
        try {
            const result = await runDirectRallarWsSubscribe(
                {
                    context: context,
                    selector: selector,
                    handler: (message) => this.receiveMessage(context, message),
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
                'Quick Test WS subscribed',
                'Quick Test WS subscribe failed'
            );
            if (result.status === 'completed' && result.unsubscribe) {
                this.publishSubscription(result.unsubscribe);
            }
        }
        catch (error) {
            if (signal.aborted) {
                return;
            }
            this.input.setLocalError(
                error instanceof Error ? error.message : String(error)
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
        this.input.subscriptionRef.current?.unsubscribe();
        this.input.setSubscription(undefined);
        this.input.setWaitStatus('unsubscribed');
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic: 'rallar.direct.ws.unsubscribe.completed',
                context: this.operationContext(),
                transport: 'ws',
                payload: {
                    groupId: this.input.activeGroupId,
                    selector: this.input.selectorLabel
                }
            }),
            'Quick Test WS unsubscribed'
        );
    };
    public readonly sendWs = (): Promise<void> => {
        if (!this.input.payloadResult.ok) {
            this.input.setLocalError(this.input.payloadResult.error);
            return Promise.resolve();
        }
        if (!this.input.activeGroupId) {
            this.input.setLocalError('WS send requires a group.');
            return Promise.resolve();
        }
        const payload = this.input.payloadResult.value;
        return this.runOperation(
            {
                busyLabel: 'Send WS JSON',
                action: () =>
                    runDirectRallarWsSend(
                        this.operationContext(),
                        {
                            scope: 'room',
                            typeId: this.input.activeTypeId,
                            topicId: this.input.activeTopicId,
                            contextId: this.input.activeContextId,
                            resourceId: this.input.values.resourceId.trim() || undefined,
                            payload
                        },
                        loadBrowserRallarFacade
                    ),
                completedAction: 'Quick Test WS JSON sent',
                failedAction: 'Quick Test WS send failed'
            }
        );
    };
    public readonly waitForReceive = async (): Promise<void> => {
        const signal = this.input.lifetime.signal;
        if (signal.aborted) {
            return;
        }
        const startCount = this.input.receivedCountRef.current;
        const startedAt = this.input.nowMs();
        this.input.setWaitStatus('waiting');
        this.input.setBusyAction('Wait for receive');
        this.input.setLocalError(undefined);
        try {
            const outcome = await this.waitForReceivedMessage(startCount, startedAt);
            if (signal.aborted || outcome === 'aborted') {
                return;
            }
            if (outcome === 'timeout') {
                this.publishReceiveTimeout(startedAt);
                return;
            }
            this.input.setWaitStatus('message observed');
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                createDirectRallarRuntimeEvent({
                    topic: 'rallar.direct.quick.receive.completed',
                    context: this.operationContext(),
                    transport: 'ws',
                    payload: {
                        waitedMs: this.input.nowMs() - startedAt,
                        receivedCount: this.input.receivedCountRef.current
                    }
                }),
                'Quick Test receive observed'
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
                    providerMode: this.input.providerMode,
                    context: {
                        apiBaseUrl: this.input.globalValues.apiBaseUrl,
                        applicationId: this.input.globalValues.applicationId,
                        workspaceId: this.input.globalValues.workspaceId,
                        groupId: this.input.activeGroupId,
                        actor: this.input.authSession?.username ??
                            this.input.authSession?.clientId ??
                            this.input.bootstrap.actor,
                        sessionId: this.input.authSession?.sessionId
                    },
                    values: this.input.values,
                    selector: {
                        typeId: this.input.activeTypeId,
                        topicId: this.input.activeTopicId,
                        contextId: this.input.activeContextId
                    },
                    browserStatus: this.input.browserStatus,
                    subscription: this.input.subscription
                        ? {
                            transport: this.input.subscription.transport,
                            label: this.input.subscription.label,
                            groupId: this.input.subscription.groupId,
                            subscribedAtEpochMs: this.input.subscription.subscribedAtEpochMs
                        }
                        : undefined,
                    waitStatus: this.input.waitStatus,
                    localError: this.input.localError,
                    lastResult: this.input.lastResult,
                    receivedMessages: this.input.receivedMessages.slice(-8)
                },
                this.input.state,
                this.input.authSession
            )
        );
    };
    public readonly copyRunnerRecipe = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                this.toRunnerRecipe(),
                this.input.state,
                this.input.authSession
            )
        );
    };

    private receiveMessage(
        context: DirectRallarOperationContext,
        message: RallarMessage<RallarMessagePayload>
    ): void {
        const row = toReceivedMessageRow(message, this.input.createRowId(), this.input.activeGroupId);
        this.input.receivedCountRef.current += 1;
        this.input.setReceivedMessages((current) => [...current, row].slice(-50));
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                kind: 'message',
                topic: 'rallar.direct.ws.message',
                context,
                transport: 'ws',
                payload: {
                    senderId: row.senderId,
                    roomId: row.roomId,
                    typeId: row.typeId,
                    topicId: row.topicId,
                    contextId: row.contextId,
                    resourceId: row.resourceId,
                    payload: row.payload,
                    raw: row.raw
                }
            }),
            'Quick Test WS message received'
        );
    }

    private async waitForReceivedMessage(
        startCount: number,
        startedAt: number
    ): Promise<DiagnosticControllerLifecycle.Observation> {
        return await this.input.lifetime.waitForObservation({
            hasObserved: () => this.input.receivedCountRef.current > startCount,
            nowMs: this.input.nowMs,
            startedAtEpochMs: startedAt,
            timeoutMs: this.input.values.timeoutMs
        });
    }

    private toRunnerRecipe(): QuickRallarTestActions.RunnerRecipe {
        const payload = this.input.payloadResult.ok ? this.input.payloadResult.value : {};
        return {
            recipeId: 'rallar-quick-test-ws-group',
            name: 'Rallar Quick Test WS group send',
            requirements: [
                'provider=browser-rallar',
                'logged-in browser session',
                'Rallar Server API reachable',
                'receiver browser subscribed to same group/type/topic'
            ],
            continueOnFailure: false,
            commands: [
                {
                    kind: 'configure',
                    commandId: 'quick-configure',
                    config: this.toRunnerConfiguration()
                },
                {
                    kind: 'ws.send',
                    commandId: 'quick-ws-send',
                    connection: 'quick-test',
                    data: {
                        scope: 'room',
                        roomId: this.input.activeGroupId,
                        typeId: this.input.activeTypeId,
                        topicId: this.input.activeTopicId,
                        contextId: this.input.activeContextId,
                        payload
                    },
                    timeoutMs: this.input.values.timeoutMs
                }
            ]
        };
    }

    private toRunnerConfiguration(): QuickRallarTestActions.RunnerConfiguration {
        return {
            runId: 'rallar-quick-test-export',
            apiBaseUrl: this.input.globalValues.apiBaseUrl,
            actor: this.input.authSession?.username ?? this.input.bootstrap.actor,
            sessionId: this.input.authSession?.sessionId ??
                this.input.globalValues.sessionId,
            roomId: this.input.activeGroupId,
            providerMode: this.input.providerMode,
            rallar: {
                restoreSession: true,
                applicationId: this.input.globalValues.applicationId,
                workspaceId: this.input.globalValues.workspaceId,
                roomRef: {
                    applicationId: this.input.globalValues.applicationId,
                    workspaceId: this.input.globalValues.workspaceId,
                    groupId: this.input.activeGroupId
                },
                typeId: this.input.activeTypeId,
                topicId: this.input.activeTopicId
            }
        };
    }

    private publishReceiveTimeout(startedAt: number): void {
        const message = 'Timed out waiting for a Quick Test WebSocket receive.';
        this.input.setWaitStatus('timeout');
        this.input.setLocalError(message);
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic: 'rallar.direct.quick.receive.timeout',
                context: this.operationContext(),
                transport: 'ws',
                severity: 'error',
                payload: {
                    waitedMs: this.input.nowMs() - startedAt,
                    receivedCount: this.input.receivedCountRef.current,
                    error: message
                }
            }),
            'Quick Test receive timed out'
        );
    }

    private publishSubscription(unsubscribe: RallarUnsubscribe): void {
        const installed: QuickRallarSubscriptionState = {
            transport: 'ws',
            label: this.input.selectorLabel,
            groupId: this.input.activeGroupId,
            subscribedAtEpochMs: this.input.nowMs(),
            unsubscribe
        };
        this.input.subscriptionRef.current = installed;
        this.input.setSubscription(installed);
        this.input.setWaitStatus('subscribed');
    }
}

function toReceivedMessageRow(
    message: RallarMessage<RallarMessagePayload>,
    rowId: string,
    roomId: string
): QuickRallarReceivedMessageRow {
    return {
        rowId,
        atEpochMs: message.receivedAtEpochMs,
        transport: 'ws',
        senderId: message.senderId,
        roomId: message.roomId ?? roomId,
        typeId: message.typeId,
        topicId: message.topicId,
        contextId: message.contextId,
        resourceId: message.resourceId,
        payload: message.payload,
        raw: message
    };
}
