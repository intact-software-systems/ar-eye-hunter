import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    rallar,
    type RallarDirectorStatus,
    type RallarRealtimeLaneHealth,
    type RallarRoomSummary,
    type RallarRtcDiagnostics,
    type RallarRtcStatus,
    type RallarWsStatus,
} from '@shared-web/browser/rallar.ts';
import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';
import { readApiConfig, readIceCandidates } from '@shared-web/browser/api-integration.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import {
    createRallarAiFunnyRoomName,
    createRallarAiRoomNameSeed,
    transitionRallarAiResultLifecycle,
} from '@shared/rallar-ai/mod.ts';
import { shouldSendRallarMotionSample } from '@shared/rallar-motion/mod.ts';

import {
    GAME_AI_LANE_ID,
    GAME_AI_TOPIC_ID,
    GAME_COMBAT_LANE_ID,
    GAME_FX_LANE_ID,
    GAME_MOTION_LANE_ID,
    GAME_PROTOCOL,
    GAME_ROOM_NAME,
    type AiDirectorProposal,
    type AiDirectorProposalValue,
    type ArenaEvent,
    type ArenaSnapshot,
    type EyeAttackAccepted,
    type GameRealtimeMessage,
    type PickupAccepted,
    type PickupIntent,
    type PlayerHitAccepted,
    type PlayerHitIntent,
    type PlayerPose,
    type PlayerShot,
    type RemotePlayer,
    type RemoteShot,
    type RtcLaneStatus,
    type ShotAccepted,
} from './types.ts';
import { colorForId } from './color.ts';
import {
    createAiDirectorMockProvider,
    createAiDirectorRequest,
    materializeAiArenaEvent,
    validateAiDirectorProposalValue,
    type AiDirectorContext,
} from './aiDirector.ts';
import {
    applyEyeAttackAccepted,
    applyPickupAccepted,
    applyPlayerHitAccepted,
    arenaRevisionKey,
    hydrateArenaSnapshot,
    resolvePickupIntent,
    resolvePlayerHitIntent,
    toArenaSnapshot,
    upsertPlayerPose,
} from './simulation.ts';
import {
    ARENA_RALLAR_GAME_DATA_CHANNEL_LANES,
    GAME_SNAPSHOT_LANE_ID,
    createArenaRallarGameMatch,
    isArenaAcceptedShotFromSender,
    isArenaPickupIntentFromSender,
    isArenaPoseIntentFromSender,
    isArenaPlayerHitIntentFromSender,
    isArenaShotIntentFromSender,
    type ArenaRallarGameMatchHandle,
} from './rallar-game-match-adapter.ts';
import {
    createDeterministicAvatarProfile,
    validateAvatarProfile,
} from './avatarProfile.ts';

type ConnectionState = 'signed-out' | 'connecting' | 'connected' | 'error';
type AiStatus = 'idle' | 'generating' | 'accepted' | 'error' | 'unavailable';
type DirectorAttemptSource = 'manual' | 'auto';
type DirectorAttemptStatus =
    | 'idle'
    | 'pending'
    | 'succeeded'
    | 'not-elected'
    | 'not-ready'
    | 'failed';

export type DirectorAttemptState = Readonly<{
    source?: DirectorAttemptSource;
    status: DirectorAttemptStatus;
    resultStatus?: string;
    reason?: string;
    startedAtEpochMs?: number;
    finishedAtEpochMs?: number;
    durationMs?: number;
}>;

export type HttpProbeDiagnostics = Readonly<{
    status: 'idle' | 'ok' | 'error';
    durationMs?: number;
    checkedAtEpochMs?: number;
    reason?: string;
    detail?: string;
}>;

export type ArenaTransportDiagnostics = Readonly<{
    refreshedAtEpochMs?: number;
    ws?: RallarWsStatus;
    rtc?: RallarRtcStatus;
    realtimeHealth: readonly RallarRealtimeLaneHealth[];
    rtcDiagnostics?: RallarRtcDiagnostics;
    error?: string;
}>;

export type ArenaHttpDiagnostics = Readonly<{
    apiConfig: HttpProbeDiagnostics;
    ice: HttpProbeDiagnostics;
}>;

export type ArenaDiagnosticsRefreshOptions = Readonly<{
    includeRtcStats?: boolean;
}>;

export type ArenaConnection = Readonly<{
    session?: AuthSession;
    connectionState: ConnectionState;
    error?: string;
    roomId?: string;
    rooms: readonly RallarRoomSummary[];
    directorStatus: RallarDirectorStatus;
    rtcLanes: readonly RtcLaneStatus[];
    directorAttempt: DirectorAttemptState;
    gameDiagnostics?: RallarGameDiagnostics;
    transportDiagnostics: ArenaTransportDiagnostics;
    httpDiagnostics: ArenaHttpDiagnostics;
    aiStatus: AiStatus;
    aiError?: string;
    activeEvent?: ArenaEvent;
    arenaSnapshot?: ArenaSnapshot;
    remoteEvents: readonly ArenaEvent[];
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    remotePlayerHits: readonly PlayerHitAccepted[];
    pickupAcceptances: readonly PickupAccepted[];
    login(username: string, password: string): Promise<void>;
    register(username: string, password: string, displayName?: string): Promise<void>;
    logout(): Promise<void>;
    refreshRooms(): Promise<void>;
    createArenaRoom(): Promise<void>;
    joinRoom(roomId: string): Promise<void>;
    appointSelfAsDirector(): Promise<void>;
    refreshDiagnostics(options?: ArenaDiagnosticsRefreshOptions): Promise<void>;
    requestArenaSync(): Promise<void>;
    sendPose(pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>): void;
    sendShot(
        shot: Omit<PlayerShot, 'sessionId' | 'username' | 'color'>,
        accepted: ShotAccepted,
    ): void;
    sendPlayerHit(intent: PlayerHitIntent): void;
    sendPickupIntent(intent: PickupIntent): void;
    publishArenaSnapshot(snapshot: ArenaSnapshot): void;
}>;

export function useRallarArena(): ArenaConnection {
    const [session, setSession] = useState<AuthSession | undefined>(() =>
        rallar.auth.restore()
    );
    const [connectionState, setConnectionState] = useState<ConnectionState>(
        () => session ? 'connecting' : 'signed-out',
    );
    const [error, setError] = useState<string | undefined>();
    const [roomId, setRoomId] = useState<string | undefined>();
    const [rooms, setRooms] = useState<readonly RallarRoomSummary[]>([]);
    const [directorStatus, setDirectorStatus] = useState<RallarDirectorStatus>(
        () => rallar.director.status(),
    );
    const [directorAttempt, setDirectorAttempt] = useState<DirectorAttemptState>(
        () => ({ status: 'idle' }),
    );
    const [gameDiagnostics, setGameDiagnostics] = useState<RallarGameDiagnostics | undefined>();
    const [transportDiagnostics, setTransportDiagnostics] = useState<ArenaTransportDiagnostics>({
        realtimeHealth: [],
    });
    const [httpDiagnostics, setHttpDiagnostics] = useState<ArenaHttpDiagnostics>({
        apiConfig: { status: 'idle' },
        ice: { status: 'idle' },
    });
    const [rtcLanes, setRtcLanes] = useState<readonly RtcLaneStatus[]>([]);
    const [aiStatus, setAiStatus] = useState<AiStatus>('idle');
    const [aiError, setAiError] = useState<string | undefined>();
    const [arenaSnapshot, setArenaSnapshot] = useState<ArenaSnapshot | undefined>();
    const [remoteEvents, setRemoteEvents] = useState<readonly ArenaEvent[]>([]);
    const [activeEvent, setActiveEvent] = useState<ArenaEvent | undefined>();
    const [remotePlayers, setRemotePlayers] = useState<
        ReadonlyMap<string, RemotePlayer>
    >(new Map());
    const [remoteShots, setRemoteShots] = useState<readonly RemoteShot[]>([]);
    const [remotePlayerHits, setRemotePlayerHits] = useState<readonly PlayerHitAccepted[]>([]);
    const [pickupAcceptances, setPickupAcceptances] = useState<readonly PickupAccepted[]>([]);

    const roomIdRef = useRef<string | undefined>(undefined);
    const sessionRef = useRef<AuthSession | undefined>(session);
    const directorStatusRef = useRef<RallarDirectorStatus>(directorStatus);
    const directorAttemptRef = useRef<DirectorAttemptState>(directorAttempt);
    const arenaMatchRef = useRef<ArenaRallarGameMatchHandle | undefined>(undefined);
    const remotePlayersRef = useRef<ReadonlyMap<string, RemotePlayer>>(remotePlayers);
    const arenaSnapshotRef = useRef<ArenaSnapshot | undefined>(arenaSnapshot);
    const poseSendBudget = useRef(0);

    const resetForSignedOutAuth = useCallback(() => {
        arenaMatchRef.current?.stop();
        arenaMatchRef.current = undefined;
        setSession(undefined);
        setRoomId(undefined);
        setRooms([]);
        setDirectorStatus(rallar.director.status());
        setDirectorAttempt({ status: 'idle' });
        setGameDiagnostics(undefined);
        setTransportDiagnostics({ realtimeHealth: [] });
        setHttpDiagnostics({
            apiConfig: { status: 'idle' },
            ice: { status: 'idle' },
        });
        setRtcLanes([]);
        setAiStatus('idle');
        setAiError(undefined);
        setArenaSnapshot(undefined);
        setRemoteEvents([]);
        setActiveEvent(undefined);
        setRemotePlayers(new Map());
        setRemoteShots([]);
        setRemotePlayerHits([]);
        setPickupAcceptances([]);
        setError(undefined);
        setConnectionState('signed-out');
    }, []);

    useEffect(() => {
        return rallar.auth.onChange((state) => {
            if (state.authenticated) {
                setSession(state.session);
                return;
            }

            resetForSignedOutAuth();
        }, { emitCurrent: true });
    }, [resetForSignedOutAuth]);

    useEffect(() => {
        sessionRef.current = session;
    }, [session]);

    useEffect(() => {
        roomIdRef.current = roomId;
    }, [roomId]);

    useEffect(() => {
        directorStatusRef.current = directorStatus;
    }, [directorStatus]);

    useEffect(() => {
        directorAttemptRef.current = directorAttempt;
    }, [directorAttempt]);

    useEffect(() => {
        remotePlayersRef.current = remotePlayers;
    }, [remotePlayers]);

    useEffect(() => {
        arenaSnapshotRef.current = arenaSnapshot;
    }, [arenaSnapshot]);

    const acceptPlayerHit = useCallback((accepted: PlayerHitAccepted) => {
        setRemotePlayerHits((previous) => [
            ...previous.filter((item) =>
                item.revision !== accepted.revision ||
                item.target.sessionId !== accepted.target.sessionId ||
                item.intent.shot.seq !== accepted.intent.shot.seq
            ).slice(-24),
            accepted,
        ]);
        setArenaSnapshot((previous) => {
            if (!previous) {
                return previous;
            }
            const next = toArenaSnapshot(
                applyPlayerHitAccepted(hydrateArenaSnapshot(previous), accepted),
                previous.roomId ?? roomIdRef.current,
                Date.now(),
            );
            arenaSnapshotRef.current = next;
            setActiveEvent(next.activeEvent);
            setRemoteEvents(next.events);
            return next;
        });
    }, []);

    const acceptPickup = useCallback((accepted: PickupAccepted) => {
        setPickupAcceptances((previous) => [
            ...previous.filter((item) =>
                item.revision !== accepted.revision ||
                item.pickup.id !== accepted.pickup.id
            ).slice(-24),
            accepted,
        ]);
        setArenaSnapshot((previous) => {
            if (!previous) {
                return previous;
            }
            const next = toArenaSnapshot(
                applyPickupAccepted(hydrateArenaSnapshot(previous), accepted),
                previous.roomId ?? roomIdRef.current,
                Date.now(),
            );
            arenaSnapshotRef.current = next;
            setActiveEvent(next.activeEvent);
            setRemoteEvents(next.events);
            return next;
        });
    }, []);

    const acceptEyeAttack = useCallback((accepted: EyeAttackAccepted) => {
        setArenaSnapshot((previous) => {
            if (!previous) {
                return previous;
            }
            const next = toArenaSnapshot(
                applyEyeAttackAccepted(hydrateArenaSnapshot(previous), accepted),
                previous.roomId ?? roomIdRef.current,
                Date.now(),
            );
            arenaSnapshotRef.current = next;
            setActiveEvent(next.activeEvent);
            setRemoteEvents(next.events);
            return next;
        });
    }, []);

    const acceptDirectorOutput = useCallback((
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;
        if (message.kind === 'director-player-state') {
            const pose = withValidatedAvatarProfile(message.pose);
            if (pose.sessionId === currentSessionId) {
                return;
            }

            setRemotePlayers((previous) => {
                const next = new Map(previous);
                const existing = next.get(pose.sessionId);
                if (existing && existing.pose.seq > pose.seq) {
                    return previous;
                }

                next.set(pose.sessionId, {
                    pose,
                    lastSeenEpochMs: Date.now(),
                });
                return next;
            });
            setArenaSnapshot((previous) => {
                if (!previous) {
                    return previous;
                }
                const next = toArenaSnapshot(
                    upsertPlayerPose(hydrateArenaSnapshot(previous), pose, Date.now()),
                    previous.roomId ?? roomIdRef.current,
                    Date.now(),
                );
                arenaSnapshotRef.current = next;
                return next;
            });
            return;
        }

        if (message.kind === 'director-shot-event') {
            const shot = message.shot;
            if (shot.sessionId === currentSessionId) {
                return;
            }

            setRemoteShots((previous) => [
                ...previous.slice(-24),
                {
                    id: `${shot.sessionId}:${shot.seq}`,
                    shot,
                    receivedAtEpochMs: Date.now(),
                },
            ]);
            return;
        }

        if (message.kind === 'director-shot-accepted') {
            const accepted = message.accepted;
            if (accepted.shot.sessionId === currentSessionId) {
                return;
            }
            setRemoteShots((previous) => [
                ...previous.slice(-32),
                {
                    id: `${accepted.shot.sessionId}:${accepted.shot.seq}:${accepted.revision}`,
                    shot: accepted.shot,
                    accepted,
                    receivedAtEpochMs: Date.now(),
                },
            ]);
            return;
        }

        if (message.kind === 'director-player-hit-accepted') {
            acceptPlayerHit(message.accepted);
            return;
        }

        if (message.kind === 'director-pickup-accepted') {
            acceptPickup(message.accepted);
            return;
        }

        if (message.kind === 'director-eye-attack-accepted') {
            acceptEyeAttack(message.accepted);
            return;
        }

        if (message.kind === 'arena-event') {
            setRemoteEvents((previous) => [
                ...previous.filter((event) => event.id !== message.event.id).slice(-12),
                message.event,
            ]);
            setActiveEvent(message.event);
            return;
        }

        if (message.kind === 'director-arena-snapshot') {
            setArenaSnapshot(message.snapshot);
            setActiveEvent(message.snapshot.activeEvent);
            setRemoteEvents(message.snapshot.events);
            return;
        }

        if (message.kind === 'director-state-snapshot') {
            setRemotePlayers(new Map(
                message.players
                    .filter((pose) => pose.sessionId !== currentSessionId)
                    .map((pose) => [
                        pose.sessionId,
                        {
                            pose: withValidatedAvatarProfile(pose),
                            lastSeenEpochMs: Date.now(),
                        },
                    ]),
            ));
        }
    }, [acceptEyeAttack, acceptPickup, acceptPlayerHit]);

    const acceptMotionMessage = useCallback((
        peerId: string,
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;
        if (message.kind === 'player-pose') {
            const pose = withValidatedAvatarProfile(message.pose);
            if (pose.sessionId === currentSessionId || pose.sessionId !== peerId) {
                return;
            }

            setRemotePlayers((previous) => {
                const next = new Map(previous);
                const existing = next.get(pose.sessionId);
                if (existing && existing.pose.seq > pose.seq) {
                    return previous;
                }

                next.set(pose.sessionId, {
                    pose,
                    lastSeenEpochMs: Date.now(),
                });
                return next;
            });
            return;
        }

        return;
    }, [acceptPickup, acceptPlayerHit]);

    const acceptRealtimeMessage = useCallback((
        peerId: string,
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;

        if (message.kind === 'player-shot') {
            const shot = message.shot;
            if (shot.sessionId === currentSessionId || shot.sessionId !== peerId) {
                return;
            }

            setRemoteShots((previous) => [
                ...previous.slice(-24),
                {
                    id: `${shot.sessionId}:${shot.seq}`,
                    shot,
                    receivedAtEpochMs: Date.now(),
                },
            ]);
            return;
        }

        if (message.kind === 'director-shot-accepted') {
            const accepted = message.accepted;
            if (accepted.shot.sessionId === currentSessionId) {
                return;
            }

            setRemoteShots((previous) => [
                ...previous.slice(-32),
                {
                    id: `${accepted.shot.sessionId}:${accepted.shot.seq}:${accepted.revision}`,
                    shot: accepted.shot,
                    accepted,
                    receivedAtEpochMs: Date.now(),
                },
            ]);
            return;
        }

        if (message.kind === 'director-player-hit-accepted') {
            acceptPlayerHit(message.accepted);
            return;
        }

        if (message.kind === 'director-pickup-accepted') {
            acceptPickup(message.accepted);
            return;
        }

        if (message.kind === 'director-eye-attack-accepted') {
            acceptEyeAttack(message.accepted);
            return;
        }

        if (message.kind === 'arena-event') {
            setRemoteEvents((previous) => [
                ...previous.filter((event) => event.id !== message.event.id).slice(-12),
                message.event,
            ]);
            setActiveEvent(message.event);
            return;
        }

        if (message.kind === 'director-arena-snapshot') {
            setArenaSnapshot(message.snapshot);
            setActiveEvent(message.snapshot.activeEvent);
            setRemoteEvents(message.snapshot.events);
        }
    }, [acceptEyeAttack, acceptPickup, acceptPlayerHit]);

    const connect = useCallback(async () => {
        setConnectionState('connecting');
        setError(undefined);

        try {
            const startup = await rallar.start({
                refreshRooms: true,
                dataChannelLanes: ARENA_RALLAR_GAME_DATA_CHANNEL_LANES,
            });
            if (!startup.session || !startup.connected) {
                setConnectionState('signed-out');
                setSession(undefined);
                return;
            }

            const roomState = startup.roomState ?? rallar.rooms.state();
            setSession(startup.session);
            setRooms(roomState.rooms);
            setRoomId(roomState.currentRoomId);
            setConnectionState('connected');
        } catch (err) {
            setConnectionState('error');
            setError(toErrorMessage(err));
        }
    }, []);

    useEffect(() => {
        void connect();
    }, [connect]);

    useEffect(() => {
        if (connectionState !== 'connected') {
            return;
        }

        const subscriptions = rallar.subscriptions()
            .add(
                rallar.realtime.onJson<GameRealtimeMessage>(
                    GAME_MOTION_LANE_ID,
                    (message) => {
                        acceptMotionMessage(message.peerId, message.data);
                    },
                ),
            )
            .add(
                rallar.realtime.onJson<GameRealtimeMessage>(
                    GAME_COMBAT_LANE_ID,
                    (message) => {
                        acceptRealtimeMessage(message.peerId, message.data);
                    },
                ),
            )
            .add(
                rallar.realtime.onJson<GameRealtimeMessage>(
                    GAME_AI_LANE_ID,
                    (message) => {
                        acceptRealtimeMessage(message.peerId, message.data);
                    },
                ),
            )
            .add(
                rallar.rooms.onChange((state) => {
                    setRooms(state.rooms);
                    setRoomId(state.currentRoomId);
                    setDirectorStatus(
                        rallar.director.status(state.currentRoomRef),
                    );
                }),
            )
            .add(
                rallar.director.onStatus((status) => {
                    setDirectorStatus(status);
                }),
            );

        const directorPoll = window.setInterval(() => {
            const currentRoomId = roomIdRef.current;
            setDirectorStatus(rallar.director.status(currentRoomId));
        }, 1_000);
        subscriptions.add(() => window.clearInterval(directorPoll));

        const prune = window.setInterval(() => {
            const cutoff = Date.now() - 10_000;
            setRemotePlayers((previous) => {
                const next = new Map(
                    [...previous].filter(([, remote]) =>
                        remote.lastSeenEpochMs >= cutoff
                    ),
                );
                return next.size === previous.size ? previous : next;
            });
        }, 2_000);
        subscriptions.add(() => window.clearInterval(prune));

        return () => subscriptions.unsubscribe();
    }, [acceptMotionMessage, acceptRealtimeMessage, connectionState]);

    useEffect(() => {
        if (connectionState !== 'connected' || !roomId) {
            setRtcLanes([]);
            return;
        }

        let cancelled = false;
        const laneIds = [
            GAME_MOTION_LANE_ID,
            GAME_COMBAT_LANE_ID,
            GAME_SNAPSHOT_LANE_ID,
            GAME_FX_LANE_ID,
            GAME_AI_LANE_ID,
        ] as const;

        const refresh = async () => {
            const next: RtcLaneStatus[] = [];
            for (const laneId of laneIds) {
                try {
                    const readiness = await rallar.rtc.waitForRoomLane(roomId, laneId, {
                        connect: true,
                        timeoutMs: 650,
                    });
                    next.push({
                        laneId,
                        status: readiness.status === 'open' || readiness.status === 'partial'
                            ? readiness.status
                            : readiness.ready.length > 0
                            ? 'partial'
                            : 'closed',
                        readyPeers: readiness.ready.length,
                        notReadyPeers: readiness.notReady.length,
                    });
                } catch {
                    next.push({
                        laneId,
                        status: 'unavailable',
                        readyPeers: 0,
                        notReadyPeers: 0,
                    });
                }
            }
            if (!cancelled) {
                setRtcLanes(next);
            }
        };

        void refresh();
        const interval = window.setInterval(() => void refresh(), 2_500);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [connectionState, roomId]);

    const attemptDirectorAppointment = useCallback(async (
        source: DirectorAttemptSource,
    ) => {
        const currentRoomId = roomIdRef.current;
        const startedAtEpochMs = Date.now();
        setDirectorAttempt({
            source,
            status: 'pending',
            startedAtEpochMs,
        });

        if (!currentRoomId) {
            setDirectorAttempt({
                source,
                status: 'failed',
                reason: 'Cannot appoint a director without an arena room.',
                startedAtEpochMs,
                finishedAtEpochMs: Date.now(),
                durationMs: Date.now() - startedAtEpochMs,
            });
            return;
        }

        try {
            const match = arenaMatchRef.current;
            if (!match) {
                setDirectorStatus(rallar.director.status(currentRoomId));
                setDirectorAttempt(toDirectorAttemptState(
                    source,
                    startedAtEpochMs,
                    'failed',
                    'Rallar Game match is not ready yet.',
                ));
                return;
            }

            await match.reportCapability();
            const result = await match.appointIfElected();
            if (result.directorStatus) {
                setDirectorStatus(result.directorStatus);
            } else {
                setDirectorStatus(rallar.director.status(currentRoomId));
            }
            setGameDiagnostics(match.diagnostics());
            setDirectorAttempt(toDirectorAttemptState(
                source,
                startedAtEpochMs,
                result.status,
                result.reason,
            ));
        } catch (err) {
            setDirectorStatus(rallar.director.status(currentRoomId));
            setDirectorAttempt(toDirectorAttemptState(
                source,
                startedAtEpochMs,
                'failed',
                toErrorMessage(err),
            ));
        }
    }, []);

    useEffect(() => {
        arenaMatchRef.current?.stop();
        arenaMatchRef.current = undefined;

        if (connectionState !== 'connected' || !roomId) {
            return;
        }

        const match = createArenaRallarGameMatch({
            rallar,
            roomId,
            readSnapshot: () => arenaSnapshotRef.current,
            onPresence: (envelope) => {
                acceptMotionMessage(envelope.senderId, envelope.payload);
            },
            onInput: async (envelope) => {
                const data = envelope.payload;
                if (!isArenaPoseIntentFromSender(data, envelope.senderId)) {
                    return;
                }
                const pose = withValidatedAvatarProfile(data.pose);

                const previous = arenaSnapshotRef.current;
                if (previous) {
                    const next = toArenaSnapshot(
                        upsertPlayerPose(hydrateArenaSnapshot(previous), pose, Date.now()),
                        previous.roomId ?? roomIdRef.current,
                        Date.now(),
                    );
                    arenaSnapshotRef.current = next;
                    setArenaSnapshot(next);
                }

                await arenaMatchRef.current?.publishEvent({
                    protocol: GAME_PROTOCOL,
                    kind: 'director-player-state',
                    pose,
                });
            },
            onIntent: async (envelope) => {
                const data = envelope.payload;
                if (isArenaShotIntentFromSender(data, envelope.senderId)) {
                    await arenaMatchRef.current?.publishEvent({
                        protocol: GAME_PROTOCOL,
                        kind: 'director-shot-event',
                        shot: data.shot,
                    });
                    return;
                }

                if (isArenaPlayerHitIntentFromSender(data, envelope.senderId)) {
                    const previous = arenaSnapshotRef.current;
                    if (!previous) {
                        return;
                    }
                    const result = resolvePlayerHitIntent(
                        hydrateArenaSnapshot(previous),
                        data.intent,
                        Date.now(),
                    );
                    if (!result.accepted) {
                        return;
                    }
                    const snapshot = toArenaSnapshot(
                        result.state,
                        previous.roomId ?? roomIdRef.current,
                        Date.now(),
                    );
                    arenaSnapshotRef.current = snapshot;
                    setArenaSnapshot(snapshot);
                    acceptPlayerHit(result.acceptedHit);
                    await arenaMatchRef.current?.publishEvent({
                        protocol: GAME_PROTOCOL,
                        kind: 'director-player-hit-accepted',
                        accepted: result.acceptedHit,
                    });
                    await arenaMatchRef.current?.publishSnapshot(snapshot, {
                        reliable: false,
                    });
                    return;
                }

                if (isArenaPickupIntentFromSender(data, envelope.senderId)) {
                    const previous = arenaSnapshotRef.current;
                    if (!previous) {
                        return;
                    }
                    const result = resolvePickupIntent(
                        hydrateArenaSnapshot(previous),
                        data.intent,
                        Date.now(),
                    );
                    if (!result.accepted) {
                        return;
                    }
                    const snapshot = toArenaSnapshot(
                        result.state,
                        previous.roomId ?? roomIdRef.current,
                        Date.now(),
                    );
                    arenaSnapshotRef.current = snapshot;
                    setArenaSnapshot(snapshot);
                    acceptPickup(result.acceptedPickup);
                    await arenaMatchRef.current?.publishEvent({
                        protocol: GAME_PROTOCOL,
                        kind: 'director-pickup-accepted',
                        accepted: result.acceptedPickup,
                    });
                    await arenaMatchRef.current?.publishSnapshot(snapshot, {
                        reliable: false,
                    });
                    return;
                }

                if (isArenaAcceptedShotFromSender(data, envelope.senderId)) {
                    await arenaMatchRef.current?.publishEvent(data);
                }
            },
            onEvent: (envelope) => {
                acceptDirectorOutput(envelope.payload);
            },
            onSnapshot: (envelope) => {
                setArenaSnapshot(envelope.payload);
                setActiveEvent(envelope.payload.activeEvent);
                setRemoteEvents(envelope.payload.events);
            },
            onSyncRequest: async () => {
                const snapshot = arenaSnapshotRef.current;
                if (!snapshot) {
                    return;
                }
                await arenaMatchRef.current?.publishSnapshot(snapshot, {
                    reliable: true,
                });
            },
        });

        arenaMatchRef.current = match;
        const unsubscribeStatus = match.onStatus(() => {
            setDirectorStatus(rallar.director.status(roomId));
            setGameDiagnostics(match.diagnostics());
        });

        let cancelled = false;
        void match.start()
            .then(async () => {
                if (cancelled || arenaMatchRef.current !== match) {
                    return;
                }
                setGameDiagnostics(match.diagnostics());
                await attemptDirectorAppointment('auto');
                if (cancelled || arenaMatchRef.current !== match) {
                    return;
                }
                await match.waitForReadyLanes({
                    laneIds: [
                        GAME_MOTION_LANE_ID,
                        GAME_COMBAT_LANE_ID,
                        GAME_SNAPSHOT_LANE_ID,
                        GAME_FX_LANE_ID,
                        GAME_AI_LANE_ID,
                    ],
                    timeoutMs: 650,
                });
                setGameDiagnostics(match.diagnostics());
                await match.requestSync({ reason: 'arena-join' });
            })
            .catch((err) => {
                setError(toErrorMessage(err));
            });

        return () => {
            cancelled = true;
            unsubscribeStatus();
            match.stop();
            if (arenaMatchRef.current === match) {
                arenaMatchRef.current = undefined;
            }
        };
    }, [
        acceptDirectorOutput,
        acceptMotionMessage,
        acceptPickup,
        acceptPlayerHit,
        attemptDirectorAppointment,
        connectionState,
        roomId,
    ]);

    useEffect(() => {
        if (
            connectionState !== 'connected' ||
            !roomId ||
            !directorStatus.isDirector ||
            !directorStatus.isFresh
        ) {
            setAiStatus((current) => current === 'generating' ? 'idle' : current);
            return;
        }

        let cancelled = false;
        const provider = createAiDirectorMockProvider();
        const ai = createRallarBrowserAi({
            rallar,
            provider,
            policy: {
                mode: 'browser-only',
                staleResultMode: 'reject',
                timeoutMs: 3_000,
            },
            readCurrentStateRevision: () => {
                const snapshot = arenaSnapshotRef.current;
                return snapshot
                    ? arenaRevisionKey(hydrateArenaSnapshot(snapshot))
                    : undefined;
            },
        });

        const generate = async () => {
            const snapshot = arenaSnapshotRef.current;
            if (!snapshot || cancelled) {
                setAiStatus('unavailable');
                return;
            }

            const state = hydrateArenaSnapshot(snapshot);
            setAiStatus('generating');
            setAiError(undefined);
            try {
                const draft = await ai.generateJson<AiDirectorProposalValue, AiDirectorContext>(
                    createAiDirectorRequest(state, roomId),
                );
                const validation = validateAiDirectorProposalValue(draft.value, snapshot);
                if (!validation.ok) {
                    setAiStatus('error');
                    setAiError(validation.reason);
                    return;
                }
                const proposed = transitionRallarAiResultLifecycle({
                    ...draft,
                    value: validation.value,
                }, 'proposed');
                const accepted = transitionRallarAiResultLifecycle(proposed, 'accepted');
                const proposal: AiDirectorProposal = {
                    generationId: accepted.generationId,
                    dedupeKey: accepted.dedupeKey ?? accepted.generationId,
                    baseStateRevision: accepted.baseStateRevision ?? arenaRevisionKey(state),
                    value: accepted.value,
                    accepted: true,
                    sentAtEpochMs: Date.now(),
                };
                const event = materializeAiArenaEvent(
                    proposal,
                    snapshot.revision + 1,
                    Date.now(),
                );

                await ai.broadcastJson({
                    result: accepted,
                    transport: 'realtime',
                    laneId: GAME_AI_LANE_ID,
                    roomId,
                    topicId: GAME_AI_TOPIC_ID,
                });
                await rallar.data.open<AiDirectorProposal>('ar-eye-hunter-ai-replay', {
                    scope: 'session',
                    durability: 'write-behind',
                    schemaVersion: 1,
                }).then((store) => store.set(proposal.dedupeKey, proposal));

                setRemoteEvents((previous) => [
                    ...previous.filter((item) => item.id !== event.id).slice(-12),
                    event,
                ]);
                setActiveEvent(event);
                setAiStatus('accepted');
                void arenaMatchRef.current?.publishEvent({
                    protocol: GAME_PROTOCOL,
                    kind: 'arena-event',
                    event,
                });
            } catch (err) {
                if (!cancelled) {
                    setAiStatus('error');
                    setAiError(toErrorMessage(err));
                }
            }
        };

        const initial = window.setTimeout(() => void generate(), 4_500);
        const interval = window.setInterval(() => void generate(), 10_500);
        return () => {
            cancelled = true;
            window.clearTimeout(initial);
            window.clearInterval(interval);
        };
    }, [
        connectionState,
        directorStatus.isDirector,
        directorStatus.isFresh,
        roomId,
    ]);

    const refreshRooms = useCallback(async () => {
        const state = await rallar.rooms.refresh();
        setRooms(state.rooms);
        setRoomId(state.currentRoomId);
    }, []);

    const login = useCallback(async (username: string, password: string) => {
        setConnectionState('connecting');
        setError(undefined);
        try {
            const response = await rallar.auth.login({ username, password });
            setSession(response);
            await connect();
        } catch (err) {
            setConnectionState('error');
            setError(toErrorMessage(err));
        }
    }, [connect]);

    const register = useCallback(async (
        username: string,
        password: string,
        displayName?: string,
    ) => {
        setConnectionState('connecting');
        setError(undefined);
        try {
            const response = await rallar.auth.registerAndLogin({
                username,
                password,
                displayName: displayName || username,
            });
            setSession(response);
            await connect();
        } catch (err) {
            setConnectionState('error');
            setError(toErrorMessage(err));
        }
    }, [connect]);

    const logout = useCallback(async () => {
        try {
            await rallar.auth.logout();
        } catch {
            // Manual logout is best-effort; the facade performs local cleanup first.
        } finally {
            resetForSignedOutAuth();
        }
    }, [resetForSignedOutAuth]);

    const createArenaRoom = useCallback(async () => {
        const displayName = createRallarAiFunnyRoomName({
            baseName: GAME_ROOM_NAME,
            theme: 'ar-eye-hunter',
            seed: createRallarAiRoomNameSeed('ar-eye-hunter'),
            existingNames: rooms.map((room) => room.name),
        });
        const snapshot = await rallar.rooms.create({
            displayName,
        });
        setRoomId(snapshot.group.groupId);
        await refreshRooms();
    }, [refreshRooms, rooms]);

    const joinRoom = useCallback(async (nextRoomId: string) => {
        const snapshot = await rallar.rooms.join(nextRoomId);
        setRoomId(snapshot.group.groupId);
        await refreshRooms();
    }, [refreshRooms]);

    const appointSelfAsDirector = useCallback(async () => {
        await attemptDirectorAppointment('manual');
    }, [attemptDirectorAppointment]);

    useEffect(() => {
        if (connectionState !== 'connected' || !roomId) {
            return;
        }
        const current = directorStatusRef.current;
        if (current.appointment) {
            return;
        }
        const timer = window.setTimeout(() => {
            const latest = directorStatusRef.current;
            const attempt = directorAttemptRef.current;
            if (
                !latest.appointment &&
                roomIdRef.current &&
                attempt.status !== 'pending' &&
                attempt.source !== 'auto'
            ) {
                void attemptDirectorAppointment('auto');
            }
        }, 750);
        return () => window.clearTimeout(timer);
    }, [attemptDirectorAppointment, connectionState, roomId]);

    const refreshDiagnostics = useCallback(async (
        options: ArenaDiagnosticsRefreshOptions = {},
    ) => {
        const refreshedAtEpochMs = Date.now();
        try {
            const match = arenaMatchRef.current;
            if (match) {
                setGameDiagnostics(match.diagnostics());
            }

            const rtcStatus = rallar.rtc.status({ laneId: GAME_MOTION_LANE_ID });
            const nextTransport: ArenaTransportDiagnostics = {
                refreshedAtEpochMs,
                ws: rallar.ws.status(),
                rtc: rtcStatus,
                realtimeHealth: rallar.realtime.health({
                    laneIds: [
                        GAME_MOTION_LANE_ID,
                        GAME_COMBAT_LANE_ID,
                        GAME_SNAPSHOT_LANE_ID,
                        GAME_FX_LANE_ID,
                        GAME_AI_LANE_ID,
                    ],
                }),
                rtcDiagnostics: options.includeRtcStats
                    ? await rallar.rtc.diagnostics({
                        laneIds: [
                            GAME_MOTION_LANE_ID,
                            GAME_COMBAT_LANE_ID,
                            GAME_SNAPSHOT_LANE_ID,
                            GAME_FX_LANE_ID,
                            GAME_AI_LANE_ID,
                        ],
                    })
                    : transportDiagnostics.rtcDiagnostics,
            };
            setTransportDiagnostics(nextTransport);
        } catch (err) {
            setTransportDiagnostics((previous) => ({
                ...previous,
                refreshedAtEpochMs,
                error: toErrorMessage(err),
            }));
        }

        const [apiConfig, ice] = await Promise.all([
            probeHttp((signal) => readApiConfig({ signal })),
            probeHttp((signal) => readIceCandidates({
                signal,
                authSession: sessionRef.current ?? null,
            })),
        ]);
        setHttpDiagnostics({
            apiConfig,
            ice,
        });
    }, [transportDiagnostics.rtcDiagnostics]);

    const requestArenaSync = useCallback(async () => {
        await arenaMatchRef.current?.requestSync({
            reason: 'diagnostics-drawer',
            requestedAtEpochMs: Date.now(),
        });
        setGameDiagnostics(arenaMatchRef.current?.diagnostics());
    }, []);

    const sendPose = useCallback((
        pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>,
    ) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId) {
            return;
        }

        const now = Date.now();
        if (!shouldSendRallarMotionSample(now, poseSendBudget.current, 50)) {
            return;
        }
        poseSendBudget.current = now + 50;

        const fullPose: PlayerPose = {
            ...pose,
            sessionId: currentSession.sessionId,
            username: currentSession.username,
            color: colorForId(currentSession.sessionId),
            avatarProfile: createDeterministicAvatarProfile(
                currentSession.sessionId,
                currentSession.username,
            ),
        };
        const input: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'player-pose-intent',
            pose: fullPose,
        };
        const presence: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'player-pose',
            pose: fullPose,
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            void match.sendInput(input);
        }

        void match?.sendPresence(presence, {
            laneId: GAME_MOTION_LANE_ID,
            key: `pose:${currentSession.sessionId}`,
            maxAgeMs: 250,
            openTimeoutMs: 1500,
        });
    }, []);

    const sendShot = useCallback((
        shot: Omit<PlayerShot, 'sessionId' | 'username' | 'color'>,
        accepted: ShotAccepted,
    ) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId) {
            return;
        }

        const fullShot: PlayerShot = {
            ...shot,
            sessionId: currentSession.sessionId,
            username: currentSession.username,
            color: colorForId(currentSession.sessionId),
        };
        const fullAccepted: ShotAccepted = {
            ...accepted,
            shot: fullShot,
        };
        const acceptedMessage: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'director-shot-accepted',
            accepted: fullAccepted,
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            if (match.status().directorPeerId === currentSession.sessionId) {
                void match.publishEvent(acceptedMessage);
            } else {
                void match.sendIntent(acceptedMessage);
            }
            return;
        }

        const currentDirector = directorStatusRef.current;
        if (currentDirector.appointment && !currentDirector.isFresh) {
            return;
        }

        void rallar.realtime.sendJson<GameRealtimeMessage>({
            laneId: GAME_COMBAT_LANE_ID,
            roomId: currentRoomId,
            data: {
                protocol: GAME_PROTOCOL,
                kind: 'director-shot-accepted',
                accepted: fullAccepted,
            },
            maxAgeMs: 1000,
            openTimeoutMs: 1500,
        });
    }, []);

    const sendPlayerHit = useCallback((intent: PlayerHitIntent) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId) {
            return;
        }

        const fullIntent: PlayerHitIntent = {
            ...intent,
            shot: {
                ...intent.shot,
                sessionId: currentSession.sessionId,
                username: currentSession.username,
                color: colorForId(currentSession.sessionId),
            },
            sentAtEpochMs: Date.now(),
        };
        const message: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'player-hit-intent',
            intent: fullIntent,
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            if (match.status().directorPeerId === currentSession.sessionId) {
                const previous = arenaSnapshotRef.current;
                if (!previous) {
                    return;
                }
                const result = resolvePlayerHitIntent(
                    hydrateArenaSnapshot(previous),
                    fullIntent,
                    Date.now(),
                );
                if (!result.accepted) {
                    return;
                }
                const snapshot = toArenaSnapshot(result.state, previous.roomId ?? currentRoomId, Date.now());
                arenaSnapshotRef.current = snapshot;
                setArenaSnapshot(snapshot);
                acceptPlayerHit(result.acceptedHit);
                void match.publishEvent({
                    protocol: GAME_PROTOCOL,
                    kind: 'director-player-hit-accepted',
                    accepted: result.acceptedHit,
                });
                void match.publishSnapshot(snapshot, { reliable: false });
            } else {
                void match.sendIntent(message);
            }
            return;
        }

        const currentDirector = directorStatusRef.current;
        if (currentDirector.appointment && !currentDirector.isFresh) {
            return;
        }

        void rallar.realtime.sendJson<GameRealtimeMessage>({
            laneId: GAME_COMBAT_LANE_ID,
            roomId: currentRoomId,
            data: message,
            maxAgeMs: 650,
            openTimeoutMs: 1500,
        });
    }, [acceptPlayerHit]);

    const sendPickupIntent = useCallback((intent: PickupIntent) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId) {
            return;
        }

        const fullIntent: PickupIntent = {
            ...intent,
            sessionId: currentSession.sessionId,
            sentAtEpochMs: Date.now(),
        };
        const message: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'pickup-intent',
            intent: fullIntent,
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            if (match.status().directorPeerId === currentSession.sessionId) {
                const previous = arenaSnapshotRef.current;
                if (!previous) {
                    return;
                }
                const result = resolvePickupIntent(
                    hydrateArenaSnapshot(previous),
                    fullIntent,
                    Date.now(),
                );
                if (!result.accepted) {
                    return;
                }
                const snapshot = toArenaSnapshot(result.state, previous.roomId ?? currentRoomId, Date.now());
                arenaSnapshotRef.current = snapshot;
                setArenaSnapshot(snapshot);
                acceptPickup(result.acceptedPickup);
                void match.publishEvent({
                    protocol: GAME_PROTOCOL,
                    kind: 'director-pickup-accepted',
                    accepted: result.acceptedPickup,
                });
                void match.publishSnapshot(snapshot, { reliable: false });
            } else {
                void match.sendIntent(message);
            }
            return;
        }

        const currentDirector = directorStatusRef.current;
        if (currentDirector.appointment && !currentDirector.isFresh) {
            return;
        }

        void rallar.realtime.sendJson<GameRealtimeMessage>({
            laneId: GAME_COMBAT_LANE_ID,
            roomId: currentRoomId,
            data: message,
            key: `pickup:${fullIntent.pickupId}`,
            maxAgeMs: 650,
            openTimeoutMs: 1500,
        });
    }, [acceptPickup]);

    const publishArenaSnapshot = useCallback((snapshot: ArenaSnapshot) => {
        setArenaSnapshot((previous) =>
            !previous || snapshot.revision >= previous.revision ? snapshot : previous
        );
        arenaSnapshotRef.current = snapshot;

        const currentRoomId = roomIdRef.current;
        const currentDirector = directorStatusRef.current;
        if (!currentRoomId || !currentDirector.isDirector || !currentDirector.isFresh) {
            return;
        }

        void arenaMatchRef.current?.publishSnapshot(snapshot, {
            reliable: true,
        });
    }, []);

    return useMemo(() => ({
        session,
        connectionState,
        error,
        roomId,
        rooms,
        directorStatus,
        rtcLanes,
        directorAttempt,
        gameDiagnostics,
        transportDiagnostics,
        httpDiagnostics,
        aiStatus,
        aiError,
        activeEvent,
        arenaSnapshot,
        remoteEvents,
        remotePlayers,
        remoteShots,
        remotePlayerHits,
        pickupAcceptances,
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        appointSelfAsDirector,
        refreshDiagnostics,
        requestArenaSync,
        sendPose,
        sendShot,
        sendPlayerHit,
        sendPickupIntent,
        publishArenaSnapshot,
    }), [
        session,
        connectionState,
        error,
        roomId,
        rooms,
        directorStatus,
        rtcLanes,
        directorAttempt,
        gameDiagnostics,
        transportDiagnostics,
        httpDiagnostics,
        aiStatus,
        aiError,
        activeEvent,
        arenaSnapshot,
        remoteEvents,
        remotePlayers,
        remoteShots,
        remotePlayerHits,
        pickupAcceptances,
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        appointSelfAsDirector,
        refreshDiagnostics,
        requestArenaSync,
        sendPose,
        sendShot,
        sendPlayerHit,
        sendPickupIntent,
        publishArenaSnapshot,
    ]);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toDirectorAttemptState(
    source: DirectorAttemptSource,
    startedAtEpochMs: number,
    resultStatus: string,
    reason?: string,
): DirectorAttemptState {
    const finishedAtEpochMs = Date.now();
    return {
        source,
        status: toDirectorAttemptStatus(resultStatus),
        resultStatus,
        reason,
        startedAtEpochMs,
        finishedAtEpochMs,
        durationMs: finishedAtEpochMs - startedAtEpochMs,
    };
}

function toDirectorAttemptStatus(resultStatus: string): DirectorAttemptStatus {
    switch (resultStatus) {
        case 'appointed':
            return 'succeeded';
        case 'not-elected':
        case 'not-authorized':
            return 'not-elected';
        case 'not-ready':
            return 'not-ready';
        case 'failed':
        case 'no-local-peer':
        default:
            return 'failed';
    }
}

function withValidatedAvatarProfile(pose: PlayerPose): PlayerPose {
    const validation = validateAvatarProfile(pose.avatarProfile, pose.sessionId);
    return {
        ...pose,
        avatarProfile: validation.ok
            ? validation.profile
            : createDeterministicAvatarProfile(pose.sessionId, pose.username),
    };
}

async function probeHttp(
    operation: (signal: AbortSignal) => Promise<unknown>,
): Promise<HttpProbeDiagnostics> {
    const controller = new AbortController();
    const startedAtEpochMs = Date.now();
    const timeout = window.setTimeout(() => controller.abort(), 2_500);
    try {
        const value = await operation(controller.signal);
        return {
            status: 'ok',
            checkedAtEpochMs: Date.now(),
            durationMs: Date.now() - startedAtEpochMs,
            detail: summarizeProbeValue(value),
        };
    } catch (err) {
        return {
            status: 'error',
            checkedAtEpochMs: Date.now(),
            durationMs: Date.now() - startedAtEpochMs,
            reason: toErrorMessage(err),
        };
    } finally {
        window.clearTimeout(timeout);
    }
}

function summarizeProbeValue(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record['iceServers'])) {
        return `${record['iceServers'].length} ICE servers`;
    }
    const apiBaseUrl = typeof record['apiBaseUrl'] === 'string'
        ? record['apiBaseUrl']
        : undefined;
    const wsBaseUrl = typeof record['wsBaseUrl'] === 'string'
        ? record['wsBaseUrl']
        : undefined;
    if (apiBaseUrl || wsBaseUrl) {
        return [apiBaseUrl, wsBaseUrl].filter(Boolean).join(' / ');
    }
    return undefined;
}
