import * as apiWorkflows from '@shared-web/browser/api-workflows.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import type {
    CreateRallarDirectorFacadeOptions,
    RallarDirectorAppointOptions,
    RallarDirectorRelayConfig,
    RallarDirectorRelayEnvelope,
    RallarDirectorRelayHandle,
    RallarDirectorRelayMessage,
    RallarDirectorRelaySendResult,
    RallarDirectorResignOptions,
    RallarDirectorStatus,
    RallarDirectorStatusListener,
    RallarDirectorStatusOptions,
} from '@shared-web/browser/rallar-director-facade.ts';
import type {
    RallarMessageSendResult,
    RallarMessageSendStatus,
    RallarMessagesFacade,
} from '@shared-web/browser/rallar-messages-facade.ts';
import type {
    RallarRealtimeFacade,
    RallarTargetedChannel,
    RallarTargetedChannelDefinition,
} from '@shared-web/browser/rallar-realtime-facade.ts';
import {
    type RallarOperationOptions,
    toRallarWorkflowPolicies,
} from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarRoomsFacade } from '@shared-web/browser/rallar-rooms-facade.ts';
import type { RallarStatePort } from '@shared-web/browser/rallar-runtime/contracts.ts';
import {
    createRallarSubscriptionScope,
    notifyListener,
} from '@shared-web/browser/rallar-runtime/subscriptions.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import {
    DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS,
    isRallarGroupDirectorForSession,
    isRallarGroupDirectorSessionActive,
    mergeRallarGroupDirectorMetadata,
    type RallarGroupDirectorAppointment,
    readRallarGroupDirectorFreshness,
    readRallarGroupDirectorFromSnapshot,
} from '@shared/api/group-director.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

const RALLAR_DIRECTOR_DEFAULT_TOPIC_ID = 'app.rallar.director';
const RALLAR_DIRECTOR_RELAY_PROTOCOL = 'rallar.director.relay.v1';
const DEFAULT_RALLAR_REALTIME_LANE_ID = 'realtime';

export type CreateRallarDirectorControllerOptions = Readonly<{
    stateStore: RallarStatePort;
    rooms: RallarRoomsFacade;
    messages: RallarMessagesFacade;
    realtime: RallarRealtimeFacade;
    readSession(): AuthSession | undefined;
    requireSession(): AuthSession;
    connect(options?: RallarOperationOptions): Promise<ApiMiddleware>;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T,
    ): T & RallarOperationOptions;
    resolveOperationScope(scope?: StateScope): StateScope | undefined;
    resolveDefaultRoom(): string | GroupRef | undefined;
    runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
    acceptSnapshots(
        ctx: ApiMiddleware,
        groups: readonly GroupSnapshot[],
        scope?: StateScope,
    ): Promise<void>;
    createTargetedChannel<T>(
        definition: RallarTargetedChannelDefinition,
    ): RallarTargetedChannel<T>;
    sendWsUnicast<T>(
        peerId: string,
        payload: T,
        typeId: string,
        route: Readonly<{
            topicId: string;
            contextId: string;
            resourceId?: string;
        }>,
    ): Promise<RallarMessageSendResult>;
}>;

export type RallarDirectorController = Readonly<{
    operations: CreateRallarDirectorFacadeOptions;
    onStateChanged(): void;
    stopRelays(): void;
}>;

export function createRallarDirectorController(
    options: CreateRallarDirectorControllerOptions,
): RallarDirectorController {
    const listeners = new Set<RallarDirectorStatusListener>();
    const heartbeatByRoom = new Map<
        string,
        Readonly<{ sessionId: string; epoch: number; atEpochMs: number }>
    >();
    const relayStops = new Set<() => void>();

    const findSnapshot = (
        room?: string | GroupRef,
    ): GroupSnapshot | undefined => room
        ? options.stateStore.findGroupSnapshot(room)
        : options.stateStore.roomState().currentRoom;

    const resolveRoomRef = (
        room: string | GroupRef | undefined,
        snapshot?: GroupSnapshot,
    ): GroupRef | undefined => typeof room === 'object'
        ? room
        : snapshot?.group ?? options.stateStore.resolveRoomRef(room);

    const roomKey = (roomRef: GroupRef): string => JSON.stringify([
        roomRef.applicationId,
        roomRef.workspaceId ?? '',
        roomRef.groupId,
    ]);

    const recordHeartbeat = (
        roomRef: GroupRef,
        appointment: RallarGroupDirectorAppointment,
        atEpochMs = Date.now(),
    ): void => {
        heartbeatByRoom.set(roomKey(roomRef), {
            sessionId: appointment.sessionId,
            epoch: appointment.epoch,
            atEpochMs,
        });
    };

    const status = (
        room?: string | GroupRef,
        statusOptions: RallarDirectorStatusOptions = {},
    ): RallarDirectorStatus => {
        const target = room ?? options.resolveDefaultRoom() ??
            options.stateStore.resolveCurrentRoomRef();
        const snapshot = findSnapshot(target);
        const roomRef = resolveRoomRef(target, snapshot);
        const appointment = readRallarGroupDirectorFromSnapshot(snapshot);
        const session = options.readSession();
        const heartbeat = roomRef
            ? heartbeatByRoom.get(roomKey(roomRef))
            : undefined;
        const matchingHeartbeat = heartbeat && appointment &&
            heartbeat.sessionId === appointment.sessionId &&
            heartbeat.epoch === appointment.epoch
            ? heartbeat
            : undefined;
        const now = statusOptions.now ?? Date.now();
        const active = isRallarGroupDirectorSessionActive(snapshot, appointment);
        const freshness = active
            ? readRallarGroupDirectorFreshness(
                appointment,
                matchingHeartbeat?.atEpochMs,
                now,
            )
            : appointment ? 'stale' : 'none';
        const isDirector = isRallarGroupDirectorForSession(appointment, session);
        return {
            roomRef,
            roomId: roomRef?.groupId ?? options.stateStore.toRoomId(target),
            role: appointment ? (isDirector ? 'director' : 'client') : 'none',
            state: !appointment
                ? 'none'
                : !active ? 'inactive' : freshness,
            appointment,
            isDirector,
            isFresh: freshness === 'fresh' && active,
            active,
            freshness,
            lastHeartbeatAtEpochMs: matchingHeartbeat?.atEpochMs,
            nowEpochMs: now,
        };
    };

    const emitStatuses = (): void => {
        if (listeners.size === 0) {
            return;
        }
        const current = status();
        for (const listener of listeners) {
            notifyListener(listener, current);
        }
    };

    const createEnvelope = <T>(
        current: RallarDirectorStatus,
        topicId: string,
        typeId: string,
        payload: T,
    ): RallarDirectorRelayEnvelope<T> => {
        if (!current.appointment || !current.roomId) {
            throw new Error(
                'Cannot create director envelope without appointment.',
            );
        }
        return {
            protocol: RALLAR_DIRECTOR_RELAY_PROTOCOL,
            topicId,
            typeId,
            roomId: current.roomId,
            epoch: current.appointment.epoch,
            sentAtEpochMs: Date.now(),
            payload,
        };
    };

    const sendIntent = async <T>(
        current: RallarDirectorStatus,
        laneId: string,
        topicId: string,
        typeId: string,
        payload: T,
    ): Promise<RallarDirectorRelaySendResult> => {
        if (!options.readSession()) {
            return { status: 'no-director', reason: 'Auth session ended.' };
        }
        if (!current.appointment || !current.roomId) {
            return {
                status: 'no-director',
                reason: 'No director is appointed for this room.',
            };
        }
        if (!current.isFresh) {
            return {
                status: 'stale-director',
                reason: 'The appointed director is stale or inactive.',
            };
        }
        if (current.isDirector) {
            return {
                status: 'not-director',
                reason: 'The local session is the director.',
            };
        }

        const envelope = createEnvelope(current, topicId, typeId, payload);
        const rtc = await options.createTargetedChannel<
            RallarDirectorRelayEnvelope<T>
        >({
            peerId: current.appointment.sessionId,
            laneId,
        }).send(envelope);
        if (rtc.status === 'sent') {
            return { status: 'sent', rtc };
        }
        const ws = await options.sendWsUnicast(
            current.appointment.sessionId,
            envelope,
            typeId,
            { topicId, contextId: current.roomId },
        );
        return {
            status: isSuccessfulMessageSendStatus(ws.status)
                ? 'sent'
                : 'failed',
            rtc,
            ws,
            reason: isSuccessfulMessageSendStatus(ws.status)
                ? undefined
                : ws.reason,
        };
    };

    const sendRoomEnvelope = async <T>(
        current: RallarDirectorStatus,
        topicId: string,
        typeId: string,
        payload: T,
    ): Promise<RallarDirectorRelaySendResult> => {
        if (!options.readSession()) {
            return { status: 'no-director', reason: 'Auth session ended.' };
        }
        if (!current.appointment || !current.roomRef || !current.roomId) {
            return {
                status: 'no-director',
                reason: 'No director is appointed for this room.',
            };
        }
        if (!current.isDirector) {
            return {
                status: 'not-director',
                reason: 'Only the appointed local director can send director output.',
            };
        }
        const envelope = createEnvelope(current, topicId, typeId, payload);
        const rtc = await options.messages.rtc.send({
            roomRef: current.roomRef,
            topicId,
            typeId,
            payload: envelope,
            reliability: 'best-effort',
            ack: 'none',
            ttlMs: 5_000,
        });
        if (isSuccessfulMessageSendStatus(rtc.status)) {
            return { status: 'sent', rtc };
        }
        const ws = await options.messages.ws.send({
            roomRef: current.roomRef,
            topicId,
            typeId,
            payload: envelope,
            reliability: 'best-effort',
            ack: 'none',
            ttlMs: 5_000,
        });
        return {
            status: isSuccessfulMessageSendStatus(ws.status)
                ? 'sent'
                : 'failed',
            rtc,
            ws,
            reason: isSuccessfulMessageSendStatus(ws.status)
                ? undefined
                : ws.reason ?? rtc.reason,
        };
    };

    const createRelay = <TIntent, TOutput, TSnapshot = TOutput>(
        config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>,
    ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> => {
        const laneId = config.laneId ?? DEFAULT_RALLAR_REALTIME_LANE_ID;
        const topicId = config.topicId ?? RALLAR_DIRECTOR_DEFAULT_TOPIC_ID;
        const heartbeatTypeId = config.heartbeatTypeId ?? `${topicId}.heartbeat`;
        const snapshotTypeId = config.snapshotTypeId ?? `${topicId}.snapshot`;
        const syncRequestTypeId = config.syncRequestTypeId ??
            `${topicId}.sync-request`;
        const roomTarget = config.roomRef ?? config.roomId;
        const subscriptions = createRallarSubscriptionScope();
        const timers: ReturnType<typeof setInterval>[] = [];
        let stopped = false;

        const readStatus = (): RallarDirectorStatus => status(roomTarget);
        const stop = (): void => {
            if (stopped) {
                return;
            }
            stopped = true;
            subscriptions.unsubscribe();
            for (const timer of timers) {
                clearInterval(timer);
            }
            timers.length = 0;
            relayStops.delete(stop);
        };
        relayStops.add(stop);

        const authEndedResult = (): RallarDirectorRelaySendResult => ({
            status: 'no-director',
            reason: 'Auth session ended.',
        });
        const guardSend = (): RallarDirectorRelaySendResult | undefined => {
            if (stopped) {
                return authEndedResult();
            }
            if (!options.readSession()) {
                stop();
                return authEndedResult();
            }
            return undefined;
        };

        const relay = {
            status: readStatus,
            sendIntent: async (intent: TIntent) => {
                const guarded = guardSend();
                return guarded ?? await sendIntent(
                    readStatus(),
                    laneId,
                    topicId,
                    config.intentTypeId,
                    intent,
                );
            },
            sendOutput: async (output: TOutput) => {
                const guarded = guardSend();
                return guarded ?? await sendRoomEnvelope(
                    readStatus(),
                    topicId,
                    config.outputTypeId,
                    output,
                );
            },
            sendHeartbeat: async () => {
                const guarded = guardSend();
                if (guarded) {
                    return guarded;
                }
                const current = readStatus();
                if (
                    current.roomRef && current.appointment &&
                    current.isDirector
                ) {
                    recordHeartbeat(current.roomRef, current.appointment);
                    emitStatuses();
                }
                return await sendRoomEnvelope(
                    current,
                    topicId,
                    heartbeatTypeId,
                    {
                        sessionId: current.appointment?.sessionId,
                        epoch: current.appointment?.epoch,
                    },
                );
            },
            sendSnapshot: async (snapshot?: TSnapshot) => {
                const guarded = guardSend();
                if (guarded) {
                    return guarded;
                }
                const resolved = snapshot ?? await config.readSnapshot?.();
                if (resolved === undefined) {
                    return {
                        status: 'failed' as const,
                        reason: 'No director snapshot is available.',
                    };
                }
                return await sendRoomEnvelope(
                    readStatus(),
                    topicId,
                    snapshotTypeId,
                    resolved,
                );
            },
            requestSync: async (payload?: unknown) => {
                const guarded = guardSend();
                return guarded ?? await sendIntent(
                    readStatus(),
                    laneId,
                    topicId,
                    syncRequestTypeId,
                    payload ?? {},
                );
            },
            stop,
        } satisfies RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>;

        const handleEnvelope = async <T>(
            transport: 'rtc' | 'ws',
            senderId: string,
            envelope: RallarDirectorRelayEnvelope<T>,
        ): Promise<void> => {
            const currentStatus = readStatus();
            if (
                stopped || !isCurrentDirectorEnvelope(currentStatus, envelope)
            ) {
                return;
            }
            const message: RallarDirectorRelayMessage<T> = {
                transport,
                senderId,
                data: envelope.payload,
                envelope,
                receivedAtEpochMs: Date.now(),
            };
            if (envelope.typeId === heartbeatTypeId) {
                const current = readStatus();
                if (senderId !== current.appointment?.sessionId) {
                    return;
                }
                if (current.roomRef && current.appointment) {
                    recordHeartbeat(
                        current.roomRef,
                        current.appointment,
                        message.receivedAtEpochMs,
                    );
                    emitStatuses();
                }
                return;
            }
            if (envelope.typeId === config.outputTypeId) {
                const current = readStatus();
                if (
                    !current.isFresh ||
                    senderId !== current.appointment?.sessionId
                ) {
                    return;
                }
                await config.onOutput?.(
                    message as unknown as RallarDirectorRelayMessage<TOutput>,
                );
                return;
            }
            if (envelope.typeId === snapshotTypeId) {
                const current = readStatus();
                if (
                    !current.isFresh ||
                    senderId !== current.appointment?.sessionId
                ) {
                    return;
                }
                await config.onSnapshot?.(
                    message as unknown as RallarDirectorRelayMessage<TSnapshot>,
                );
                return;
            }
            if (!readStatus().isDirector) {
                return;
            }
            if (envelope.typeId === config.intentTypeId) {
                const output = await config.onIntent?.(
                    message as unknown as RallarDirectorRelayMessage<TIntent>,
                    relay,
                );
                const outputs = Array.isArray(output)
                    ? output
                    : output ? [output] : [];
                for (const item of outputs) {
                    await relay.sendOutput(item as TOutput);
                }
                return;
            }
            if (envelope.typeId === syncRequestTypeId) {
                await config.onSyncRequest?.(message, relay);
                if (config.readSnapshot) {
                    await relay.sendSnapshot();
                }
            }
        };

        subscriptions
            .add(options.realtime.onJson<RallarDirectorRelayEnvelope>(
                laneId,
                async (message) => {
                    if (isDirectorRelayEnvelope(message.data, topicId)) {
                        await handleEnvelope(
                            'rtc',
                            message.peerId,
                            message.data,
                        );
                    }
                },
            ))
            .add(options.messages.ws.onMessage<RallarDirectorRelayEnvelope>(
                { topicId },
                async (message) => {
                    if (isDirectorRelayEnvelope(message.payload, topicId)) {
                        await handleEnvelope(
                            'ws',
                            message.senderId,
                            message.payload,
                        );
                    }
                },
            ));

        for (const typeId of [
            config.outputTypeId,
            heartbeatTypeId,
            snapshotTypeId,
        ]) {
            subscriptions.add(
                options.messages.rtc.onMessage<RallarDirectorRelayEnvelope>(
                    { topicId, typeId },
                    async (message) => {
                        if (isDirectorRelayEnvelope(message.payload, topicId)) {
                            await handleEnvelope(
                                'rtc',
                                message.senderId,
                                message.payload,
                            );
                        }
                    },
                ),
            );
        }

        const heartbeatIntervalMs = config.heartbeatIntervalMs ?? Math.max(
            500,
            Math.min(
                2_000,
                (readStatus().appointment?.heartbeatTtlMs ??
                    DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS) / 2,
            ),
        );
        timers.push(setInterval(() => {
            if (stopped) {
                return;
            }
            if (!options.readSession()) {
                stop();
                return;
            }
            if (readStatus().isDirector) {
                void relay.sendHeartbeat().catch((error) => {
                    console.error(
                        'Failed to send director relay heartbeat:',
                        error,
                    );
                });
            }
        }, heartbeatIntervalMs));

        if (config.readSnapshot && config.snapshotIntervalMs !== false) {
            timers.push(setInterval(() => {
                if (stopped) {
                    return;
                }
                if (!options.readSession()) {
                    stop();
                    return;
                }
                if (readStatus().isDirector) {
                    void relay.sendSnapshot().catch((error) => {
                        console.error(
                            'Failed to send director relay snapshot:',
                            error,
                        );
                    });
                }
            }, config.snapshotIntervalMs ?? 2_000));
        }
        return relay;
    };

    const operations: CreateRallarDirectorFacadeOptions = {
        appoint: async (
            room?: string | GroupRef,
            appointOptions: RallarDirectorAppointOptions = {},
        ): Promise<RallarDirectorStatus> =>
            await options.runAuthAwareOperation(async () => {
                const operationOptions = options.resolveOperationOptions(
                    appointOptions,
                );
                const ctx = await options.connect(operationOptions);
                const target = room ?? options.resolveDefaultRoom() ??
                    options.stateStore.resolveCurrentRoomRef();
                const snapshot = findSnapshot(target);
                const roomRef = resolveRoomRef(target, snapshot);
                const roomId = options.stateStore.toRoomId(roomRef ?? target);
                if (!roomRef || !roomId) {
                    throw new Error(
                        'Cannot appoint director: no room selected.',
                    );
                }
                const session = options.requireSession();
                const scope = appointOptions.scope ??
                    (roomRef
                        ? toStateScope(roomRef)
                        : options.resolveOperationScope());
                const updated = await apiWorkflows.appointStateGroupDirector(
                    roomId,
                    { heartbeatTtlMs: appointOptions.heartbeatTtlMs },
                    session.clientId,
                    session.sessionId,
                    scope,
                    toRallarWorkflowPolicies(operationOptions),
                );
                await options.acceptSnapshots(ctx, [updated], scope);
                const appointment = readRallarGroupDirectorFromSnapshot(updated);
                if (appointment) {
                    recordHeartbeat(roomRef, appointment);
                }
                emitStatuses();
                return status(updated.group);
            }),
        resign: async (
            room?: string | GroupRef,
            resignOptions: RallarDirectorResignOptions = {},
        ): Promise<RallarDirectorStatus> => {
            const target = room ?? options.resolveDefaultRoom() ??
                options.stateStore.resolveCurrentRoomRef();
            const snapshot = findSnapshot(target);
            const roomRef = resolveRoomRef(target, snapshot);
            const roomId = options.stateStore.toRoomId(roomRef ?? target);
            if (!roomRef || !roomId) {
                throw new Error('Cannot resign director: no room selected.');
            }
            const appointment = readRallarGroupDirectorFromSnapshot(snapshot);
            if (
                !isRallarGroupDirectorForSession(
                    appointment,
                    options.requireSession(),
                )
            ) {
                return status(roomRef);
            }
            const metadata = mergeRallarGroupDirectorMetadata(
                snapshot?.group.metadata,
                undefined,
            );
            const updated = await options.rooms.updateMetadata(
                roomRef,
                metadata,
                resignOptions,
            );
            heartbeatByRoom.delete(roomKey(roomRef));
            emitStatuses();
            return status(updated.group);
        },
        status,
        onStatus: (listener): RallarUnsubscribe => {
            listeners.add(listener);
            notifyListener(listener, status());
            return () => listeners.delete(listener);
        },
        createRelay,
    };

    return {
        operations,
        onStateChanged: emitStatuses,
        stopRelays: () => {
            const stops = [...relayStops];
            relayStops.clear();
            for (const stop of stops) {
                runShutdownStep(stop);
            }
        },
    };
}

function isCurrentDirectorEnvelope(
    status: RallarDirectorStatus,
    envelope: RallarDirectorRelayEnvelope,
): boolean {
    return Boolean(
        status.appointment && status.roomId &&
        envelope.roomId === status.roomId &&
        envelope.epoch === status.appointment.epoch,
    );
}

function isDirectorRelayEnvelope(
    value: unknown,
    topicId: string,
): value is RallarDirectorRelayEnvelope {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const envelope = value as Partial<RallarDirectorRelayEnvelope>;
    return envelope.protocol === RALLAR_DIRECTOR_RELAY_PROTOCOL &&
        envelope.topicId === topicId &&
        typeof envelope.typeId === 'string' &&
        typeof envelope.roomId === 'string' &&
        typeof envelope.epoch === 'number' &&
        typeof envelope.sentAtEpochMs === 'number' &&
        'payload' in envelope;
}

function isSuccessfulMessageSendStatus(
    status: RallarMessageSendStatus,
): boolean {
    return status === 'enqueued' || status === 'sent-immediate' ||
        status === 'duplicate' || status === 'superseded' || status === 'skipped';
}

function runShutdownStep(step: () => void): void {
    try {
        step();
    } catch {
        // Relay teardown remains best-effort during transport shutdown.
    }
}
