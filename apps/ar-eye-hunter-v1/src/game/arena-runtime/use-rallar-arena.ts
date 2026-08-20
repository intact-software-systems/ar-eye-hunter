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
import {
    readWebSocketTicketBackoffState,
    type WebSocketTicketBackoffState,
} from '@shared-web/browser/auth/websocket-ticket-http-api.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { type AuthSessionStorageKind, readAuthSessionStorageKind } from '@shared/api/auth.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import {
    createRallarAiFunnyRoomName,
    createRallarAiRoomNameSeed,
    transitionRallarAiResultLifecycle,
} from '@shared/rallar-ai/mod.ts';
import { shouldSendRallarMotionSample } from '@shared/rallar-motion/mod.ts';

import {
    type AiDirectorProposal,
    type AiDirectorProposalValue,
    type ArenaEvent,
    type ArenaMatchDurationMs,
    type ArenaSnapshot,
    type EyeAttackAccepted,
    GAME_AI_LANE_ID,
    GAME_AI_TOPIC_ID,
    GAME_COMBAT_LANE_ID,
    GAME_FX_LANE_ID,
    GAME_MOTION_LANE_ID,
    GAME_PROTOCOL,
    GAME_ROOM_NAME,
    type GameRealtimeMessage,
    type MatchStartIntent,
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
} from '../types.ts';
import { colorForId } from '../color.ts';
import {
    type AiDirectorContext,
    createAiDirectorMockProvider,
    createAiDirectorRequest,
    materializeAiArenaEvent,
    validateAiDirectorProposalValue,
} from '../aiDirector.ts';
import {
    applyEyeAttackAccepted,
    applyPickupAccepted,
    applyPlayerHitAccepted,
    arenaRevisionKey,
    hydrateArenaSnapshot,
    resolvePickupIntent,
    resolvePlayerHitIntent,
    startArenaMatch as startArenaMatchState,
    toArenaSnapshot,
    upsertPlayerPose,
} from '../simulation.ts';
import {
    ARENA_RALLAR_GAME_DATA_CHANNEL_LANES,
    type ArenaRallarGameMatchHandle,
    createArenaRallarGameMatch,
    GAME_SNAPSHOT_LANE_ID,
    isArenaAcceptedShotFromSender,
    isArenaMatchStartIntentFromSender,
    isArenaPickupIntentFromSender,
    isArenaPlayerHitIntentFromSender,
    isArenaPoseIntentFromSender,
    isArenaShotIntentFromSender,
} from '../rallar-game-match-adapter.ts';
import {
    type AvatarProfile,
    createAvatarProfileMockProvider,
    createAvatarProfileRequest,
    createDeterministicAvatarProfile,
    validateAvatarProfile,
} from '../avatarProfile.ts';
import { resolveArenaBrowserAiConfig } from '../browserAiConfig.ts';
import { createArenaBrowserAiProvider } from '../browserAiProvider.ts';
import {
    type ArenaLinkState,
    type ArenaPresenceNotice,
    type ArenaPresencePlayerSummary,
    deriveArenaLinkState,
    deriveArenaPresenceNotices,
    toPresencePlayerSummaries,
} from '../squadLink.ts';
import {
    type ArenaAiStatus,
    type ArenaConnection,
    type ArenaConnectionState,
    type ArenaHttpDiagnostics,
    type ArenaTransportDiagnostics,
    type DirectorAttemptState,
} from './arena-connection-contracts.ts';
import { toErrorMessage, withValidatedAvatarProfile } from './arena-connection-helpers.ts';
import { useArenaConnectionLifecycle } from './lifecycle/use-arena-connection-lifecycle.ts';
import { useArenaActions } from './actions/use-arena-actions.ts';
import { useArenaDirectorMessageHandler } from './messages/use-arena-director-message-handler.ts';
import { useArenaPeerMessageHandlers } from './messages/use-arena-peer-message-handlers.ts';
import { useArenaStateAcceptance } from './state/use-arena-state-acceptance.ts';
import {
    useArenaNetworkTransportSupport,
} from './transport/use-arena-network-transport-support.ts';
import { useArenaAvatarProfile } from './state/use-arena-avatar-profile.ts';

export type {
    ArenaConnection,
    ArenaDiagnosticsRefreshOptions,
    ArenaHttpDiagnostics,
    ArenaTransportDiagnostics,
    DirectorAttemptState,
    HttpProbeDiagnostics,
} from './arena-connection-contracts.ts';

const BROWSER_RALLAR_AI_CONFIG = resolveArenaBrowserAiConfig();
const ARENA_RELIABLE_SNAPSHOT_MIN_INTERVAL_MS = 1_000;

export function useRallarArena(): ArenaConnection {
    const [session, setSession] = useState<AuthSession | undefined>(() => rallar.auth.restore());
    const [connectionState, setConnectionState] = useState<ArenaConnectionState>(
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
    const [aiStatus, setAiStatus] = useState<ArenaAiStatus>('idle');
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
    const [presenceNotices, setPresenceNotices] = useState<readonly ArenaPresenceNotice[]>([]);

    const roomIdRef = useRef<string | undefined>(undefined);
    const sessionRef = useRef<AuthSession | undefined>(session);
    const directorStatusRef = useRef<RallarDirectorStatus>(directorStatus);
    const directorAttemptRef = useRef<DirectorAttemptState>(directorAttempt);
    const arenaMatchRef = useRef<ArenaRallarGameMatchHandle | undefined>(undefined);
    const activeMatchRoomIdRef = useRef<string | undefined>(undefined);
    const transportDiagnosticsRef = useRef<ArenaTransportDiagnostics>(transportDiagnostics);
    const diagnosticsRefreshRef = useRef<Promise<void> | undefined>(undefined);
    const remotePlayersRef = useRef<ReadonlyMap<string, RemotePlayer>>(remotePlayers);
    const presencePlayersRef = useRef<readonly ArenaPresencePlayerSummary[]>([]);
    const presenceLinkRef = useRef<ArenaLinkState | undefined>(undefined);
    const presenceDirectorLabelRef = useRef<string | undefined>(undefined);
    const presenceInitializedRef = useRef(false);
    const arenaSnapshotRef = useRef<ArenaSnapshot | undefined>(arenaSnapshot);
    const reliableSnapshotTimerRef = useRef<number | undefined>(undefined);
    const reliableSnapshotPendingRef = useRef<ArenaSnapshot | undefined>(undefined);
    const reliableSnapshotLastSentAtRef = useRef<number | undefined>(undefined);
    const reliableSnapshotLastSentRevisionRef = useRef<number | undefined>(undefined);
    const snapshotLaneReadySyncKeyRef = useRef<string | undefined>(undefined);
    const poseSendBudget = useRef(0);
    const localAvatarProfileRef = useRef<AvatarProfile | undefined>(undefined);
    const networkGenerationRef = useRef(0);
    const networkAbortRef = useRef<AbortController>(new AbortController());

    const clearPendingReliableArenaSnapshot = useCallback(() => {
        if (reliableSnapshotTimerRef.current !== undefined) {
            window.clearTimeout(reliableSnapshotTimerRef.current);
            reliableSnapshotTimerRef.current = undefined;
        }
        reliableSnapshotPendingRef.current = undefined;
    }, []);

    const resetReliableArenaSnapshotScheduler = useCallback(() => {
        clearPendingReliableArenaSnapshot();
        reliableSnapshotLastSentAtRef.current = undefined;
        reliableSnapshotLastSentRevisionRef.current = undefined;
        snapshotLaneReadySyncKeyRef.current = undefined;
    }, [clearPendingReliableArenaSnapshot]);

    const bumpNetworkGeneration = useCallback(() => {
        resetReliableArenaSnapshotScheduler();
        networkGenerationRef.current += 1;
        networkAbortRef.current.abort();
        networkAbortRef.current = new AbortController();
        return networkGenerationRef.current;
    }, [resetReliableArenaSnapshotScheduler]);

    const isCurrentNetworkGeneration = useCallback(
        (generation: number) => networkGenerationRef.current === generation,
        [],
    );

    const currentNetworkSignal = useCallback(() => networkAbortRef.current.signal, []);

    const isNetworkEnabled = useCallback(
        () => Boolean(sessionRef.current && roomIdRef.current && arenaMatchRef.current),
        [],
    );

    const clearRoomScopedArenaState = useCallback(() => {
        resetReliableArenaSnapshotScheduler();
        arenaSnapshotRef.current = undefined;
        remotePlayersRef.current = new Map();
        presencePlayersRef.current = [];
        presenceLinkRef.current = undefined;
        presenceDirectorLabelRef.current = undefined;
        presenceInitializedRef.current = false;
        poseSendBudget.current = 0;
        localAvatarProfileRef.current = undefined;
        setArenaSnapshot(undefined);
        setRemoteEvents([]);
        setActiveEvent(undefined);
        setRemotePlayers(new Map());
        setRemoteShots([]);
        setRemotePlayerHits([]);
        setPickupAcceptances([]);
        setPresenceNotices([]);
        setGameDiagnostics(undefined);
        setRtcLanes([]);
    }, [resetReliableArenaSnapshotScheduler]);

    const resetForSignedOutAuth = useCallback(() => {
        bumpNetworkGeneration();
        arenaMatchRef.current?.stop();
        arenaMatchRef.current = undefined;
        activeMatchRoomIdRef.current = undefined;
        sessionRef.current = undefined;
        roomIdRef.current = undefined;
        clearRoomScopedArenaState();
        setSession(undefined);
        setRoomId(undefined);
        setRooms([]);
        const signedOutDirectorStatus = rallar.director.status();
        const signedOutDirectorAttempt: DirectorAttemptState = { status: 'idle' };
        const signedOutTransportDiagnostics: ArenaTransportDiagnostics = {
            realtimeHealth: [],
            wsTicketBackoff: readWebSocketTicketBackoffState(),
        };
        directorStatusRef.current = signedOutDirectorStatus;
        directorAttemptRef.current = signedOutDirectorAttempt;
        transportDiagnosticsRef.current = signedOutTransportDiagnostics;
        setDirectorStatus(signedOutDirectorStatus);
        setDirectorAttempt(signedOutDirectorAttempt);
        setTransportDiagnostics(signedOutTransportDiagnostics);
        setHttpDiagnostics({
            apiConfig: { status: 'idle' },
            ice: { status: 'idle' },
        });
        setAiStatus('idle');
        setAiError(undefined);
        setError(undefined);
        setConnectionState('signed-out');
    }, [bumpNetworkGeneration, clearRoomScopedArenaState]);

    useEffect(() => {
        return rallar.auth.onChange((state) => {
            if (state.authenticated) {
                setSession(state.session);
                return;
            }

            resetForSignedOutAuth();
        }, { emitCurrent: true });
    }, [resetForSignedOutAuth]);

    useEffect(() => () => {
        clearPendingReliableArenaSnapshot();
    }, [clearPendingReliableArenaSnapshot]);

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
        transportDiagnosticsRef.current = transportDiagnostics;
    }, [transportDiagnostics]);

    useEffect(() => {
        remotePlayersRef.current = remotePlayers;
    }, [remotePlayers]);

    useEffect(() => {
        arenaSnapshotRef.current = arenaSnapshot;
    }, [arenaSnapshot]);

    const linkPlayerCount = (session && roomId ? 1 : 0) + remotePlayers.size;
    const linkState = useMemo(() =>
        deriveArenaLinkState({
            connectionState,
            networkEnabled: isNetworkEnabled(),
            roomSelected: Boolean(roomId),
            playerCount: linkPlayerCount,
            rtcLanes,
            wsTicketBackoffStatus: transportDiagnostics.wsTicketBackoff?.status,
        }), [
        connectionState,
        isNetworkEnabled,
        linkPlayerCount,
        roomId,
        rtcLanes,
        transportDiagnostics.wsTicketBackoff?.status,
    ]);
    const presencePlayers = useMemo(
        () =>
            toPresencePlayerSummaries(
                remotePlayers,
                (player) => (player as RemotePlayer).pose.username,
            ),
        [remotePlayers],
    );
    const directorNoticeLabel = directorStatus.isDirector
        ? 'you'
        : directorStatus.isFresh
        ? 'peer mode'
        : 'host changing';

    useEffect(() => {
        if (!presenceInitializedRef.current) {
            presenceInitializedRef.current = true;
            presencePlayersRef.current = presencePlayers;
            presenceLinkRef.current = linkState;
            presenceDirectorLabelRef.current = directorNoticeLabel;
            return;
        }

        const notices = deriveArenaPresenceNotices({
            previousPlayers: presencePlayersRef.current,
            nextPlayers: presencePlayers,
            previousLink: presenceLinkRef.current,
            nextLink: linkState,
            previousDirectorLabel: presenceDirectorLabelRef.current,
            nextDirectorLabel: directorNoticeLabel,
            nowEpochMs: Date.now(),
        });
        presencePlayersRef.current = presencePlayers;
        presenceLinkRef.current = linkState;
        presenceDirectorLabelRef.current = directorNoticeLabel;
        if (notices.length === 0) {
            return;
        }
        setPresenceNotices((previous) => [...previous, ...notices].slice(-5));
    }, [directorNoticeLabel, linkState, presencePlayers]);

    useEffect(() => {
        if (presenceNotices.length === 0) {
            return;
        }
        const interval = window.setInterval(() => {
            const now = Date.now();
            setPresenceNotices((previous) =>
                previous.filter((notice) => now - notice.createdAtEpochMs < 6_500)
            );
        }, 1_000);
        return () => window.clearInterval(interval);
    }, [presenceNotices.length]);

    useArenaAvatarProfile({
        arenaSnapshotRef,
        isCurrentNetworkGeneration,
        localAvatarProfileRef,
        networkGenerationRef,
        roomId,
        session,
    });

    const {
        runBestEffortNetworkTask,
        scheduleReliableArenaSnapshot,
    } = useArenaNetworkTransportSupport({
        arenaMatchRef,
        arenaSnapshotRef,
        clearPendingReliableArenaSnapshot,
        directorStatusRef,
        isCurrentNetworkGeneration,
        localAvatarProfileRef,
        networkGenerationRef,
        reliableSnapshotLastSentAtRef,
        reliableSnapshotLastSentRevisionRef,
        reliableSnapshotPendingRef,
        reliableSnapshotTimerRef,
        roomId,
        roomIdRef,
        session,
        setTransportDiagnostics,
    });

    const {
        acceptPlayerHit,
        acceptPickup,
        acceptEyeAttack,
        acceptMatchStartIntent,
    } = useArenaStateAcceptance({
        arenaMatchRef,
        arenaSnapshotRef,
        roomIdRef,
        setActiveEvent,
        setArenaSnapshot,
        setPickupAcceptances,
        setRemoteEvents,
        setRemotePlayerHits,
    });
    const acceptDirectorOutput = useArenaDirectorMessageHandler({
        acceptEyeAttack,
        acceptPickup,
        acceptPlayerHit,
        arenaSnapshotRef,
        roomIdRef,
        sessionRef,
        setActiveEvent,
        setArenaSnapshot,
        setRemoteEvents,
        setRemotePlayers,
        setRemoteShots,
    });
    const { acceptMotionMessage, acceptRealtimeMessage } = useArenaPeerMessageHandlers({
        acceptEyeAttack,
        acceptPickup,
        acceptPlayerHit,
        sessionRef,
        setActiveEvent,
        setArenaSnapshot,
        setRemoteEvents,
        setRemotePlayers,
        setRemoteShots,
    });

    const { connect, attemptDirectorAppointment } = useArenaConnectionLifecycle({
        acceptDirectorOutput,
        acceptMatchStartIntent,
        acceptMotionMessage,
        acceptPickup,
        acceptPlayerHit,
        acceptRealtimeMessage,
        activeMatchRoomIdRef,
        arenaMatchRef,
        arenaSnapshotRef,
        bumpNetworkGeneration,
        connectionState,
        currentNetworkSignal,
        directorStatus,
        isCurrentNetworkGeneration,
        isNetworkEnabled,
        networkGenerationRef,
        roomId,
        roomIdRef,
        rtcLanes,
        runBestEffortNetworkTask,
        setActiveEvent,
        setAiError,
        setAiStatus,
        setArenaSnapshot,
        setConnectionState,
        setDirectorAttempt,
        setDirectorStatus,
        setError,
        setGameDiagnostics,
        setRemoteEvents,
        setRemotePlayers,
        setRoomId,
        setRooms,
        setRtcLanes,
        setSession,
        snapshotLaneReadySyncKeyRef,
    });

    const {
        login,
        register,
        logout,
        refreshRooms,
        createArenaRoom,
        joinRoom,
        appointSelfAsDirector,
        refreshDiagnostics,
        requestArenaSync,
        dismissPresenceNotice,
        sendPose,
        sendShot,
        sendPlayerHit,
        sendPickupIntent,
        startArenaMatch,
        publishArenaSnapshot,
    } = useArenaActions({
        acceptMatchStartIntent,
        acceptPickup,
        acceptPlayerHit,
        arenaMatchRef,
        arenaSnapshotRef,
        attemptDirectorAppointment,
        clearRoomScopedArenaState,
        connect,
        connectionState,
        currentNetworkSignal,
        diagnosticsRefreshRef,
        directorAttemptRef,
        directorStatusRef,
        isCurrentNetworkGeneration,
        isNetworkEnabled,
        localAvatarProfileRef,
        networkGenerationRef,
        poseSendBudget,
        resetForSignedOutAuth,
        roomId,
        roomIdRef,
        rooms,
        runBestEffortNetworkTask,
        scheduleReliableArenaSnapshot,
        sessionRef,
        setArenaSnapshot,
        setConnectionState,
        setError,
        setGameDiagnostics,
        setHttpDiagnostics,
        setPresenceNotices,
        setRoomId,
        setRooms,
        setRtcLanes,
        setSession,
        setTransportDiagnostics,
        transportDiagnosticsRef,
    });

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
        linkState,
        presenceNotices,
        authStorageKind: readAuthSessionStorageKind(),
        authGeneration: networkGenerationRef.current,
        networkEnabled: isNetworkEnabled(),
        logoutQuiesced: connectionState === 'signed-out' &&
            !sessionRef.current &&
            !roomIdRef.current &&
            !arenaMatchRef.current,
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
        dismissPresenceNotice,
        sendPose,
        sendShot,
        sendPlayerHit,
        sendPickupIntent,
        startArenaMatch,
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
        linkState,
        presenceNotices,
        isNetworkEnabled,
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
        dismissPresenceNotice,
        sendPose,
        sendShot,
        sendPlayerHit,
        sendPickupIntent,
        startArenaMatch,
        publishArenaSnapshot,
    ]);
}
