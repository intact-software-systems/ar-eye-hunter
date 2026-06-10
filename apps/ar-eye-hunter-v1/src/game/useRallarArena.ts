import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    rallar,
    type RallarDirectorStatus,
    type RallarRoomSummary,
} from '@shared-web/browser/rallar.ts';
import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
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
    type GameRealtimeMessage,
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
import { arenaRevisionKey, hydrateArenaSnapshot } from './simulation.ts';
import {
    ARENA_RALLAR_GAME_DATA_CHANNEL_LANES,
    GAME_SNAPSHOT_LANE_ID,
    createArenaRallarGameMatch,
    isArenaAcceptedShotFromSender,
    isArenaPoseIntentFromSender,
    isArenaShotIntentFromSender,
    type ArenaRallarGameMatchHandle,
} from './rallar-game-match-adapter.ts';

type ConnectionState = 'signed-out' | 'connecting' | 'connected' | 'error';
type AiStatus = 'idle' | 'generating' | 'accepted' | 'error' | 'unavailable';

export type ArenaConnection = Readonly<{
    session?: AuthSession;
    connectionState: ConnectionState;
    error?: string;
    roomId?: string;
    rooms: readonly RallarRoomSummary[];
    directorStatus: RallarDirectorStatus;
    rtcLanes: readonly RtcLaneStatus[];
    aiStatus: AiStatus;
    aiError?: string;
    activeEvent?: ArenaEvent;
    arenaSnapshot?: ArenaSnapshot;
    remoteEvents: readonly ArenaEvent[];
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    login(username: string, password: string): Promise<void>;
    register(username: string, password: string, displayName?: string): Promise<void>;
    logout(): Promise<void>;
    refreshRooms(): Promise<void>;
    createArenaRoom(): Promise<void>;
    joinRoom(roomId: string): Promise<void>;
    appointSelfAsDirector(): Promise<void>;
    sendPose(pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>): void;
    sendShot(
        shot: Omit<PlayerShot, 'sessionId' | 'username' | 'color'>,
        accepted: ShotAccepted,
    ): void;
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

    const roomIdRef = useRef<string | undefined>(undefined);
    const sessionRef = useRef<AuthSession | undefined>(session);
    const directorStatusRef = useRef<RallarDirectorStatus>(directorStatus);
    const arenaMatchRef = useRef<ArenaRallarGameMatchHandle | undefined>(undefined);
    const remotePlayersRef = useRef<ReadonlyMap<string, RemotePlayer>>(remotePlayers);
    const arenaSnapshotRef = useRef<ArenaSnapshot | undefined>(arenaSnapshot);
    const poseSendBudget = useRef(0);

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
        remotePlayersRef.current = remotePlayers;
    }, [remotePlayers]);

    useEffect(() => {
        arenaSnapshotRef.current = arenaSnapshot;
    }, [arenaSnapshot]);

    const acceptDirectorOutput = useCallback((
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;
        if (message.kind === 'director-player-state') {
            const pose = message.pose;
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
                            pose,
                            lastSeenEpochMs: Date.now(),
                        },
                    ]),
            ));
        }
    }, []);

    const acceptMotionMessage = useCallback((
        peerId: string,
        message: GameRealtimeMessage,
    ) => {
        if (message.protocol !== GAME_PROTOCOL) {
            return;
        }

        const currentSessionId = sessionRef.current?.sessionId;
        if (message.kind === 'player-pose') {
            const pose = message.pose;
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
    }, []);

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
    }, []);

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
            onInput: async (envelope) => {
                const data = envelope.payload;
                if (!isArenaPoseIntentFromSender(data, envelope.senderId)) {
                    return;
                }

                await arenaMatchRef.current?.publishEvent({
                    protocol: GAME_PROTOCOL,
                    kind: 'director-player-state',
                    pose: data.pose,
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
        });

        void match.start()
            .then(async () => {
                await match.reportCapability();
                const appointment = await match.appointIfElected();
                if (appointment.directorStatus) {
                    setDirectorStatus(appointment.directorStatus);
                } else {
                    setDirectorStatus(rallar.director.status(roomId));
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
                await match.requestSync({ reason: 'arena-join' });
            })
            .catch((err) => {
                setError(toErrorMessage(err));
            });

        return () => {
            unsubscribeStatus();
            match.stop();
            if (arenaMatchRef.current === match) {
                arenaMatchRef.current = undefined;
            }
        };
    }, [acceptDirectorOutput, connectionState, roomId]);

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
        await rallar.auth.logout();
        setSession(undefined);
        setRoomId(undefined);
        setRooms([]);
        setArenaSnapshot(undefined);
        setRemoteEvents([]);
        setActiveEvent(undefined);
        setRemotePlayers(new Map());
        setRemoteShots([]);
        setConnectionState('signed-out');
    }, []);

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
        const currentRoomId = roomIdRef.current;
        if (!currentRoomId) {
            return;
        }

        const match = arenaMatchRef.current;
        if (match) {
            await match.reportCapability();
            const result = await match.appointIfElected();
            if (result.directorStatus) {
                setDirectorStatus(result.directorStatus);
                return;
            }
        }

        setDirectorStatus(rallar.director.status(currentRoomId));
    }, []);

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
            if (!latest.appointment && roomIdRef.current) {
                void appointSelfAsDirector();
            }
        }, 750);
        return () => window.clearTimeout(timer);
    }, [appointSelfAsDirector, connectionState, roomId]);

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
        };
        const input: GameRealtimeMessage = {
            protocol: GAME_PROTOCOL,
            kind: 'player-pose-intent',
            pose: fullPose,
        };
        const match = arenaMatchRef.current;
        if (match?.status().directorIsFresh) {
            void match.sendInput(input);
            return;
        }

        void rallar.realtime.sendJson<GameRealtimeMessage>({
            laneId: GAME_MOTION_LANE_ID,
            roomId: currentRoomId,
            data: {
                protocol: GAME_PROTOCOL,
                kind: 'player-pose',
                pose: fullPose,
            },
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
        aiStatus,
        aiError,
        activeEvent,
        arenaSnapshot,
        remoteEvents,
        remotePlayers,
        remoteShots,
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        appointSelfAsDirector,
        sendPose,
        sendShot,
        publishArenaSnapshot,
    }), [
        session,
        connectionState,
        error,
        roomId,
        rooms,
        directorStatus,
        rtcLanes,
        aiStatus,
        aiError,
        activeEvent,
        arenaSnapshot,
        remoteEvents,
        remotePlayers,
        remoteShots,
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        appointSelfAsDirector,
        sendPose,
        sendShot,
        publishArenaSnapshot,
    ]);
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
