import type { RallarBlackBoxTestSeverity, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useEffect, useRef, useState } from 'react';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../client-defaults.ts';
import { configureDirectRallarFacade, createDirectRallarRuntimeEvent } from '../../../direct-rallar-operations.ts';
import { rallarBlackBoxRuntimeStore, type RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { json, parseJsonText, splitCsvValues } from '../../shared/json-presentation.ts';
import { recordArray, recordValue as optionalRecord } from '../../shared/record-value.ts';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { stringValue } from '../../shared/string-value.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import {
    completedActionFeedback,
    idleActionFeedback,
    runningActionFeedback,
    type CommandCenterActionFeedback
} from '../shared/action-feedback.ts';
import type {
    RtcRealtimeReceivedRow,
    RtcRealtimeSubscriptionRow,
    RtcRealtimeTransport
} from './rtc-realtime-contracts.ts';

export type UseRtcRealtimeControllerInput = Readonly<{
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}>;

type BrowserRallarFacade = Awaited<ReturnType<typeof loadBrowserRallarFacade>>;

export function useRtcRealtimeController({
    state,
    bootstrap,
    authSession,
    globalValues
}: UseRtcRealtimeControllerInput) {
    const [transport, setTransport] = useState<RtcRealtimeTransport>('realtime');
    const [laneId, setLaneId] = useState('realtime');
    const [peerIdsText, setPeerIdsText] = useState('');
    const [typeId, setTypeId] = useState('room.manual.message');
    const [topicId, setTopicId] = useState('room.manual.message');
    const [contextId, setContextId] = useState(globalValues.roomId || 'room');
    const [payloadText, setPayloadText] = useState(() =>
        json({
            text: 'hello from direct RTC/Realtimes',
            seq: 1
        })
    );
    const [minSnapshotVersion, setMinSnapshotVersion] = useState('');
    const [reliability, setReliability] = useState<'best-effort' | 'at-least-once'>('best-effort');
    const [ack, setAck] = useState<'none' | 'receiver' | 'all-logical-recipients' | 'group-leader'>('none');
    const [ownership, setOwnership] = useState<'shared' | 'exclusive'>(
        'shared'
    );
    const [timeoutMs, setTimeoutMs] = useState<number>(
        RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs
    );
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [actionFeedback, setActionFeedback] = useState<CommandCenterActionFeedback>(() =>
        idleActionFeedback(
            'Run an RTC/Realtimes operation to see action status.'
        )
    );
    const [result, setResult] = useState<unknown>();
    const [received, setReceived] = useState<readonly RtcRealtimeReceivedRow[]>(
        []
    );
    const [health, setHealth] = useState<unknown>();
    const [subscriptions, setSubscriptions] = useState<readonly RtcRealtimeSubscriptionRow[]>([]);
    const subscriptionsRef = useRef<readonly RtcRealtimeSubscriptionRow[]>([]);
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const activeGroupId = globalValues.roomId.trim();
    const peerIds = splitCsvValues(peerIdsText);
    const canRun = realBackendReady && Boolean(authSession) && !busyAction;

    useEffect(() => {
        setContextId((current) =>
            current && current !== 'room'
                ? current
                : globalValues.roomId || 'room'
        );
    }, [globalValues.roomId]);

    useEffect(
        () => () => {
            subscriptionsRef.current.forEach((subscription) => subscription.unsubscribe());
            subscriptionsRef.current = [];
        },
        []
    );

    const context = () => ({
        providerMode,
        apiBaseUrl: globalValues.apiBaseUrl,
        applicationId: globalValues.applicationId,
        workspaceId: globalValues.workspaceId,
        roomId: activeGroupId,
        actor: authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        connection: 'rtc-realtime',
        authSession,
        timeoutMs
    });

    const recordDirectEvent = (
        topic: string,
        severity: RallarBlackBoxTestSeverity,
        payload: unknown,
        lastAction?: string
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: context(),
                transport,
                severity,
                payload
            }),
            lastAction
        );
    };

    const nowMs = (): number => typeof performance === 'undefined' ? Date.now() : performance.now();

    const recordPhase = (
        phase: string,
        severity: RallarBlackBoxTestSeverity,
        payload: Record<string, unknown>
    ): void => {
        recordDirectEvent('rallar.direct.rtc_realtime.phase', severity, {
            phase,
            ...payload
        });
    };

    const runTimedPhase = async <T>(
        phase: string,
        action: () => Promise<T> | T,
        details: Record<string, unknown> = {}
    ): Promise<T> => {
        const startedAtMs = nowMs();
        try {
            const value = await action();
            recordPhase(phase, 'info', {
                ...details,
                status: 'ok',
                durationMs: Math.round((nowMs() - startedAtMs) * 100) / 100
            });
            return value;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordPhase(phase, 'error', {
                ...details,
                status: 'error',
                durationMs: Math.round((nowMs() - startedAtMs) * 100) / 100,
                error: message
            });
            throw error;
        }
    };

    const isFacadeJoinedToActiveGroup = (
        facade: BrowserRallarFacade
    ): boolean => {
        if (!activeGroupId || !authSession?.sessionId) {
            return false;
        }

        const snapshot = optionalRecord(facade.rooms.current());
        const group = optionalRecord(snapshot.group);
        const groupId = stringValue(group.groupId ?? snapshot.groupId);
        if (groupId !== activeGroupId) {
            return false;
        }

        return recordArray(snapshot.activeSessions).some(
            (session) => stringValue(session.sessionId) === authSession.sessionId
        );
    };

    const ensureActiveGroupJoined = async (
        facade: BrowserRallarFacade
    ): Promise<void> => {
        if (!activeGroupId) {
            return;
        }

        if (isFacadeJoinedToActiveGroup(facade)) {
            recordPhase('join', 'info', {
                status: 'skipped',
                groupId: activeGroupId,
                reason: 'current browser session is already active in the group'
            });
            return;
        }

        await runTimedPhase(
            'join',
            () =>
                facade.rooms.join(activeGroupId, {
                    scope: {
                        applicationId: globalValues.applicationId,
                        workspaceId: globalValues.workspaceId
                    },
                    timeoutMs
                }),
            {
                groupId: activeGroupId
            }
        );
    };

    const withFacade = async <T>(
        actionLabel: string,
        action: (facade: BrowserRallarFacade) => Promise<T>
    ): Promise<T> => {
        if (!realBackendReady) {
            throw new Error('RTC/Realtimes requires provider=browser-rallar.');
        }
        if (!authSession) {
            throw new Error(
                'RTC/Realtimes requires a logged-in browser session.'
            );
        }
        const facade = await runTimedPhase('load-facade', () => loadBrowserRallarFacade());
        await runTimedPhase('configure', () => {
            configureDirectRallarFacade(facade, context());
        });
        await runTimedPhase('start', () =>
            facade.start({
                connect: true,
                refreshRooms: false,
                refreshPeople: false,
                timeoutMs
            }));
        await ensureActiveGroupJoined(facade);
        return await runTimedPhase(actionLabel, () => action(facade));
    };

    const runAction = async (
        label: string,
        action: () => Promise<unknown>
    ): Promise<void> => {
        setBusyAction(label);
        setLocalError(undefined);
        const startedAtEpochMs = Date.now();
        setActionFeedback(
            runningActionFeedback(
                label,
                `${activeGroupId || '-'} / ${transport}`,
                'Calling the browser Rallar facade.'
            )
        );
        try {
            const nextResult = await action();
            setResult(nextResult);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: `${activeGroupId || '-'} / ${transport}`,
                    ok: true,
                    status: 'completed',
                    message: `${label} completed.`
                })
            );
            recordDirectEvent(
                `rallar.direct.${transport}.${label.toLowerCase().replaceAll(' ', '_')}.completed`,
                'info',
                nextResult,
                `${label} completed`
            );
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLocalError(message);
            setActionFeedback(
                completedActionFeedback({
                    label,
                    startedAtEpochMs,
                    target: `${activeGroupId || '-'} / ${transport}`,
                    ok: false,
                    statusText: 'error',
                    message
                })
            );
            recordDirectEvent(
                `rallar.direct.${transport}.${label.toLowerCase().replaceAll(' ', '_')}.failed`,
                'error',
                { error: message },
                `${label} failed`
            );
        }
        finally {
            setBusyAction(undefined);
        }
    };

    const addSubscription = (
        subscription: RtcRealtimeSubscriptionRow
    ): void => {
        subscriptionsRef.current
            .filter(
                (entry) => entry.subscriptionId === subscription.subscriptionId
            )
            .forEach((entry) => entry.unsubscribe());
        subscriptionsRef.current = [
            ...subscriptionsRef.current.filter(
                (entry) => entry.subscriptionId !== subscription.subscriptionId
            ),
            subscription
        ];
        setSubscriptions(subscriptionsRef.current);
    };

    const addReceived = (row: RtcRealtimeReceivedRow): void => {
        setReceived((current) => [...current, row].slice(-50));
        recordDirectEvent(
            'rallar.direct.rtc_realtime.message',
            'info',
            row,
            'RTC/Realtimes message received'
        );
    };

    const subscribeRealtime = (): Promise<void> =>
        runAction('Subscribe realtime', async () => {
            return await withFacade('subscribe-realtime', async (facade) => {
                const unsubscribe = facade.realtime.onJson<unknown>(
                    laneId,
                    (message) => {
                        addReceived({
                            rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            atEpochMs: message.receivedAtEpochMs,
                            transport: 'realtime',
                            peerId: message.peerId,
                            laneId: message.laneId,
                            roomId: activeGroupId || '-',
                            typeId: '-',
                            topicId: '-',
                            contextId: activeGroupId || '-',
                            payload: message.data,
                            raw: message
                        });
                    }
                );
                addSubscription({
                    subscriptionId: `realtime:${activeGroupId || '-'}:${laneId || '-'}`,
                    transport: 'realtime',
                    label: `lane ${laneId || '-'}`,
                    laneId,
                    groupId: activeGroupId || '-',
                    subscribedAtEpochMs: Date.now(),
                    unsubscribe
                });
                return {
                    subscribed: 'realtime',
                    laneId
                };
            });
        });

    const subscribeRtcMessages = (): Promise<void> =>
        runAction('Subscribe RTC messages', async () => {
            return await withFacade(
                'subscribe-rtc-messages',
                async (facade) => {
                    const selector = {
                        typeId,
                        ...(topicId ? { topicId } : {})
                    };
                    const unsubscribe = facade.messages.rtc.onMessage(
                        selector,
                        (message) => {
                            const record = optionalRecord(message);
                            addReceived({
                                rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                                atEpochMs: Date.now(),
                                transport: 'messages.rtc',
                                peerId: String(
                                    record.senderId ?? record.peerId ?? '-'
                                ),
                                laneId,
                                roomId: String(
                                    record.roomId ?? activeGroupId ?? '-'
                                ),
                                typeId: String(record.typeId ?? typeId),
                                topicId: String(record.topicId ?? topicId),
                                contextId: String(
                                    record.contextId ?? contextId
                                ),
                                payload: record.payload ?? message,
                                raw: message
                            });
                        }
                    );
                    addSubscription({
                        subscriptionId: `messages.rtc:${activeGroupId || '-'}:${topicId || '*'}:${typeId}`,
                        transport: 'messages.rtc',
                        label: `${topicId || '*'} / ${typeId}`,
                        laneId,
                        groupId: activeGroupId || '-',
                        subscribedAtEpochMs: Date.now(),
                        unsubscribe
                    });
                    return {
                        subscribed: 'messages.rtc',
                        selector
                    };
                }
            );
        });

    const clearSubscriptions = (): void => {
        const startedAtEpochMs = Date.now();
        subscriptionsRef.current.forEach((subscription) => subscription.unsubscribe());
        subscriptionsRef.current = [];
        setSubscriptions([]);
        setActionFeedback(
            completedActionFeedback({
                label: 'Clear RTC/Realtimes subscriptions',
                startedAtEpochMs,
                target: activeGroupId || '-',
                ok: true,
                status: 'cleared',
                message: 'RTC/Realtimes subscriptions cleared.'
            })
        );
        recordDirectEvent(
            'rallar.direct.rtc_realtime.unsubscribe.completed',
            'info',
            {},
            'RTC/Realtimes subscriptions cleared'
        );
    };

    const sendRealtime = (): Promise<void> =>
        runAction('Send realtime JSON', async () => {
            const payload = parseJsonText(payloadText, {});
            return await withFacade(
                'send-realtime-json',
                async (facade) =>
                    await facade.realtime.sendJson({
                        data: payload,
                        laneId,
                        roomId: activeGroupId,
                        roomRef: activeGroupId
                            ? {
                                applicationId: globalValues.applicationId,
                                workspaceId: globalValues.workspaceId,
                                groupId: activeGroupId
                            }
                            : undefined,
                        peerIds: peerIds.length > 0 ? peerIds : undefined,
                        openTimeoutMs: timeoutMs
                    })
            );
        });

    const sendRtcMessage = (): Promise<void> =>
        runAction('Send RTC message', async () => {
            const payload = parseJsonText(payloadText, {});
            return await withFacade(
                'send-rtc-message',
                async (facade) =>
                    await facade.messages.rtc.send({
                        roomId: activeGroupId,
                        roomRef: activeGroupId
                            ? {
                                applicationId: globalValues.applicationId,
                                workspaceId: globalValues.workspaceId,
                                groupId: activeGroupId
                            }
                            : undefined,
                        typeId,
                        topicId,
                        contextId: contextId || activeGroupId || typeId,
                        payload,
                        minSnapshotVersion: minSnapshotVersion.trim()
                            ? Number(minSnapshotVersion)
                            : undefined,
                        reliability,
                        ack,
                        ownership,
                        nextHopPeerIds: peerIds.length > 0 ? peerIds : undefined,
                        overlayId: activeGroupId || undefined
                    })
            );
        });

    const waitForRoomLane = (): Promise<void> =>
        runAction(
            'Wait room lane',
            async () =>
                await withFacade(
                    'wait-room-lane',
                    async (facade) =>
                        await facade.rtc.waitForRoomLane(
                            {
                                applicationId: globalValues.applicationId,
                                workspaceId: globalValues.workspaceId,
                                groupId: activeGroupId
                            },
                            laneId,
                            { timeoutMs }
                        )
                )
        );

    const refreshHealth = (): Promise<void> =>
        runAction('Refresh lane health', async () => {
            return await withFacade('refresh-lane-health', async (facade) => {
                const nextHealth = facade.realtime.health({
                    peerIds: peerIds.length > 0 ? peerIds : undefined,
                    laneIds: laneId ? [laneId] : undefined
                });
                setHealth(nextHealth);
                return nextHealth;
            });
        });

    const copyRecipe = (): void => {
        const payload = (() => {
            try {
                return parseJsonText(payloadText, {});
            }
            catch {
                return {};
            }
        })();
        void navigator.clipboard?.writeText(
            redactedJson(
                {
                    recipeId: 'rallar-direct-rtc-realtime-export',
                    name: 'Direct RTC/Realtimes export from Rallar Black Box',
                    requirements: [
                        'provider=browser-rallar',
                        'logged-in browser session',
                        'joined group with RTC signaling available'
                    ],
                    commands: [
                        {
                            kind: 'rtc.connect',
                            commandId: 'rtc-realtime-connect',
                            roomId: activeGroupId,
                            transport,
                            timeoutMs,
                            rallar: {
                                applicationId: globalValues.applicationId,
                                workspaceId: globalValues.workspaceId,
                                roomRef: {
                                    applicationId: globalValues.applicationId,
                                    workspaceId: globalValues.workspaceId,
                                    groupId: activeGroupId
                                }
                            }
                        },
                        {
                            kind: 'rtc.send',
                            commandId: 'rtc-realtime-send',
                            roomId: activeGroupId,
                            transport,
                            send: payload,
                            targetClient: peerIds[0],
                            rallar: {
                                typeId,
                                topicId,
                                contextId,
                                laneId
                            },
                            timeoutMs
                        }
                    ]
                },
                state,
                authSession
            )
        );
    };
    return {
        transport,
        setTransport,
        laneId,
        setLaneId,
        peerIdsText,
        setPeerIdsText,
        typeId,
        setTypeId,
        topicId,
        setTopicId,
        contextId,
        setContextId,
        payloadText,
        setPayloadText,
        minSnapshotVersion,
        setMinSnapshotVersion,
        reliability,
        setReliability,
        ack,
        setAck,
        ownership,
        setOwnership,
        timeoutMs,
        setTimeoutMs,
        busyAction,
        localError,
        actionFeedback,
        result,
        received,
        health,
        subscriptions,
        providerMode,
        realBackendReady,
        activeGroupId,
        peerIds,
        canRun,
        subscribeRealtime,
        subscribeRtcMessages,
        clearSubscriptions,
        sendRealtime,
        sendRtcMessage,
        waitForRoomLane,
        refreshHealth,
        copyRecipe
    };
}

export type RtcRealtimeControllerModel = ReturnType<typeof useRtcRealtimeController>;
