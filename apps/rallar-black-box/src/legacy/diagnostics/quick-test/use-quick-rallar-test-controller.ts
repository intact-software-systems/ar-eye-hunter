import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import {
    createDirectRallarRuntimeEvent,
    runDirectRallarGroupCreate,
    runDirectRallarGroupJoin,
    runDirectRallarStatusCheck,
    runDirectRallarWsSend,
    runDirectRallarWsSubscribe,
    type DirectRallarOperationResult,
} from '../../../direct-rallar-operations.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxRuntimeStore,
} from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { optionalNumber } from '../../shared/finite-number.ts';
import { recordValue as optionalRecord } from '../../shared/record-value.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { stringValue } from '../../shared/string-value.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../shell/rallar-browser-status.ts';
import type {
    QuickRallarReceivedMessageRow,
    QuickRallarSubscriptionState,
    QuickRallarValues,
} from './quick-rallar-contracts.ts';
import { QUICK_RALLAR_DEFAULT_VALUES } from './quick-rallar-defaults.ts';

export type UseQuickRallarTestControllerInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
}>;

export function useQuickRallarTestController({
    state,
    bootstrap,
    authSession,
    globalValues,
    browserStatus,
    onGlobalValueChange,
}: UseQuickRallarTestControllerInput) {
    const [values, setValues] = useState<QuickRallarValues>(() => ({
        ...QUICK_RALLAR_DEFAULT_VALUES,
        contextId: globalValues.roomId || 'room',
    }));
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [lastResult, setLastResult] = useState<
        DirectRallarOperationResult | undefined
    >();
    const [subscription, setSubscription] = useState<
        QuickRallarSubscriptionState | undefined
    >();
    const [receivedMessages, setReceivedMessages] = useState<
        readonly QuickRallarReceivedMessageRow[]
    >([]);
    const [waitStatus, setWaitStatus] = useState('idle');
    const subscriptionRef = useRef<QuickRallarSubscriptionState | undefined>(
        undefined,
    );
    const receivedCountRef = useRef(0);
    const previousGlobalGroupRef = useRef(globalValues.roomId);
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const canUseDirectRallar =
        realBackendReady && Boolean(authSession) && !busyAction;
    const activeGroupId = globalValues.roomId.trim();
    const activeTypeId = values.typeId.trim();
    const activeTopicId = values.topicId.trim() || activeTypeId;
    const activeContextId = values.contextId.trim() || activeGroupId || 'room';
    const selectorLabel = `${activeTopicId || '*'} / ${activeTypeId || '-'}`;
    const payloadResult = useMemo(() => {
        try {
            return {
                ok: true as const,
                value: JSON.parse(values.payloadText) as unknown,
            };
        } catch (error) {
            return {
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }, [values.payloadText]);

    useEffect(() => {
        subscriptionRef.current = subscription;
    }, [subscription]);

    useEffect(() => {
        receivedCountRef.current = receivedMessages.length;
    }, [receivedMessages.length]);

    useEffect(
        () => () => {
            subscriptionRef.current?.unsubscribe();
        },
        [],
    );

    useEffect(() => {
        const previousGroup = previousGlobalGroupRef.current;
        previousGlobalGroupRef.current = globalValues.roomId;
        setValues((current) => {
            if (current.contextId && current.contextId !== previousGroup) {
                return current;
            }

            return {
                ...current,
                contextId: globalValues.roomId || 'room',
            };
        });
    }, [globalValues.roomId]);

    const operationContext = (): Parameters<
        typeof runDirectRallarStatusCheck
    >[0] => ({
        providerMode,
        apiBaseUrl: globalValues.apiBaseUrl,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        roomId: activeGroupId,
        actor:
            authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        connection: 'quick-test',
        authSession,
        timeoutMs: values.timeoutMs,
    });

    const updateValue = <K extends keyof QuickRallarValues>(
        key: K,
        value: QuickRallarValues[K],
    ): void => {
        setValues((current) => ({
            ...current,
            [key]: value,
        }));
    };

    const updateGroupId = (groupId: string): void => {
        const previousGroupId = globalValues.roomId;
        onGlobalValueChange('roomId', groupId);
        setValues((current) => ({
            ...current,
            contextId:
                !current.contextId || current.contextId === previousGroupId
                    ? groupId || 'room'
                    : current.contextId,
        }));
    };

    const recordDirectResult = (
        result: DirectRallarOperationResult,
        completedAction: string,
        failedAction: string,
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
                actor:
                    authSession?.username ??
                    authSession?.clientId ??
                    bootstrap.actor,
                payload: {
                    status: result.status,
                    durationMs: result.durationMs,
                    groupId: activeGroupId,
                    selector: {
                        typeId: activeTypeId,
                        topicId: activeTopicId,
                        contextId: activeContextId,
                    },
                    error: result.error,
                },
            },
            result.status === 'failed' ? failedAction : completedAction,
        );
        setLastResult(result);
        if (result.status === 'failed') {
            setLocalError(result.error?.message ?? failedAction);
        }
    };

    const runOperation = async (
        busyLabel: string,
        action: () => Promise<DirectRallarOperationResult>,
        completedAction: string,
        failedAction: string,
        onCompleted?: (result: DirectRallarOperationResult) => void,
    ): Promise<void> => {
        setBusyAction(busyLabel);
        setLocalError(undefined);
        try {
            const result = await action();
            recordDirectResult(result, completedAction, failedAction);
            if (result.status === 'completed') {
                onCompleted?.(result);
            }
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const createGroup = (): Promise<void> =>
        runOperation(
            'Create and join group',
            () =>
                runDirectRallarGroupCreate(
                    operationContext(),
                    loadBrowserRallarFacade,
                ),
            'Quick Test group created and joined',
            'Quick Test group create failed',
            (result) => {
                const groupId = stringValue(
                    optionalRecord(result.value).groupId,
                );
                if (groupId) {
                    updateGroupId(groupId);
                }
            },
        );

    const joinGroup = (): Promise<void> =>
        runOperation(
            'Join group',
            () =>
                runDirectRallarGroupJoin(
                    operationContext(),
                    loadBrowserRallarFacade,
                ),
            'Quick Test group joined',
            'Quick Test group join failed',
        );

    const messageRowFromRallarMessage = (
        message: Record<string, unknown>,
    ): QuickRallarReceivedMessageRow => {
        const nestedMessage = optionalRecord(message.message);
        const payload =
            'payload' in message
                ? message.payload
                : 'payload' in nestedMessage
                  ? nestedMessage.payload
                  : message;
        return {
            rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            atEpochMs: optionalNumber(message.receivedAtEpochMs) ?? Date.now(),
            transport: 'ws',
            senderId: String(message.senderId ?? nestedMessage.senderId ?? '-'),
            roomId: String(
                message.roomId ??
                    message.groupId ??
                    nestedMessage.roomId ??
                    activeGroupId ??
                    '-',
            ),
            typeId: String(
                message.typeId ?? nestedMessage.typeId ?? activeTypeId ?? '-',
            ),
            topicId: String(
                message.topicId ??
                    nestedMessage.topicId ??
                    activeTopicId ??
                    '-',
            ),
            contextId: String(
                message.contextId ??
                    nestedMessage.contextId ??
                    activeContextId ??
                    '-',
            ),
            resourceId: String(
                message.resourceId ?? nestedMessage.resourceId ?? '-',
            ),
            payload,
            raw: message,
        };
    };

    const subscribeWs = async (): Promise<void> => {
        if (!activeTypeId) {
            setLocalError('WS subscribe requires a Type ID.');
            return;
        }
        if (!activeGroupId) {
            setLocalError('WS subscribe requires a group.');
            return;
        }
        setBusyAction('Subscribe WS');
        setLocalError(undefined);
        subscriptionRef.current?.unsubscribe();
        setSubscription(undefined);
        const context = operationContext();
        const selector = {
            typeId: activeTypeId,
            ...(activeTopicId ? { topicId: activeTopicId } : {}),
        };
        try {
            const result = await runDirectRallarWsSubscribe(
                context,
                selector,
                (message) => {
                    const row = messageRowFromRallarMessage(message);
                    setReceivedMessages((current) =>
                        [...current, row].slice(-50),
                    );
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
                                raw: row.raw,
                            },
                        }),
                        'Quick Test WS message received',
                    );
                },
                loadBrowserRallarFacade,
            );
            recordDirectResult(
                result,
                'Quick Test WS subscribed',
                'Quick Test WS subscribe failed',
            );
            if (result.status === 'completed' && result.unsubscribe) {
                setSubscription({
                    transport: 'ws',
                    label: selectorLabel,
                    groupId: activeGroupId,
                    subscribedAtEpochMs: Date.now(),
                    unsubscribe: result.unsubscribe,
                });
                setWaitStatus('subscribed');
            }
        } catch (error) {
            setLocalError(
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const unsubscribeWs = (): void => {
        subscriptionRef.current?.unsubscribe();
        setSubscription(undefined);
        setWaitStatus('unsubscribed');
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic: 'rallar.direct.ws.unsubscribe.completed',
                context: operationContext(),
                transport: 'ws',
                payload: {
                    groupId: activeGroupId,
                    selector: selectorLabel,
                },
            }),
            'Quick Test WS unsubscribed',
        );
    };

    const sendWs = (): Promise<void> => {
        if (!payloadResult.ok) {
            setLocalError(payloadResult.error);
            return Promise.resolve();
        }
        if (!activeGroupId) {
            setLocalError('WS send requires a group.');
            return Promise.resolve();
        }
        return runOperation(
            'Send WS JSON',
            () =>
                runDirectRallarWsSend(
                    operationContext(),
                    {
                        scope: 'room',
                        typeId: activeTypeId,
                        topicId: activeTopicId,
                        contextId: activeContextId,
                        resourceId: values.resourceId.trim() || undefined,
                        payload: payloadResult.value,
                    },
                    loadBrowserRallarFacade,
                ),
            'Quick Test WS JSON sent',
            'Quick Test WS send failed',
        );
    };

    const waitForReceive = async (): Promise<void> => {
        const startCount = receivedCountRef.current;
        const startedAt = Date.now();
        setWaitStatus('waiting');
        setBusyAction('Wait for receive');
        setLocalError(undefined);
        try {
            await new Promise<void>((resolve, reject) => {
                const interval = window.setInterval(() => {
                    if (receivedCountRef.current > startCount) {
                        window.clearInterval(interval);
                        resolve();
                        return;
                    }
                    if (Date.now() - startedAt > values.timeoutMs) {
                        window.clearInterval(interval);
                        reject(
                            new Error(
                                'Timed out waiting for a Quick Test WebSocket receive.',
                            ),
                        );
                    }
                }, 100);
            });
            setWaitStatus('message observed');
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                createDirectRallarRuntimeEvent({
                    topic: 'rallar.direct.quick.receive.completed',
                    context: operationContext(),
                    transport: 'ws',
                    payload: {
                        waitedMs: Date.now() - startedAt,
                        receivedCount: receivedCountRef.current,
                    },
                }),
                'Quick Test receive observed',
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            setWaitStatus('timeout');
            setLocalError(message);
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                createDirectRallarRuntimeEvent({
                    topic: 'rallar.direct.quick.receive.timeout',
                    context: operationContext(),
                    transport: 'ws',
                    severity: 'error',
                    payload: {
                        waitedMs: Date.now() - startedAt,
                        receivedCount: receivedCountRef.current,
                        error: message,
                    },
                }),
                'Quick Test receive timed out',
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const copyDiagnostics = (): void => {
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    providerMode,
                    context: {
                        apiBaseUrl: globalValues.apiBaseUrl,
                        applicationId: globalValues.applicationId,
                        workspaceId: globalValues.workspaceId,
                        groupId: activeGroupId,
                        actor:
                            authSession?.username ??
                            authSession?.clientId ??
                            bootstrap.actor,
                        sessionId: authSession?.sessionId,
                    },
                    values,
                    selector: {
                        typeId: activeTypeId,
                        topicId: activeTopicId,
                        contextId: activeContextId,
                    },
                    browserStatus,
                    subscription: subscription
                        ? {
                              transport: subscription.transport,
                              label: subscription.label,
                              groupId: subscription.groupId,
                              subscribedAtEpochMs:
                                  subscription.subscribedAtEpochMs,
                          }
                        : undefined,
                    waitStatus,
                    localError,
                    lastResult,
                    receivedMessages: receivedMessages.slice(-8),
                },
                state,
                authSession,
            ),
        );
    };

    const copyRunnerRecipe = (): void => {
        const payload = payloadResult.ok ? payloadResult.value : {};
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    recipeId: 'rallar-quick-test-ws-group',
                    name: 'Rallar Quick Test WS group send',
                    requirements: [
                        'provider=browser-rallar',
                        'logged-in browser session',
                        'Rallar Server API reachable',
                        'receiver browser subscribed to same group/type/topic',
                    ],
                    continueOnFailure: false,
                    commands: [
                        {
                            kind: 'configure',
                            commandId: 'quick-configure',
                            config: {
                                runId: 'rallar-quick-test-export',
                                apiBaseUrl: globalValues.apiBaseUrl,
                                actor: authSession?.username ?? bootstrap.actor,
                                sessionId:
                                    authSession?.sessionId ??
                                    globalValues.sessionId,
                                roomId: activeGroupId,
                                providerMode,
                                rallar: {
                                    restoreSession: true,
                                    applicationId: globalValues.applicationId,
                                    workspaceId: globalValues.workspaceId,
                                    roomRef: {
                                        applicationId:
                                            globalValues.applicationId,
                                        workspaceId: globalValues.workspaceId,
                                        groupId: activeGroupId,
                                    },
                                    typeId: activeTypeId,
                                    topicId: activeTopicId,
                                },
                            },
                        },
                        {
                            kind: 'ws.send',
                            commandId: 'quick-ws-send',
                            connection: 'quick-test',
                            data: {
                                scope: 'room',
                                roomId: activeGroupId,
                                typeId: activeTypeId,
                                topicId: activeTopicId,
                                contextId: activeContextId,
                                payload,
                            },
                            timeoutMs: values.timeoutMs,
                        },
                    ],
                },
                state,
                authSession,
            ),
        );
    };

    const setupComplete =
        realBackendReady && Boolean(authSession) && Boolean(activeGroupId);
    const subscribed = Boolean(subscription);
    const sendComplete =
        lastResult?.kind === 'ws.send' && lastResult.status === 'completed';
    const verifyComplete =
        receivedMessages.length > 0 || waitStatus === 'message observed';
    const workflowSteps: readonly Readonly<{
        id: string;
        label: string;
        detail: string;
        state: 'done' | 'current' | 'blocked' | 'pending';
    }>[] = [
        {
            id: 'setup',
            label: 'Setup',
            detail: !realBackendReady
                ? 'real backend required'
                : !authSession
                  ? 'login required'
                  : activeGroupId
                    ? activeGroupId
                    : 'group required',
            state: setupComplete ? 'done' : 'current',
        },
        {
            id: 'subscribe',
            label: 'Subscribe',
            detail: subscription ? subscription.label : activeTypeId || 'type required',
            state: subscribed
                ? 'done'
                : setupComplete && activeTypeId
                  ? 'current'
                  : 'blocked',
        },
        {
            id: 'send',
            label: 'Send',
            detail: payloadResult.ok ? activeTopicId || activeTypeId || '-' : 'payload invalid',
            state: sendComplete
                ? 'done'
                : setupComplete && payloadResult.ok
                  ? 'current'
                  : setupComplete
                    ? 'blocked'
                    : 'pending',
        },
        {
            id: 'verify',
            label: 'Verify',
            detail: verifyComplete
                ? `${receivedMessages.length} received`
                : waitStatus,
            state: verifyComplete
                ? 'done'
                : sendComplete || subscribed
                  ? 'current'
                  : 'pending',
        },
    ];

    return {
        values,
        busyAction,
        localError,
        lastResult,
        subscription,
        receivedMessages,
        waitStatus,
        providerMode,
        realBackendReady,
        canUseDirectRallar,
        activeGroupId,
        activeTypeId,
        activeContextId,
        selectorLabel,
        payloadResult,
        updateValue,
        updateGroupId,
        createGroup,
        joinGroup,
        subscribeWs,
        unsubscribeWs,
        sendWs,
        waitForReceive,
        copyDiagnostics,
        copyRunnerRecipe,
        setupComplete,
        subscribed,
        workflowSteps,
    };
}

export type QuickRallarTestControllerModel = ReturnType<
    typeof useQuickRallarTestController
>;
