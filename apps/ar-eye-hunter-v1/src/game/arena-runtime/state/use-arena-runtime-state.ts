import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type RefObject,
    type SetStateAction
} from 'react';

import { readWebSocketTicketBackoffState } from '@shared-web/browser/auth/websocket-ticket-http-api.ts';
import {
    rallar,
    type RallarDirectorStatus,
    type RallarRoomSummary
} from '@shared-web/browser/rallar.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryEntry, GroupDirectoryOrder } from '@shared/api/group-directory/group-directory-types.ts';

import type { AvatarProfile } from '../../avatarProfile.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type {
    ArenaLinkState,
    ArenaPresenceNotice,
    ArenaPresencePlayerSummary
} from '../../squadLink.ts';
import type {
    ArenaEvent,
    ArenaSnapshot,
    PickupAccepted,
    PlayerHitAccepted,
    RemotePlayer,
    RemoteShot,
    RtcLaneStatus
} from '../../types.ts';
import type {
    ArenaAiStatus,
    ArenaConnection,
    ArenaConnectionState,
    ArenaHttpDiagnostics,
    ArenaTransportDiagnostics,
    DirectorAttemptState
} from '../arena-connection-contracts.ts';

export function useArenaRuntimeState() {
    const state = useArenaStateOwners();
    const { scheduler, simulation, presence, diagnostics } = state;
    const clearRoomScopedArenaState = useCallback(() => {
        scheduler.resetReliableArenaSnapshotScheduler();
        simulation.clearSimulation();
        presence.clearPresence();
        diagnostics.clearRoomDiagnostics();
    }, [
        scheduler.resetReliableArenaSnapshotScheduler,
        simulation.clearSimulation,
        presence.clearPresence,
        diagnostics.clearRoomDiagnostics
    ]);
    const resetForSignedOutAuth = useArenaAuthenticationLifecycle(state, clearRoomScopedArenaState);
    return {
        ...state.auth,
        ...state.rooms,
        ...state.directory,
        ...state.director,
        ...state.diagnostics,
        ...state.simulation,
        ...state.presence,
        ...state.scheduler,
        ...state.network,
        ...state.ai,
        clearRoomScopedArenaState,
        resetForSignedOutAuth
    };
}

function useArenaStateOwners() {
    const directory = useArenaDirectoryState();
    const auth = useArenaAuthState(directory.resetOpenRooms);
    const rooms = useArenaRoomState();
    const director = useArenaDirectorState();
    const diagnostics = useArenaDiagnosticsState();
    const simulation = useArenaSimulationState();
    const presence = useArenaPresenceState();
    const scheduler = useArenaSnapshotSchedulerState();
    const network = useArenaNetworkState(
        auth.sessionRef,
        rooms.roomIdRef,
        scheduler.resetReliableArenaSnapshotScheduler
    );
    const ai = useArenaAiState();
    return { auth, rooms, directory, director, diagnostics, simulation, presence, scheduler, network, ai };
}

function useArenaAuthenticationLifecycle(
    state: ReturnType<typeof useArenaStateOwners>,
    clearRoomScopedArenaState: () => void
) {
    const { auth, rooms, directory, network, director, diagnostics, ai } = state;
    const resetForSignedOutAuth = useCallback(() => {
        network.bumpNetworkGeneration();
        network.arenaMatchRef.current?.stop();
        network.arenaMatchRef.current = undefined;
        network.activeMatchRoomIdRef.current = undefined;
        auth.setSession(undefined);
        rooms.roomIdRef.current = undefined;
        rooms.setRoomId(undefined);
        rooms.setRooms([]);
        directory.resetOpenRooms();
        clearRoomScopedArenaState();
        director.resetDirector();
        diagnostics.resetDiagnostics();
        ai.resetAi();
        auth.setError(undefined);
        auth.setConnectionState('signed-out');
    }, [
        network.bumpNetworkGeneration,
        auth.setSession,
        directory.resetOpenRooms,
        clearRoomScopedArenaState,
        director.resetDirector,
        diagnostics.resetDiagnostics,
        ai.resetAi
    ]);
    useEffect(() =>
        rallar.auth.onChange((state) => {
            if (state.authenticated) {
                auth.setSession(state.session);
            }
            else {
                resetForSignedOutAuth();
            }
        }, { emitCurrent: true }), [auth.setSession, resetForSignedOutAuth]);
    return resetForSignedOutAuth;
}

function useArenaDirectoryState() {
    const [openRooms, setOpenRooms] = useState<readonly GroupDirectoryEntry[]>([]);
    const [openRoomsStatus, setOpenRoomsStatus] = useState<ArenaConnection['openRoomsStatus']>('idle');
    const [openRoomsError, setOpenRoomsError] = useState<string | undefined>();
    const [directoryOrder, setDirectoryOrder] = useState<GroupDirectoryOrder>('online-members');
    const resetOpenRooms = useCallback(() => {
        setOpenRooms([]);
        setOpenRoomsStatus('idle');
        setOpenRoomsError(undefined);
    }, []);
    return {
        openRooms,
        openRoomsStatus,
        openRoomsError,
        directoryOrder,
        setDirectoryOrder,
        setOpenRooms,
        setOpenRoomsStatus,
        setOpenRoomsError,
        resetOpenRooms
    };
}

function useArenaAuthState(resetOpenRooms: () => void) {
    const [session, setAuthSession] = useState<AuthSession | undefined>(() => rallar.auth.restore());
    const sessionRef = useRef(session);
    const [connectionState, setConnectionState] = useState<ArenaConnectionState>(() =>
        session ? 'connecting' : 'signed-out'
    );
    const [error, setError] = useState<string | undefined>();
    const setSession: Dispatch<SetStateAction<AuthSession | undefined>> = useCallback((next) => {
        const nextSession = typeof next === 'function' ? next(sessionRef.current) : next;
        if (
            nextSession?.sessionId !== sessionRef.current?.sessionId ||
            nextSession?.clientId !== sessionRef.current?.clientId
        ) {
            resetOpenRooms();
        }
        sessionRef.current = nextSession;
        setAuthSession(nextSession);
    }, [resetOpenRooms]);
    return { session, sessionRef, setSession, connectionState, setConnectionState, error, setError };
}

function useArenaRoomState() {
    const [roomId, setRoomId] = useState<string | undefined>();
    const [rooms, setRooms] = useState<readonly RallarRoomSummary[]>([]);
    const roomIdRef = useRef<string | undefined>(undefined);
    useEffect(() => void (roomIdRef.current = roomId), [roomId]);
    return { roomId, setRoomId, rooms, setRooms, roomIdRef };
}

function useArenaDirectorState() {
    const [directorStatus, setDirectorStatus] = useState<RallarDirectorStatus>(() => rallar.director.status());
    const [directorAttempt, setDirectorAttempt] = useState<DirectorAttemptState>(() => ({ status: 'idle' }));
    const directorStatusRef = useRef(directorStatus);
    const directorAttemptRef = useRef(directorAttempt);
    const resetDirector = useCallback(() => {
        directorStatusRef.current = rallar.director.status();
        directorAttemptRef.current = { status: 'idle' };
        setDirectorStatus(directorStatusRef.current);
        setDirectorAttempt(directorAttemptRef.current);
    }, []);
    useEffect(() => void (directorStatusRef.current = directorStatus), [directorStatus]);
    useEffect(() => void (directorAttemptRef.current = directorAttempt), [directorAttempt]);
    return {
        directorStatus,
        setDirectorStatus,
        directorAttempt,
        setDirectorAttempt,
        directorStatusRef,
        directorAttemptRef,
        resetDirector
    };
}

function useArenaDiagnosticsState() {
    const [gameDiagnostics, setGameDiagnostics] = useState<RallarGameDiagnostics | undefined>();
    const [transportDiagnostics, setTransportDiagnostics] = useState<ArenaTransportDiagnostics>({ realtimeHealth: [] });
    const [httpDiagnostics, setHttpDiagnostics] = useState<ArenaHttpDiagnostics>({
        apiConfig: { status: 'idle' },
        ice: { status: 'idle' }
    });
    const [rtcLanes, setRtcLanes] = useState<readonly RtcLaneStatus[]>([]);
    const transportDiagnosticsRef = useRef(transportDiagnostics);
    const diagnosticsRefreshRef = useRef<Promise<void> | undefined>(undefined);
    const clearRoomDiagnostics = useCallback(() => {
        setGameDiagnostics(undefined);
        setRtcLanes([]);
    }, []);
    const resetDiagnostics = useCallback(() => {
        transportDiagnosticsRef.current = { realtimeHealth: [], wsTicketBackoff: readWebSocketTicketBackoffState() };
        setTransportDiagnostics(transportDiagnosticsRef.current);
        setHttpDiagnostics({ apiConfig: { status: 'idle' }, ice: { status: 'idle' } });
    }, []);
    useEffect(() => void (transportDiagnosticsRef.current = transportDiagnostics), [transportDiagnostics]);
    return {
        gameDiagnostics,
        setGameDiagnostics,
        transportDiagnostics,
        setTransportDiagnostics,
        httpDiagnostics,
        setHttpDiagnostics,
        rtcLanes,
        setRtcLanes,
        transportDiagnosticsRef,
        diagnosticsRefreshRef,
        clearRoomDiagnostics,
        resetDiagnostics
    };
}

function useArenaSimulationState() {
    const [arenaSnapshot, setArenaSnapshot] = useState<ArenaSnapshot | undefined>();
    const [remoteEvents, setRemoteEvents] = useState<readonly ArenaEvent[]>([]);
    const [activeEvent, setActiveEvent] = useState<ArenaEvent | undefined>();
    const [remotePlayers, setRemotePlayers] = useState<ReadonlyMap<string, RemotePlayer>>(new Map());
    const [remoteShots, setRemoteShots] = useState<readonly RemoteShot[]>([]);
    const [remotePlayerHits, setRemotePlayerHits] = useState<readonly PlayerHitAccepted[]>([]);
    const [pickupAcceptances, setPickupAcceptances] = useState<readonly PickupAccepted[]>([]);
    const remotePlayersRef = useRef(remotePlayers);
    const arenaSnapshotRef = useRef(arenaSnapshot);
    const clearSimulation = useCallback(() => {
        arenaSnapshotRef.current = undefined;
        remotePlayersRef.current = new Map();
        setArenaSnapshot(undefined);
        setRemoteEvents([]);
        setActiveEvent(undefined);
        setRemotePlayers(new Map());
        setRemoteShots([]);
        setRemotePlayerHits([]);
        setPickupAcceptances([]);
    }, []);
    useEffect(() => void (remotePlayersRef.current = remotePlayers), [remotePlayers]);
    useEffect(() => void (arenaSnapshotRef.current = arenaSnapshot), [arenaSnapshot]);
    return {
        arenaSnapshot,
        setArenaSnapshot,
        remoteEvents,
        setRemoteEvents,
        activeEvent,
        setActiveEvent,
        remotePlayers,
        setRemotePlayers,
        remoteShots,
        setRemoteShots,
        remotePlayerHits,
        setRemotePlayerHits,
        pickupAcceptances,
        setPickupAcceptances,
        remotePlayersRef,
        arenaSnapshotRef,
        clearSimulation
    };
}

function useArenaPresenceState() {
    const [presenceNotices, setPresenceNotices] = useState<readonly ArenaPresenceNotice[]>([]);
    const presencePlayersRef = useRef<readonly ArenaPresencePlayerSummary[]>([]);
    const presenceLinkRef = useRef<ArenaLinkState | undefined>(undefined);
    const presenceDirectorLabelRef = useRef<string | undefined>(undefined);
    const presenceInitializedRef = useRef(false);
    const poseSendBudget = useRef(0);
    const localAvatarProfileRef = useRef<AvatarProfile | undefined>(undefined);
    const clearPresence = useCallback(() => {
        presencePlayersRef.current = [];
        presenceLinkRef.current = undefined;
        presenceDirectorLabelRef.current = undefined;
        presenceInitializedRef.current = false;
        poseSendBudget.current = 0;
        localAvatarProfileRef.current = undefined;
        setPresenceNotices([]);
    }, []);
    return {
        presenceNotices,
        setPresenceNotices,
        presencePlayersRef,
        presenceLinkRef,
        presenceDirectorLabelRef,
        presenceInitializedRef,
        poseSendBudget,
        localAvatarProfileRef,
        clearPresence
    };
}

function useArenaSnapshotSchedulerState() {
    const reliableSnapshotTimerRef = useRef<number | undefined>(undefined);
    const reliableSnapshotPendingRef = useRef<ArenaSnapshot | undefined>(undefined);
    const reliableSnapshotLastSentAtRef = useRef<number | undefined>(undefined);
    const reliableSnapshotLastSentRevisionRef = useRef<number | undefined>(undefined);
    const snapshotLaneReadySyncKeyRef = useRef<string | undefined>(undefined);
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
    useEffect(() => () => clearPendingReliableArenaSnapshot(), [clearPendingReliableArenaSnapshot]);
    return {
        reliableSnapshotTimerRef,
        reliableSnapshotPendingRef,
        reliableSnapshotLastSentAtRef,
        reliableSnapshotLastSentRevisionRef,
        snapshotLaneReadySyncKeyRef,
        clearPendingReliableArenaSnapshot,
        resetReliableArenaSnapshotScheduler
    };
}

function useArenaNetworkState(
    sessionRef: RefObject<AuthSession | undefined>,
    roomIdRef: RefObject<string | undefined>,
    resetReliableArenaSnapshotScheduler: () => void
) {
    const arenaMatchRef = useRef<ArenaRallarGameMatchHandle | undefined>(undefined);
    const activeMatchRoomIdRef = useRef<string | undefined>(undefined);
    const networkGenerationRef = useRef(0);
    const networkAbortRef = useRef<AbortController>(new AbortController());
    const bumpNetworkGeneration = useCallback(() => {
        resetReliableArenaSnapshotScheduler();
        networkGenerationRef.current += 1;
        networkAbortRef.current.abort();
        networkAbortRef.current = new AbortController();
        return networkGenerationRef.current;
    }, [resetReliableArenaSnapshotScheduler]);
    const isCurrentNetworkGeneration = useCallback(
        (generation: number) => networkGenerationRef.current === generation,
        []
    );
    const currentNetworkSignal = useCallback(() => networkAbortRef.current.signal, []);
    const isNetworkEnabled = useCallback(
        () => Boolean(sessionRef.current && roomIdRef.current && arenaMatchRef.current),
        [sessionRef, roomIdRef]
    );
    return {
        arenaMatchRef,
        activeMatchRoomIdRef,
        networkGenerationRef,
        bumpNetworkGeneration,
        isCurrentNetworkGeneration,
        currentNetworkSignal,
        isNetworkEnabled
    };
}

function useArenaAiState() {
    const [aiStatus, setAiStatus] = useState<ArenaAiStatus>('idle');
    const [aiError, setAiError] = useState<string | undefined>();
    const resetAi = useCallback(() => {
        setAiStatus('idle');
        setAiError(undefined);
    }, []);
    return { aiStatus, setAiStatus, aiError, setAiError, resetAi };
}
