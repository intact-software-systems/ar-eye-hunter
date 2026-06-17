import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarDirectorRelayMessage,
    RallarDirectorStatus,
    RallarMessageSendStatus,
    RallarRealtimeSendResult,
    RallarRoomRealtimeSendResult,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomLaneWaitStatus,
    RallarRtcStatus,
    RallarSubscriptionScope,
} from '@shared-web/browser/rallar.ts';
import { deriveRallarGameDiagnostics } from './diagnostics.ts';
import {
    createRallarGameEnvelope,
    createRallarGameSequenceTracker,
    isRallarGameEnvelope,
} from './envelopes.ts';
import {
    DEFAULT_RALLAR_GAME_CAPABILITY_TTL_MS,
    electRallarGameHost,
    scoreRallarGameHostCapability,
} from './election.ts';
import { resolveRallarGameLaneIds } from './lanes.ts';
import type {
    RallarGameEnvelope,
    RallarGameEnvelopeHandler,
    RallarGameEnvelopeKind,
    RallarGameDirectorAppointmentEligibility,
    RallarGameDirectorAppointmentPolicy,
    RallarGameHostAppointResult,
    RallarGameHostCapability,
    RallarGameHostElectionResult,
    RallarGameLaneIds,
    RallarGameLaneReadyOptions,
    RallarGameMatchConfig,
    RallarGameMatchHandle,
    RallarGameMatchPhase,
    RallarGameMatchStatus,
    RallarGamePeerReadiness,
    RallarGamePresenceSendOptions,
    RallarGameRecoveryState,
    RallarGameRuntimeRelay,
    RallarGameSendResult,
    RallarGameStatusHandler,
    RallarGameTypeIds,
} from './types.ts';

const DEFAULT_RALLAR_GAME_HEARTBEAT_TTL_MS = 10_000;

export function resolveRallarGameTypeIds(
    topicId: string,
    typeIds: Partial<RallarGameTypeIds> = {},
): RallarGameTypeIds {
    return {
        capability: `${topicId}.capability.v1`,
        intent: `${topicId}.intent.v1`,
        event: `${topicId}.event.v1`,
        snapshot: `${topicId}.snapshot.v1`,
        syncRequest: `${topicId}.sync-request.v1`,
        heartbeat: `${topicId}.heartbeat.v1`,
        ...typeIds,
    };
}

export function createRallarGameMatch<
    TInput,
    TIntent,
    TSnapshot,
    TEvent,
    TPresence = TInput,
>(
    config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>,
): RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    const laneIds = resolveRallarGameLaneIds(config.laneIds);
    const typeIds = resolveRallarGameTypeIds(config.topicId, config.typeIds);
    const capabilityTtlMs = config.capabilityTtlMs ??
        DEFAULT_RALLAR_GAME_CAPABILITY_TTL_MS;
    const heartbeatTtlMs = config.heartbeatTtlMs ??
        DEFAULT_RALLAR_GAME_HEARTBEAT_TTL_MS;
    const sequenceTracker = createRallarGameSequenceTracker();
    const capabilities = new Map<string, RallarGameHostCapability>();
    const statusHandlers = new Set<RallarGameStatusHandler>();
    const presenceHandlers = new Set<RallarGameEnvelopeHandler<TPresence>>();

    let subscriptions: RallarSubscriptionScope | undefined;
    let relay:
        | RallarGameRuntimeRelay<TIntent, TSnapshot, TEvent>
        | undefined;
    let started = false;
    let stopped = false;
    let nextSeq = 1;
    let lastPeerReadiness: RallarGamePeerReadiness | undefined;
    let lastAppointmentResult: RallarGameHostAppointResult | undefined;
    let recovery: RallarGameRecoveryState = { status: 'idle' };
    let currentStatus = createStatus('idle');

    const handle: RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence> = {
        start,
        stop,
        status: () => currentStatus,
        diagnostics: () =>
            deriveRallarGameDiagnostics({
                status: currentStatus,
                election: handle.election(),
                appointment: handle.canAppointDirector(),
                lastAppointment: lastAppointmentResult,
                peerReadiness: lastPeerReadiness,
                rtcStatus: safeReadRtcStatus(laneIds.input),
                wsStatus: safeReadWsStatus(),
                realtimeHealth: safeReadRealtimeHealth(laneIds),
                capabilities: [...capabilities.values()],
            }),
        canAppointDirector,
        reportCapability,
        election,
        appointIfElected,
        waitForReadyLanes,
        sendPresence,
        sendInput,
        sendIntent,
        publishSnapshot,
        publishEvent,
        requestSync,
        onPresence(handler): () => void {
            presenceHandlers.add(handler);
            return () => {
                presenceHandlers.delete(handler);
            };
        },
        onStatus(handler): () => void {
            statusHandlers.add(handler);
            void notifyStatusHandler(handler, currentStatus);
            return () => {
                statusHandlers.delete(handler);
            };
        },
    };

    return handle;

    async function start(): Promise<RallarGameMatchStatus> {
        if (started && !stopped) {
            return currentStatus;
        }

        started = true;
        stopped = false;
        sequenceTracker.reset();
        subscriptions = config.rallar.subscriptions();
        relay = createRelay();
        subscriptions
            .add(config.rallar.rooms.onChange(() => refreshStatus()))
            .add(config.rallar.people.onChange(() => refreshStatus()))
            .add(config.rallar.director.onStatus(() => refreshStatus()))
            .add(config.rallar.rtc.onStatus((status) => {
                refreshStatus();
                if (!status.readyPeerIds.includes(currentStatus.directorPeerId ?? '')) {
                    return;
                }
            }))
            .add(config.rallar.messages.ws.onMessage<RallarGameEnvelope<unknown>>(
                { topicId: config.topicId, typeId: typeIds.capability },
                handleCapabilityMessage,
            ))
            .add(config.rallar.realtime.onJson<RallarGameEnvelope<TInput | TPresence>>(
                laneIds.input,
                handleRealtimeInputOrPresence,
            ))
            .add(config.rallar.realtime.onJson<RallarGameEnvelope<TSnapshot>>(
                laneIds.snapshot,
                handleRealtimeSnapshot,
            ))
            .add(() => relay?.stop());

        refreshStatus();
        return currentStatus;
    }

    function stop(): void {
        if (stopped) {
            return;
        }

        stopped = true;
        started = false;
        subscriptions?.unsubscribe();
        subscriptions = undefined;
        relay?.stop();
        relay = undefined;
        setStatus('stopped');
    }

    async function reportCapability(
        capability: Partial<RallarGameHostCapability> = {},
    ): Promise<RallarGameSendResult> {
        if (stopped) {
            return { status: 'stopped', reason: 'Rallar Game match is stopped.' };
        }

        const localPeerId = readLocalPeerId();
        if (!localPeerId) {
            return {
                status: 'failed',
                reason: 'Cannot report capability without a local session.',
            };
        }

        const room = readRoomTarget();
        if (!room.roomId) {
            return {
                status: 'failed',
                reason: 'Cannot report capability without a room.',
            };
        }

        const read = config.readCapability?.() ?? {};
        const appointment = canAppointDirector();
        const reportedAtEpochMs = Date.now();
        const report: RallarGameHostCapability = {
            ...read,
            ...capability,
            canHost: appointment.allowed
                ? (capability.canHost ?? read.canHost)
                : false,
            peerId: localPeerId,
            reportedAtEpochMs,
        };
        capabilities.set(localPeerId, report);

        const envelope = createEnvelope('capability', report, {
            directorEpoch: currentStatus.directorEpoch ?? 0,
            roomId: room.roomId,
            senderId: localPeerId,
            sentAtEpochMs: reportedAtEpochMs,
        });
        const ws = await config.rallar.messages.ws.send({
            topicId: config.topicId,
            typeId: typeIds.capability,
            payload: envelope,
            scope: 'room',
            roomId: room.roomRef ? undefined : room.roomId,
            roomRef: room.roomRef,
            reliability: 'best-effort',
            ack: 'none',
        });
        refreshStatus();

        return {
            status: isSuccessfulMessageStatus(ws.status) ? 'sent' : 'failed',
            transport: 'ws',
            ws,
            reason: isSuccessfulMessageStatus(ws.status) ? undefined : ws.reason,
        };
    }

    function election(): RallarGameHostElectionResult {
        const roomState = config.rallar.rooms.state();
        const peerIds = config.resolvePeerIds
            ? config.resolvePeerIds(roomState)
            : resolveDefaultPeerIds(roomState, readLocalPeerId());
        const appointment = canAppointDirector();
        const capabilityValues = [...capabilities.values()];
        if (!appointment.allowed && appointment.localPeerId) {
            const previous = capabilities.get(appointment.localPeerId);
            capabilityValues.push({
                ...previous,
                peerId: appointment.localPeerId,
                reportedAtEpochMs: Date.now(),
                canHost: false,
            });
        }

        return electRallarGameHost({
            peerIds,
            capabilities: capabilityValues,
            capabilityTtlMs,
            scoreHost: config.scoreHost ?? scoreRallarGameHostCapability,
        });
    }

    function canAppointDirector(): RallarGameDirectorAppointmentEligibility {
        const room = readRoomTarget();
        const roomState = config.rallar.rooms.state();
        const session = config.rallar.session();
        const localPeerId = session?.sessionId;
        const localPrincipalId = session?.clientId;
        const policy = config.directorAppointmentPolicy ??
            'metadata-owner-admin';
        const context = {
            policy,
            roomId: room.roomId,
            roomRef: room.roomRef,
            roomState,
            localPeerId,
            localPrincipalId,
        };

        if (config.canAppointDirector) {
            return config.canAppointDirector(context);
        }

        if (policy === 'none') {
            return {
                allowed: true,
                status: 'allowed',
                policy,
                localPeerId,
                localPrincipalId,
            };
        }

        return resolveMetadataOwnerAdminAppointmentEligibility(context);
    }

    async function appointIfElected(): Promise<RallarGameHostAppointResult> {
        const appointment = canAppointDirector();
        const result = election();
        const localPeerId = readLocalPeerId();
        if (!localPeerId) {
            lastAppointmentResult = {
                status: 'no-local-peer',
                election: result,
                reason: 'Cannot appoint a director without a local session.',
            };
            return lastAppointmentResult;
        }

        if (!appointment.allowed) {
            lastAppointmentResult = {
                status: appointment.status === 'not-ready'
                    ? 'not-ready'
                    : appointment.status === 'no-local-peer'
                    ? 'no-local-peer'
                    : 'not-authorized',
                election: result,
                reason: appointment.reason,
            };
            refreshStatus();
            return lastAppointmentResult;
        }

        if (result.host?.peerId !== localPeerId) {
            lastAppointmentResult = {
                status: 'not-elected',
                election: result,
                reason: 'The local peer is not the elected host.',
            };
            return lastAppointmentResult;
        }

        try {
            const room = readRoomTarget();
            const directorStatus = await config.rallar.director.appoint(
                room.roomRef ?? room.roomId,
                { heartbeatTtlMs },
            );
            refreshStatus(directorStatus);
            lastAppointmentResult = {
                status: 'appointed',
                election: result,
                directorStatus,
            };
            return lastAppointmentResult;
        } catch (error) {
            lastAppointmentResult = {
                status: 'failed',
                election: result,
                reason: error instanceof Error ? error.message : String(error),
            };
            return lastAppointmentResult;
        }
    }

    async function waitForReadyLanes(
        options: RallarGameLaneReadyOptions = {},
    ): Promise<RallarGamePeerReadiness> {
        const room = readRoomTarget();
        const selectedLaneIds = options.laneIds ?? [
            laneIds.input,
            laneIds.intent,
            laneIds.snapshot,
            laneIds.metrics,
            laneIds.replication,
        ];
        if (!room.roomId) {
            lastPeerReadiness = {
                status: 'no-room',
                laneIds: selectedLaneIds,
                readyPeerIds: [],
                notReadyPeerIds: [],
                lanes: [],
                reason: 'Cannot wait for lanes without a room.',
            };
            refreshStatus();
            return lastPeerReadiness;
        }

        const roomTarget = room.roomRef ?? room.roomId;
        const lanes = await Promise.all(
            selectedLaneIds.map((laneId) =>
                config.rallar.rtc.waitForRoomLane(
                    roomTarget,
                    laneId,
                    {
                        connect: options.connect ?? true,
                        timeoutMs: options.timeoutMs,
                        signal: options.signal,
                    },
                )
            ),
        );
        const readyPeerIds = uniqueSorted(
            lanes.flatMap((lane) =>
                lane.ready.map((entry) => entry.peerId)
            ),
        );
        const notReadyPeerIds = uniqueSorted(
            lanes.flatMap((lane) =>
                lane.notReady.map((entry) => entry.peerId)
            ),
        );

        lastPeerReadiness = {
            status: combineLaneStatuses(lanes),
            roomId: room.roomId,
            laneIds: selectedLaneIds,
            readyPeerIds,
            notReadyPeerIds,
            lanes,
        };
        refreshStatus();
        return lastPeerReadiness;
    }

    async function sendPresence(
        presence: TPresence,
        options: RallarGamePresenceSendOptions = {},
    ): Promise<RallarGameSendResult> {
        if (stopped) {
            return { status: 'stopped', reason: 'Rallar Game match is stopped.' };
        }

        const room = readRoomTarget();
        if (!room.roomId) {
            return {
                status: 'not-ready',
                transport: 'realtime',
                reason: 'Cannot send presence without a room.',
            };
        }

        const envelope = createEnvelope('presence', presence, {
            directorEpoch: currentStatus.directorEpoch ?? 0,
        });
        const realtime = await config.rallar.realtime.room({
            laneId: options.laneId ?? laneIds.input,
            roomId: room.roomRef ? undefined : room.roomId,
            roomRef: room.roomRef,
            openTimeoutMs: options.openTimeoutMs ?? 500,
        }).send(envelope, {
            key: options.key ?? `presence:${envelope.senderId}`,
            maxAgeMs: options.maxAgeMs ?? 250,
        });
        return toRoomRealtimeSendResult(realtime);
    }

    async function sendInput(input: TInput): Promise<RallarGameSendResult> {
        const director = readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }

        const envelope = createEnvelope('input', input, {
            directorEpoch: director.appointment.epoch,
        });
        if (director.isDirector) {
            await routeEnvelope(envelope, 'input', config.onInput);
            return { status: 'sent', transport: 'local' };
        }

        const realtime = await config.rallar.realtime.sendJson({
            laneId: laneIds.input,
            peerIds: [director.appointment.sessionId],
            data: envelope,
            key: `input:${envelope.senderId}`,
            maxAgeMs: 250,
        });

        return toRealtimeSendResult(realtime);
    }

    async function sendIntent(intent: TIntent): Promise<RallarGameSendResult> {
        const director = readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }

        const envelope = createEnvelope('intent', intent, {
            directorEpoch: director.appointment.epoch,
        });
        if (director.isDirector) {
            await routeEnvelope(envelope, 'intent', config.onIntent);
            return { status: 'sent', transport: 'local' };
        }

        const result = await ensureRelay().sendIntent(envelope);
        return toRelaySendResult(result);
    }

    async function publishSnapshot(
        snapshot: TSnapshot,
        options: { reliable?: boolean } = {},
    ): Promise<RallarGameSendResult> {
        const director = readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }

        if (!director.isDirector) {
            return {
                status: 'not-director',
                reason: 'Only the fresh local director can publish snapshots.',
            };
        }

        const envelope = createEnvelope('snapshot', snapshot, {
            directorEpoch: director.appointment.epoch,
        });
        if (options.reliable) {
            return toRelaySendResult(await ensureRelay().sendSnapshot(envelope));
        }

        const room = readRoomTarget();
        const realtime = await config.rallar.realtime.room({
            laneId: laneIds.snapshot,
            roomId: room.roomRef ? undefined : room.roomId,
            roomRef: room.roomRef,
        }).send(envelope, {
            key: `snapshot:${envelope.senderId}`,
            maxAgeMs: 500,
        });
        return toRoomRealtimeSendResult(realtime);
    }

    async function publishEvent(event: TEvent): Promise<RallarGameSendResult> {
        const director = readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }

        if (!director.isDirector) {
            return {
                status: 'not-director',
                reason: 'Only the fresh local director can publish events.',
            };
        }

        const envelope = createEnvelope('event', event, {
            directorEpoch: director.appointment.epoch,
        });
        return toRelaySendResult(await ensureRelay().sendOutput(envelope));
    }

    async function requestSync(
        payload: unknown = {},
    ): Promise<RallarGameSendResult> {
        const director = readFreshDirectorStatus();
        if (!director) {
            return noDirectorResult();
        }

        const envelope = createEnvelope('sync-request', payload, {
            directorEpoch: director.appointment.epoch,
        });
        recovery = {
            ...recovery,
            lastSyncRequestedAtEpochMs: envelope.sentAtEpochMs,
        };
        refreshStatus();

        if (director.isDirector) {
            await routeEnvelope(envelope, 'sync-request', config.onSyncRequest);
            const snapshot = await config.readSnapshot?.();
            if (snapshot !== undefined) {
                await publishSnapshot(snapshot, { reliable: true });
            }
            return { status: 'sent', transport: 'local' };
        }

        return toRelaySendResult(await ensureRelay().requestSync(envelope));
    }

    function createRelay(): RallarGameRuntimeRelay<TIntent, TSnapshot, TEvent> {
        return config.rallar.director.createRelay<
            RallarGameEnvelope<TIntent>,
            RallarGameEnvelope<TEvent>,
            RallarGameEnvelope<TSnapshot>
        >({
            roomId: config.roomRef ? undefined : config.roomId,
            roomRef: config.roomRef,
            laneId: laneIds.intent,
            topicId: config.topicId,
            intentTypeId: typeIds.intent,
            outputTypeId: typeIds.event,
            heartbeatTypeId: typeIds.heartbeat,
            snapshotTypeId: typeIds.snapshot,
            syncRequestTypeId: typeIds.syncRequest,
            heartbeatIntervalMs: Math.max(500, heartbeatTtlMs / 2),
            snapshotIntervalMs: config.autoSnapshotIntervalMs,
            readSnapshot: config.readSnapshot
                ? async () => {
                    const snapshot = await config.readSnapshot?.();
                    if (snapshot === undefined) {
                        return undefined;
                    }
                    const director = readFreshDirectorStatus();
                    if (!director?.isDirector) {
                        return undefined;
                    }
                    return createEnvelope('snapshot', snapshot, {
                        directorEpoch: director.appointment.epoch,
                    });
                }
                : undefined,
            onIntent: async (message) => {
                await handleRelayEnvelope(
                    message,
                    'intent',
                    config.onIntent,
                );
            },
            onOutput: async (message) => {
                await handleRelayEnvelope(
                    message,
                    'event',
                    config.onEvent,
                    { requireFreshDirectorSender: true },
                );
            },
            onSnapshot: async (message) => {
                await handleRelayEnvelope(
                    message,
                    'snapshot',
                    config.onSnapshot,
                    { requireFreshDirectorSender: true },
                );
            },
            onSyncRequest: async (message) => {
                await handleRelayEnvelope(
                    message as RallarDirectorRelayMessage<
                        RallarGameEnvelope<unknown>
                    >,
                    'sync-request',
                    config.onSyncRequest,
                );
            },
        });
    }

    async function handleCapabilityMessage(
        message: {
            senderId: string;
            payload: RallarGameEnvelope<unknown>;
        },
    ): Promise<void> {
        if (stopped || !isRallarGameEnvelope(message.payload, config.protocol)) {
            return;
        }

        const accepted = acceptEnvelope(message.payload, 'capability', {
            senderId: message.senderId,
            checkDirectorEpoch: false,
        });
        if (!accepted) {
            return;
        }

        const capability = toHostCapability(message.payload);
        if (!capability) {
            return;
        }

        capabilities.set(capability.peerId, capability);
        refreshStatus();
    }

    async function handleRealtimeInputOrPresence(
        message: {
            peerId: string;
            data: RallarGameEnvelope<TInput | TPresence>;
        },
    ): Promise<void> {
        const envelope = message.data;
        if (!isRallarGameEnvelope(envelope, config.protocol)) {
            return;
        }

        if (envelope.kind === 'presence') {
            await handleRealtimePresence(
                message.peerId,
                envelope as RallarGameEnvelope<TPresence>,
            );
            return;
        }

        if (stopped || !currentStatus.directorIsFresh) {
            return;
        }

        const director = readFreshDirectorStatus();
        if (!director?.isDirector) {
            return;
        }

        if (
            envelope.kind !== 'input' ||
            !acceptEnvelope(envelope, 'input', { senderId: message.peerId })
        ) {
            return;
        }

        await config.onInput?.(envelope as RallarGameEnvelope<TInput>);
    }

    async function handleRealtimePresence(
        peerId: string,
        envelope: RallarGameEnvelope<TPresence>,
    ): Promise<void> {
        if (
            stopped ||
            !acceptEnvelope(envelope, 'presence', {
                senderId: peerId,
                checkDirectorEpoch: false,
            })
        ) {
            return;
        }

        await config.onPresence?.(envelope);
        for (const handler of presenceHandlers) {
            await handler(envelope);
        }
    }

    async function handleRealtimeSnapshot(
        message: {
            peerId: string;
            data: RallarGameEnvelope<TSnapshot>;
        },
    ): Promise<void> {
        if (stopped || !currentStatus.directorIsFresh) {
            return;
        }

        const directorPeerId = currentStatus.directorPeerId;
        if (!directorPeerId || message.peerId !== directorPeerId) {
            return;
        }

        const envelope = message.data;
        if (
            !isRallarGameEnvelope(envelope, config.protocol) ||
            !acceptEnvelope(envelope, 'snapshot', {
                senderId: directorPeerId,
                requireFreshDirectorSender: true,
            })
        ) {
            return;
        }

        recovery = {
            status: recovery.status === 'recovering' ? 'synced' : recovery.status,
            lastSnapshotAtEpochMs: envelope.sentAtEpochMs,
        };
        refreshStatus();
        await config.onSnapshot?.(envelope);
    }

    async function handleRelayEnvelope<T>(
        message: RallarDirectorRelayMessage<RallarGameEnvelope<T>>,
        kind: RallarGameEnvelopeKind,
        handler: RallarGameEnvelopeHandler<T> | undefined,
        options: Readonly<{
            requireFreshDirectorSender?: boolean;
        }> = {},
    ): Promise<void> {
        if (stopped || !isRallarGameEnvelope(message.data, config.protocol)) {
            return;
        }

        if (
            !acceptEnvelope(message.data, kind, {
                senderId: message.senderId,
                requireFreshDirectorSender: options.requireFreshDirectorSender,
            })
        ) {
            return;
        }

        if (kind === 'snapshot') {
            recovery = {
                status: recovery.status === 'recovering' ? 'synced' : recovery.status,
                lastSnapshotAtEpochMs: message.data.sentAtEpochMs,
            };
            refreshStatus();
        }

        await handler?.(message.data);
    }

    function acceptEnvelope(
        envelope: RallarGameEnvelope<unknown>,
        kind: RallarGameEnvelopeKind,
        options: Readonly<{
            senderId?: string;
            checkDirectorEpoch?: boolean;
            requireFreshDirectorSender?: boolean;
        }> = {},
    ): boolean {
        const room = readRoomTarget();
        const directorEpoch = options.checkDirectorEpoch === false
            ? undefined
            : currentStatus.directorEpoch;
        const senderId = options.requireFreshDirectorSender
            ? currentStatus.directorPeerId
            : options.senderId;
        const accepted = sequenceTracker.accept(envelope, {
            protocol: config.protocol,
            roomId: room.roomId,
            senderId,
            minDirectorEpoch: directorEpoch,
            kinds: [kind],
        });

        return accepted.accepted;
    }

    async function routeEnvelope<T>(
        envelope: RallarGameEnvelope<T>,
        kind: RallarGameEnvelopeKind,
        handler: RallarGameEnvelopeHandler<T> | undefined,
    ): Promise<void> {
        if (
            !stopped &&
            acceptEnvelope(envelope, kind, {
                senderId: envelope.senderId,
            })
        ) {
            await handler?.(envelope);
        }
    }

    function refreshStatus(
        directorStatus: RallarDirectorStatus = readDirectorStatus(),
    ): void {
        if (stopped) {
            return;
        }

        const nextPhase: RallarGameMatchPhase = !started
            ? 'idle'
            : directorStatus.isFresh
            ? 'active'
            : 'recovering';
        if (started && !directorStatus.isFresh) {
            recovery = {
                status: 'recovering',
                reason: 'No fresh director is available.',
                sinceEpochMs: recovery.status === 'recovering'
                    ? recovery.sinceEpochMs
                    : Date.now(),
                lastSyncRequestedAtEpochMs: recovery.lastSyncRequestedAtEpochMs,
                lastSnapshotAtEpochMs: recovery.lastSnapshotAtEpochMs,
            };
        } else if (directorStatus.isFresh && recovery.status === 'recovering') {
            recovery = {
                status: 'idle',
                lastSnapshotAtEpochMs: recovery.lastSnapshotAtEpochMs,
            };
        }

        setStatus(nextPhase, directorStatus);
    }

    function setStatus(
        phase: RallarGameMatchPhase,
        directorStatus: RallarDirectorStatus = readDirectorStatus(),
        reason?: string,
    ): void {
        currentStatus = createStatus(phase, directorStatus, reason);
        emitStatus(currentStatus);
    }

    function createStatus(
        phase: RallarGameMatchPhase,
        directorStatus: RallarDirectorStatus = readDirectorStatus(),
        reason?: string,
    ): RallarGameMatchStatus {
        const room = readRoomTarget(directorStatus);
        return {
            phase,
            protocol: config.protocol,
            topicId: config.topicId,
            roomId: room.roomId,
            roomRef: room.roomRef,
            localPeerId: readLocalPeerId(),
            directorPeerId: directorStatus.appointment?.sessionId,
            directorEpoch: directorStatus.appointment?.epoch,
            directorIsFresh: directorStatus.isFresh,
            recovery,
            started,
            stopped,
            updatedAtEpochMs: Date.now(),
            reason,
        };
    }

    function readFreshDirectorStatus(): (RallarDirectorStatus & {
        appointment: NonNullable<RallarDirectorStatus['appointment']>;
    }) | undefined {
        const status = readDirectorStatus();
        if (!status.isFresh || !status.appointment) {
            refreshStatus(status);
            return undefined;
        }
        refreshStatus(status);
        return status as RallarDirectorStatus & {
            appointment: NonNullable<RallarDirectorStatus['appointment']>;
        };
    }

    function readDirectorStatus(): RallarDirectorStatus {
        const room = readRoomTarget();
        return config.rallar.director.status(room.roomRef ?? room.roomId);
    }

    function readRoomTarget(
        directorStatus?: RallarDirectorStatus,
    ): Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
    }> {
        const roomState = config.rallar.rooms.state();
        const roomRef = config.roomRef ??
            directorStatus?.roomRef ??
            roomState.currentRoomRef;
        const roomId = config.roomId ??
            roomRef?.groupId ??
            directorStatus?.roomId ??
            roomState.currentRoomId;
        return { roomId, roomRef };
    }

    function readLocalPeerId(): string | undefined {
        return config.rallar.session()?.sessionId;
    }

    function createEnvelope<T>(
        kind: RallarGameEnvelopeKind,
        payload: T,
        options: Readonly<{
            directorEpoch: number;
            roomId?: string;
            senderId?: string;
            sentAtEpochMs?: number;
        }>,
    ): RallarGameEnvelope<T> {
        const room = readRoomTarget();
        const roomId = options.roomId ?? room.roomId;
        const senderId = options.senderId ?? readLocalPeerId();
        if (!roomId) {
            throw new Error('Cannot create Rallar Game envelope without a room.');
        }
        if (!senderId) {
            throw new Error(
                'Cannot create Rallar Game envelope without a local session.',
            );
        }

        return createRallarGameEnvelope({
            protocol: config.protocol,
            kind,
            roomId,
            senderId,
            seq: nextSeq++,
            directorEpoch: options.directorEpoch,
            sentAtEpochMs: options.sentAtEpochMs,
            payload,
        });
    }

    function ensureRelay(): RallarGameRuntimeRelay<TIntent, TSnapshot, TEvent> {
        if (relay) {
            return relay;
        }

        relay = createRelay();
        return relay;
    }

    function safeReadRtcStatus(laneId: string): RallarRtcStatus | undefined {
        try {
            return config.rallar.rtc.status({ laneId });
        } catch {
            return undefined;
        }
    }

    function safeReadWsStatus() {
        try {
            return config.rallar.ws.status();
        } catch {
            return undefined;
        }
    }

    function safeReadRealtimeHealth(lanes: RallarGameLaneIds) {
        try {
            return config.rallar.realtime.health({
                laneIds: [
                    lanes.input,
                    lanes.intent,
                    lanes.snapshot,
                    lanes.metrics,
                    lanes.replication,
                ],
            });
        } catch {
            return [];
        }
    }

    function emitStatus(status: RallarGameMatchStatus): void {
        for (const handler of statusHandlers) {
            void notifyStatusHandler(handler, status);
        }
    }
}

function resolveDefaultPeerIds(
    roomState: { members: readonly { isOnline: boolean; sessionIds: readonly string[] }[] },
    localPeerId: string | undefined,
): readonly string[] {
    return uniqueSorted([
        ...roomState.members
            .filter((member) => member.isOnline)
            .flatMap((member) => member.sessionIds),
        ...(localPeerId ? [localPeerId] : []),
    ]);
}

function resolveMetadataOwnerAdminAppointmentEligibility(
    context: Readonly<{
        policy: RallarGameDirectorAppointmentPolicy;
        roomState: {
            members: readonly {
                principalId: string;
                role: string;
                status: string;
            }[];
            currentRoom?: {
                members: readonly {
                    principalId: string;
                    role: string;
                    status: string;
                }[];
            };
        };
        localPeerId?: string;
        localPrincipalId?: string;
    }>,
): RallarGameDirectorAppointmentEligibility {
    if (!context.localPeerId || !context.localPrincipalId) {
        return {
            allowed: false,
            status: 'no-local-peer',
            policy: context.policy,
            reason: 'Cannot appoint a director without a local session.',
            localPeerId: context.localPeerId,
            localPrincipalId: context.localPrincipalId,
        };
    }

    const member = context.roomState.members.find((entry) =>
        entry.principalId === context.localPrincipalId
    ) ?? context.roomState.currentRoom?.members.find((entry) =>
        entry.principalId === context.localPrincipalId
    );

    if (!member) {
        return {
            allowed: false,
            status: 'not-ready',
            policy: context.policy,
            reason: 'Cannot confirm local room membership yet.',
            localPeerId: context.localPeerId,
            localPrincipalId: context.localPrincipalId,
        };
    }

    if (member.status !== 'active') {
        return {
            allowed: false,
            status: 'not-authorized',
            policy: context.policy,
            reason: 'Only active room members can appoint the browser director.',
            localPeerId: context.localPeerId,
            localPrincipalId: context.localPrincipalId,
            localRole: member.role,
            localMemberStatus: member.status,
        };
    }

    if (member.role !== 'owner' && member.role !== 'admin') {
        return {
            allowed: false,
            status: 'not-authorized',
            policy: context.policy,
            reason: 'Only active room owners/admins can appoint the browser director.',
            localPeerId: context.localPeerId,
            localPrincipalId: context.localPrincipalId,
            localRole: member.role,
            localMemberStatus: member.status,
        };
    }

    return {
        allowed: true,
        status: 'allowed',
        policy: context.policy,
        localPeerId: context.localPeerId,
        localPrincipalId: context.localPrincipalId,
        localRole: member.role,
        localMemberStatus: member.status,
    };
}

function toHostCapability(
    envelope: RallarGameEnvelope<unknown>,
): RallarGameHostCapability | undefined {
    if (
        typeof envelope.payload !== 'object' ||
        envelope.payload === null ||
        Array.isArray(envelope.payload)
    ) {
        return undefined;
    }

    const payload = envelope.payload as Partial<RallarGameHostCapability>;
    return {
        ...payload,
        peerId: envelope.senderId,
        reportedAtEpochMs: typeof payload.reportedAtEpochMs === 'number'
            ? payload.reportedAtEpochMs
            : envelope.sentAtEpochMs,
    };
}

function combineLaneStatuses(
    lanes: readonly RallarRtcRoomLaneWaitResult[],
): RallarGamePeerReadiness['status'] {
    if (lanes.length === 0) {
        return 'empty';
    }

    const statuses = lanes.map((lane) => lane.status);
    if (statuses.every((status) => status === 'open')) {
        return 'open';
    }

    if (statuses.every((status) => status === 'empty')) {
        return 'empty';
    }

    if (statuses.some((status) => status === 'failed')) {
        return 'failed';
    }

    if (statuses.some((status) => status === 'aborted')) {
        return 'aborted';
    }

    if (statuses.some((status) => status === 'timeout')) {
        return 'timeout';
    }

    if (statuses.some((status) => status === 'not-connected')) {
        return 'not-connected';
    }

    if (statuses.some(isPartiallyReadyLaneStatus)) {
        return 'partial';
    }

    return 'not-ready';
}

function isPartiallyReadyLaneStatus(status: RallarRtcRoomLaneWaitStatus): boolean {
    return status === 'open' || status === 'partial' || status === 'empty';
}

function toRelaySendResult(
    relay: {
        status: 'sent' | 'partial' | 'no-director' | 'not-director' | 'stale-director' | 'failed';
        reason?: string;
    },
): RallarGameSendResult {
    if (relay.status === 'sent') {
        return { status: 'sent', transport: 'director-relay', relay };
    }

    if (relay.status === 'partial') {
        return {
            status: 'partial',
            transport: 'director-relay',
            relay,
            reason: relay.reason,
        };
    }

    if (relay.status === 'no-director' || relay.status === 'stale-director') {
        return {
            status: 'no-director',
            transport: 'director-relay',
            relay,
            reason: relay.reason,
        };
    }

    if (relay.status === 'not-director') {
        return {
            status: 'not-director',
            transport: 'director-relay',
            relay,
            reason: relay.reason,
        };
    }

    return {
        status: 'failed',
        transport: 'director-relay',
        relay,
        reason: relay.reason,
    };
}

function toRealtimeSendResult(
    realtime: readonly RallarRealtimeSendResult[],
): RallarGameSendResult {
    if (realtime.length === 0) {
        return {
            status: 'not-ready',
            transport: 'realtime',
            realtime,
            reason: 'No realtime peers were targeted.',
        };
    }

    const sent = realtime.filter((entry) => entry.result.status === 'sent');
    const queued = realtime.filter((entry) => entry.result.status === 'queued');
    const replaced = realtime.filter((entry) => entry.result.status === 'replaced');
    const successfulCount = sent.length + queued.length + replaced.length;
    if (successfulCount === realtime.length) {
        return { status: 'sent', transport: 'realtime', realtime };
    }

    if (successfulCount > 0) {
        return {
            status: 'partial',
            transport: 'realtime',
            realtime,
            reason: 'Some realtime sends did not succeed.',
        };
    }

    return {
        status: 'not-ready',
        transport: 'realtime',
        realtime,
        reason: 'Realtime lane is not ready.',
    };
}

function toRoomRealtimeSendResult(
    realtime: RallarRoomRealtimeSendResult,
): RallarGameSendResult {
    if (realtime.status === 'sent') {
        return {
            status: 'sent',
            transport: 'realtime',
            realtime: realtime.results,
        };
    }

    if (realtime.status === 'partial') {
        return {
            status: 'partial',
            transport: 'realtime',
            realtime: realtime.results,
            reason: realtime.reason ?? 'Some room realtime sends did not succeed.',
        };
    }

    if (
        realtime.status === 'not-ready' ||
        realtime.status === 'no-targets'
    ) {
        return {
            status: 'not-ready',
            transport: 'realtime',
            realtime: realtime.results,
            reason: realtime.reason ?? 'Room realtime transport is not ready.',
        };
    }

    return {
        status: 'failed',
        transport: 'realtime',
        realtime: realtime.results,
        reason: realtime.reason ?? 'Room realtime send failed.',
    };
}

function noDirectorResult(): RallarGameSendResult {
    return {
        status: 'no-director',
        reason: 'No fresh director is available.',
    };
}

function isSuccessfulMessageStatus(status: RallarMessageSendStatus): boolean {
    return status === 'enqueued' ||
        status === 'sent-immediate' ||
        status === 'skipped' ||
        status === 'duplicate';
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function notifyStatusHandler(
    handler: RallarGameStatusHandler,
    status: RallarGameMatchStatus,
): Promise<void> {
    try {
        await handler(status);
    } catch (error) {
        console.error('Error notifying Rallar Game status handler', error);
    }
}
