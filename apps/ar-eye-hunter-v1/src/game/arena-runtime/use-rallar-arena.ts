import { readAuthSessionStorageKind } from '@shared/api/auth.ts';
import { useMemo } from 'react';

import { useArenaDiagnosticActions } from './actions/use-arena-diagnostic-actions.ts';
import { useArenaSessionActions } from './actions/use-arena-session-actions.ts';
import { useArenaAiDirectorLifecycle } from './ai/use-arena-ai-director-lifecycle.ts';
import type { ArenaConnection } from './arena-connection-contracts.ts';
import { useArenaCombatActions } from './game-actions/use-arena-combat-actions.ts';
import { useArenaWorldActions } from './game-actions/use-arena-world-actions.ts';
import { useArenaDirectorAppointment } from './match/use-arena-director-appointment.ts';
import { useArenaMatchRuntime } from './match/use-arena-match-runtime.ts';
import { useArenaDirectorMessageHandler } from './messages/use-arena-director-message-handler.ts';
import { useArenaPeerMessageHandlers } from './messages/use-arena-peer-message-handlers.ts';
import { useArenaAvatarProfile } from './state/use-arena-avatar-profile.ts';
import { useArenaPresenceActions } from './state/use-arena-presence-actions.ts';
import { useArenaPresenceLifecycle } from './state/use-arena-presence-lifecycle.ts';
import { useArenaRuntimeState } from './state/use-arena-runtime-state.ts';
import { useArenaStateAcceptance } from './state/use-arena-state-acceptance.ts';
import { useArenaConnectionSessionLifecycle } from './transport/use-arena-connection-session-lifecycle.ts';
import { useArenaNetworkTransportSupport } from './transport/use-arena-network-transport-support.ts';
import { useArenaRtcLifecycle } from './transport/use-arena-rtc-lifecycle.ts';

interface ArenaConnectionViewInput {
    readonly state: ReturnType<typeof useArenaRuntimeState>;
    readonly presence: ReturnType<typeof useArenaPresence>;
    readonly connectionActions: ReturnType<typeof useArenaConnectionActions>;
    readonly gameActions: ReturnType<typeof useArenaGameActions>;
}

export type {
    ArenaConnection,
    ArenaDiagnosticsRefreshOptions,
    ArenaHttpDiagnostics,
    ArenaTransportDiagnostics,
    DirectorAttemptState,
    HttpProbeDiagnostics
} from './arena-connection-contracts.ts';

export function useRallarArena(): ArenaConnection {
    const state = useArenaRuntimeState();
    const presence = useArenaPresence(state);
    useArenaAvatarProfile({
        arenaSnapshotRef: state.arenaSnapshotRef,
        isCurrentNetworkGeneration: state.isCurrentNetworkGeneration,
        localAvatarProfileRef: state.localAvatarProfileRef,
        networkGenerationRef: state.networkGenerationRef,
        roomId: state.roomId,
        session: state.session
    });
    const transport = useArenaSnapshotTransport(state);
    const messages = useArenaMessageHandlers(state);
    const connect = useArenaConnectionLifecycle(state, messages);
    const attemptDirectorAppointment = useArenaMatchLifecycles(
        state,
        messages,
        transport
    );
    useArenaAiDirectorLifecycle({
        arenaMatchRef: state.arenaMatchRef,
        arenaSnapshotRef: state.arenaSnapshotRef,
        connectionState: state.connectionState,
        directorStatus: state.directorStatus,
        isCurrentNetworkGeneration: state.isCurrentNetworkGeneration,
        networkGenerationRef: state.networkGenerationRef,
        roomId: state.roomId,
        runBestEffortNetworkTask: transport.runBestEffortNetworkTask,
        setActiveEvent: state.setActiveEvent,
        setAiError: state.setAiError,
        setAiStatus: state.setAiStatus,
        setRemoteEvents: state.setRemoteEvents
    });
    const connectionActions = useArenaConnectionActions(
        state,
        connect,
        attemptDirectorAppointment
    );
    const gameActions = useArenaGameActions(state, messages, transport);

    return useArenaConnectionView({ state, presence, connectionActions, gameActions });
}

function useArenaPresence(state: ReturnType<typeof useArenaRuntimeState>) {
    return useArenaPresenceLifecycle({
        connectionState: state.connectionState,
        directorStatus: state.directorStatus,
        isNetworkEnabled: state.isNetworkEnabled,
        presenceDirectorLabelRef: state.presenceDirectorLabelRef,
        presenceInitializedRef: state.presenceInitializedRef,
        presenceLinkRef: state.presenceLinkRef,
        presenceNotices: state.presenceNotices,
        presencePlayersRef: state.presencePlayersRef,
        remotePlayers: state.remotePlayers,
        roomId: state.roomId,
        rtcLanes: state.rtcLanes,
        session: state.session,
        setPresenceNotices: state.setPresenceNotices,
        transportDiagnostics: state.transportDiagnostics
    });
}

function useArenaSnapshotTransport(state: ReturnType<typeof useArenaRuntimeState>) {
    return useArenaNetworkTransportSupport({
        arenaMatchRef: state.arenaMatchRef,
        clearPendingReliableArenaSnapshot: state.clearPendingReliableArenaSnapshot,
        directorStatusRef: state.directorStatusRef,
        isCurrentNetworkGeneration: state.isCurrentNetworkGeneration,
        networkGenerationRef: state.networkGenerationRef,
        reliableSnapshotLastSentAtRef: state.reliableSnapshotLastSentAtRef,
        reliableSnapshotLastSentRevisionRef: state.reliableSnapshotLastSentRevisionRef,
        reliableSnapshotPendingRef: state.reliableSnapshotPendingRef,
        reliableSnapshotTimerRef: state.reliableSnapshotTimerRef,
        roomIdRef: state.roomIdRef,
        setTransportDiagnostics: state.setTransportDiagnostics
    });
}

function useArenaMessageHandlers(state: ReturnType<typeof useArenaRuntimeState>) {
    const stateAcceptance = useArenaStateAcceptance({
        arenaMatchRef: state.arenaMatchRef,
        arenaSnapshotRef: state.arenaSnapshotRef,
        roomIdRef: state.roomIdRef,
        setActiveEvent: state.setActiveEvent,
        setArenaSnapshot: state.setArenaSnapshot,
        setPickupAcceptances: state.setPickupAcceptances,
        setRemoteEvents: state.setRemoteEvents,
        setRemotePlayerHits: state.setRemotePlayerHits
    });
    const acceptDirectorOutput = useArenaDirectorMessageHandler({
        acceptEyeAttack: stateAcceptance.acceptEyeAttack,
        acceptPickup: stateAcceptance.acceptPickup,
        acceptPlayerHit: stateAcceptance.acceptPlayerHit,
        arenaSnapshotRef: state.arenaSnapshotRef,
        roomIdRef: state.roomIdRef,
        sessionRef: state.sessionRef,
        setActiveEvent: state.setActiveEvent,
        setArenaSnapshot: state.setArenaSnapshot,
        setRemoteEvents: state.setRemoteEvents,
        setRemotePlayers: state.setRemotePlayers,
        setRemoteShots: state.setRemoteShots
    });
    const peerMessages = useArenaPeerMessageHandlers({
        acceptEyeAttack: stateAcceptance.acceptEyeAttack,
        acceptPickup: stateAcceptance.acceptPickup,
        acceptPlayerHit: stateAcceptance.acceptPlayerHit,
        sessionRef: state.sessionRef,
        setActiveEvent: state.setActiveEvent,
        setArenaSnapshot: state.setArenaSnapshot,
        setRemoteEvents: state.setRemoteEvents,
        setRemotePlayers: state.setRemotePlayers,
        setRemoteShots: state.setRemoteShots
    });

    return { ...stateAcceptance, ...peerMessages, acceptDirectorOutput };
}

function useArenaConnectionLifecycle(
    state: ReturnType<typeof useArenaRuntimeState>,
    messages: ReturnType<typeof useArenaMessageHandlers>
) {
    const { connect } = useArenaConnectionSessionLifecycle({
        acceptMotionMessage: messages.acceptMotionMessage,
        acceptRealtimeMessage: messages.acceptRealtimeMessage,
        bumpNetworkGeneration: state.bumpNetworkGeneration,
        connectionState: state.connectionState,
        currentNetworkSignal: state.currentNetworkSignal,
        isCurrentNetworkGeneration: state.isCurrentNetworkGeneration,
        roomIdRef: state.roomIdRef,
        setConnectionState: state.setConnectionState,
        setDirectorStatus: state.setDirectorStatus,
        setError: state.setError,
        setRemotePlayers: state.setRemotePlayers,
        setRoomId: state.setRoomId,
        setRooms: state.setRooms,
        setSession: state.setSession
    });
    return connect;
}

function useArenaMatchLifecycles(
    state: ReturnType<typeof useArenaRuntimeState>,
    messages: ReturnType<typeof useArenaMessageHandlers>,
    transport: ReturnType<typeof useArenaSnapshotTransport>
) {
    useArenaRtcLifecycle({
        arenaMatchRef: state.arenaMatchRef,
        connectionState: state.connectionState,
        isCurrentNetworkGeneration: state.isCurrentNetworkGeneration,
        isNetworkEnabled: state.isNetworkEnabled,
        networkGenerationRef: state.networkGenerationRef,
        roomId: state.roomId,
        rtcLanes: state.rtcLanes,
        runBestEffortNetworkTask: transport.runBestEffortNetworkTask,
        setGameDiagnostics: state.setGameDiagnostics,
        setRtcLanes: state.setRtcLanes,
        snapshotLaneReadySyncKeyRef: state.snapshotLaneReadySyncKeyRef
    });
    const { attemptDirectorAppointment } = useArenaDirectorAppointment({
        arenaMatchRef: state.arenaMatchRef,
        isCurrentNetworkGeneration: state.isCurrentNetworkGeneration,
        networkGenerationRef: state.networkGenerationRef,
        roomIdRef: state.roomIdRef,
        setDirectorAttempt: state.setDirectorAttempt,
        setDirectorStatus: state.setDirectorStatus,
        setGameDiagnostics: state.setGameDiagnostics
    });
    useArenaMatchRuntime(
        {
            acceptDirectorOutput: messages.acceptDirectorOutput,
            acceptMatchStartIntent: messages.acceptMatchStartIntent,
            acceptMotionMessage: messages.acceptMotionMessage,
            acceptPickup: messages.acceptPickup,
            acceptPlayerHit: messages.acceptPlayerHit,
            activeMatchRoomIdRef: state.activeMatchRoomIdRef,
            arenaMatchRef: state.arenaMatchRef,
            arenaSnapshotRef: state.arenaSnapshotRef,
            bumpNetworkGeneration: state.bumpNetworkGeneration,
            connectionState: state.connectionState,
            isCurrentNetworkGeneration: state.isCurrentNetworkGeneration,
            networkGenerationRef: state.networkGenerationRef,
            roomId: state.roomId,
            roomIdRef: state.roomIdRef,
            runBestEffortNetworkTask: transport.runBestEffortNetworkTask,
            setActiveEvent: state.setActiveEvent,
            setArenaSnapshot: state.setArenaSnapshot,
            setDirectorStatus: state.setDirectorStatus,
            setError: state.setError,
            setGameDiagnostics: state.setGameDiagnostics,
            setRemoteEvents: state.setRemoteEvents
        },
        attemptDirectorAppointment
    );
    return attemptDirectorAppointment;
}

function useArenaConnectionActions(
    state: ReturnType<typeof useArenaRuntimeState>,
    connect: ReturnType<typeof useArenaConnectionLifecycle>,
    attemptDirectorAppointment: ReturnType<typeof useArenaMatchLifecycles>
) {
    const sessionActions = useArenaSessionActions({
        attemptDirectorAppointment,
        clearRoomScopedArenaState: state.clearRoomScopedArenaState,
        connect,
        connectionState: state.connectionState,
        directorAttemptRef: state.directorAttemptRef,
        directorStatusRef: state.directorStatusRef,
        isNetworkEnabled: state.isNetworkEnabled,
        resetForSignedOutAuth: state.resetForSignedOutAuth,
        roomId: state.roomId,
        roomIdRef: state.roomIdRef,
        rooms: state.rooms,
        sessionRef: state.sessionRef,
        setConnectionState: state.setConnectionState,
        setError: state.setError,
        setRoomId: state.setRoomId,
        setRooms: state.setRooms,
        setSession: state.setSession
    });
    const diagnosticActions = useArenaDiagnosticActions({
        arenaMatchRef: state.arenaMatchRef,
        currentNetworkSignal: state.currentNetworkSignal,
        diagnosticsRefreshRef: state.diagnosticsRefreshRef,
        isCurrentNetworkGeneration: state.isCurrentNetworkGeneration,
        isNetworkEnabled: state.isNetworkEnabled,
        networkGenerationRef: state.networkGenerationRef,
        sessionRef: state.sessionRef,
        setGameDiagnostics: state.setGameDiagnostics,
        setHttpDiagnostics: state.setHttpDiagnostics,
        setPresenceNotices: state.setPresenceNotices,
        setRtcLanes: state.setRtcLanes,
        setTransportDiagnostics: state.setTransportDiagnostics,
        transportDiagnosticsRef: state.transportDiagnosticsRef
    });
    return { sessionActions, diagnosticActions };
}

function useArenaGameActions(
    state: ReturnType<typeof useArenaRuntimeState>,
    messages: ReturnType<typeof useArenaMessageHandlers>,
    transport: ReturnType<typeof useArenaSnapshotTransport>
) {
    const presenceActions = useArenaPresenceActions({
        arenaMatchRef: state.arenaMatchRef,
        isNetworkEnabled: state.isNetworkEnabled,
        localAvatarProfileRef: state.localAvatarProfileRef,
        networkGenerationRef: state.networkGenerationRef,
        poseSendBudget: state.poseSendBudget,
        roomIdRef: state.roomIdRef,
        runBestEffortNetworkTask: transport.runBestEffortNetworkTask,
        sessionRef: state.sessionRef
    });
    const combatActions = useArenaCombatActions({
        acceptPlayerHit: messages.acceptPlayerHit,
        arenaMatchRef: state.arenaMatchRef,
        arenaSnapshotRef: state.arenaSnapshotRef,
        directorStatusRef: state.directorStatusRef,
        isNetworkEnabled: state.isNetworkEnabled,
        networkGenerationRef: state.networkGenerationRef,
        roomIdRef: state.roomIdRef,
        runBestEffortNetworkTask: transport.runBestEffortNetworkTask,
        sessionRef: state.sessionRef,
        setArenaSnapshot: state.setArenaSnapshot
    });
    const worldActions = useArenaWorldActions({
        acceptMatchStartIntent: messages.acceptMatchStartIntent,
        acceptPickup: messages.acceptPickup,
        arenaMatchRef: state.arenaMatchRef,
        arenaSnapshotRef: state.arenaSnapshotRef,
        directorStatusRef: state.directorStatusRef,
        isNetworkEnabled: state.isNetworkEnabled,
        networkGenerationRef: state.networkGenerationRef,
        roomIdRef: state.roomIdRef,
        runBestEffortNetworkTask: transport.runBestEffortNetworkTask,
        scheduleReliableArenaSnapshot: transport.scheduleReliableArenaSnapshot,
        sessionRef: state.sessionRef,
        setArenaSnapshot: state.setArenaSnapshot
    });
    return { presenceActions, combatActions, worldActions };
}

function useArenaConnectionView(input: ArenaConnectionViewInput): ArenaConnection {
    const { state, presence, connectionActions, gameActions } = input;
    return useMemo(
        () => createArenaConnectionView(input),
        [
            state.activeEvent,
            state.aiError,
            state.aiStatus,
            state.arenaMatchRef,
            state.arenaSnapshot,
            state.connectionState,
            state.directorAttempt,
            state.directorStatus,
            state.error,
            state.gameDiagnostics,
            state.httpDiagnostics,
            state.isNetworkEnabled,
            state.networkGenerationRef,
            state.pickupAcceptances,
            state.presenceNotices,
            state.remoteEvents,
            state.remotePlayerHits,
            state.remotePlayers,
            state.remoteShots,
            state.roomId,
            state.roomIdRef,
            state.rooms,
            state.rtcLanes,
            state.session,
            state.sessionRef,
            state.transportDiagnostics,
            presence.dismissPresenceNotice,
            presence.linkState,
            connectionActions.diagnosticActions,
            connectionActions.sessionActions,
            gameActions.combatActions,
            gameActions.presenceActions,
            gameActions.worldActions
        ]
    );
}

function createArenaConnectionView(input: ArenaConnectionViewInput): ArenaConnection {
    const { state, presence, connectionActions, gameActions } = input;
    return {
        session: state.session,
        connectionState: state.connectionState,
        error: state.error,
        roomId: state.roomId,
        rooms: state.rooms,
        directorStatus: state.directorStatus,
        rtcLanes: state.rtcLanes,
        directorAttempt: state.directorAttempt,
        gameDiagnostics: state.gameDiagnostics,
        transportDiagnostics: state.transportDiagnostics,
        httpDiagnostics: state.httpDiagnostics,
        linkState: presence.linkState,
        presenceNotices: state.presenceNotices,
        authStorageKind: readAuthSessionStorageKind(),
        authGeneration: state.networkGenerationRef.current,
        networkEnabled: state.isNetworkEnabled(),
        logoutQuiesced: state.connectionState === 'signed-out' &&
            !state.sessionRef.current &&
            !state.roomIdRef.current &&
            !state.arenaMatchRef.current,
        aiStatus: state.aiStatus,
        aiError: state.aiError,
        activeEvent: state.activeEvent,
        arenaSnapshot: state.arenaSnapshot,
        remoteEvents: state.remoteEvents,
        remotePlayers: state.remotePlayers,
        remoteShots: state.remoteShots,
        remotePlayerHits: state.remotePlayerHits,
        pickupAcceptances: state.pickupAcceptances,
        ...connectionActions.sessionActions,
        ...connectionActions.diagnosticActions,
        dismissPresenceNotice: presence.dismissPresenceNotice,
        ...gameActions.presenceActions,
        ...gameActions.combatActions,
        ...gameActions.worldActions
    };
}
