import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    rallar,
    type RallarDirectorStatus,
    type RallarRoomSummary,
} from '@shared-web/browser/rallar.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import {
    readWebSocketTicketBackoffState,
} from '@shared-web/browser/auth/websocket-ticket-http-api.ts';

import type { AvatarProfile } from '../../avatarProfile.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type {
    ArenaEvent,
    ArenaSnapshot,
    PickupAccepted,
    PlayerHitAccepted,
    RemotePlayer,
    RemoteShot,
    RtcLaneStatus,
} from '../../types.ts';
import type {
    ArenaAiStatus,
    ArenaConnectionState,
    ArenaHttpDiagnostics,
    ArenaTransportDiagnostics,
    DirectorAttemptState,
} from '../arena-connection-contracts.ts';
import type {
    ArenaLinkState,
    ArenaPresenceNotice,
    ArenaPresencePlayerSummary,
} from '../../squadLink.ts';

export function useArenaRuntimeState() {
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
    const [remotePlayers, setRemotePlayers] = useState<ReadonlyMap<string, RemotePlayer>>(
        new Map(),
    );
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
        const nextDirectorStatus = rallar.director.status();
        const nextDirectorAttempt: DirectorAttemptState = { status: 'idle' };
        const nextTransportDiagnostics: ArenaTransportDiagnostics = {
            realtimeHealth: [],
            wsTicketBackoff: readWebSocketTicketBackoffState(),
        };
        directorStatusRef.current = nextDirectorStatus;
        directorAttemptRef.current = nextDirectorAttempt;
        transportDiagnosticsRef.current = nextTransportDiagnostics;
        setDirectorStatus(nextDirectorStatus);
        setDirectorAttempt(nextDirectorAttempt);
        setTransportDiagnostics(nextTransportDiagnostics);
        setHttpDiagnostics({ apiConfig: { status: 'idle' }, ice: { status: 'idle' } });
        setAiStatus('idle');
        setAiError(undefined);
        setError(undefined);
        setConnectionState('signed-out');
    }, [bumpNetworkGeneration, clearRoomScopedArenaState]);

    useEffect(() => rallar.auth.onChange((state) => {
        if (state.authenticated) setSession(state.session);
        else resetForSignedOutAuth();
    }, { emitCurrent: true }), [resetForSignedOutAuth]);
    useEffect(() => () => clearPendingReliableArenaSnapshot(), [clearPendingReliableArenaSnapshot]);
    useEffect(() => void (sessionRef.current = session), [session]);
    useEffect(() => void (roomIdRef.current = roomId), [roomId]);
    useEffect(() => void (directorStatusRef.current = directorStatus), [directorStatus]);
    useEffect(() => void (directorAttemptRef.current = directorAttempt), [directorAttempt]);
    useEffect(() => void (transportDiagnosticsRef.current = transportDiagnostics), [
        transportDiagnostics,
    ]);
    useEffect(() => void (remotePlayersRef.current = remotePlayers), [remotePlayers]);
    useEffect(() => void (arenaSnapshotRef.current = arenaSnapshot), [arenaSnapshot]);

    return {
        activeEvent,
        activeMatchRoomIdRef,
        aiError,
        aiStatus,
        arenaMatchRef,
        arenaSnapshot,
        arenaSnapshotRef,
        bumpNetworkGeneration,
        clearPendingReliableArenaSnapshot,
        clearRoomScopedArenaState,
        connectionState,
        currentNetworkSignal,
        diagnosticsRefreshRef,
        directorAttempt,
        directorAttemptRef,
        directorStatus,
        directorStatusRef,
        error,
        gameDiagnostics,
        httpDiagnostics,
        isCurrentNetworkGeneration,
        isNetworkEnabled,
        localAvatarProfileRef,
        networkGenerationRef,
        pickupAcceptances,
        poseSendBudget,
        presenceDirectorLabelRef,
        presenceInitializedRef,
        presenceLinkRef,
        presenceNotices,
        presencePlayersRef,
        reliableSnapshotLastSentAtRef,
        reliableSnapshotLastSentRevisionRef,
        reliableSnapshotPendingRef,
        reliableSnapshotTimerRef,
        remoteEvents,
        remotePlayerHits,
        remotePlayers,
        remotePlayersRef,
        remoteShots,
        resetForSignedOutAuth,
        roomId,
        roomIdRef,
        rooms,
        rtcLanes,
        session,
        sessionRef,
        setActiveEvent,
        setAiError,
        setAiStatus,
        setArenaSnapshot,
        setConnectionState,
        setDirectorAttempt,
        setDirectorStatus,
        setError,
        setGameDiagnostics,
        setHttpDiagnostics,
        setPickupAcceptances,
        setPresenceNotices,
        setRemoteEvents,
        setRemotePlayerHits,
        setRemotePlayers,
        setRemoteShots,
        setRoomId,
        setRooms,
        setRtcLanes,
        setSession,
        setTransportDiagnostics,
        snapshotLaneReadySyncKeyRef,
        transportDiagnostics,
        transportDiagnosticsRef,
    };
}
