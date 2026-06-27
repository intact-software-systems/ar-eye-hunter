import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RallarRoomState, RallarRoomSummary } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    type RelicActionInput,
    type RelicCharacterId,
    type RelicPublicSnapshot,
    type RelicServerEvent,
    isRelicSnapshot,
} from '@relic-hunters/mod.ts';
import {
    initialRelicDiagnostics,
    RelicHuntersRuntime,
    type RelicCommandDraft,
    type RelicHuntersRuntimePhase,
    type RelicRuntimeDiagnostics,
    toErrorMessage,
} from './relic-hunters-runtime.ts';
import {
    classifyRelicSnapshotAcceptance,
    type RelicSnapshotSource,
} from './relic-snapshot-ordering.ts';

const RTC_SNAPSHOT_REPAIR_INTERVAL_MS = 2_000;
const ROUND_TIMEOUT_SNAPSHOT_REPAIR_INTERVAL_MS = 2_000;

export type RelicHuntersConnection = Readonly<{
    session?: AuthSession;
    connectionState: RelicHuntersRuntimePhase;
    diagnostics: RelicRuntimeDiagnostics;
    error?: string;
    roomId?: string;
    rooms: readonly RallarRoomSummary[];
    snapshot?: RelicPublicSnapshot;
    login(username: string, password: string): Promise<void>;
    register(username: string, password: string, displayName?: string): Promise<void>;
    logout(): Promise<void>;
    refreshRooms(): Promise<void>;
    createRoom(): Promise<void>;
    joinRoom(roomId: string): Promise<void>;
    joinExpedition(characterId?: RelicCharacterId): Promise<void>;
    startExpedition(): Promise<void>;
    submitAction(action: RelicActionInput): Promise<void>;
    forceResolveRound(): Promise<void>;
    pickupRelic(relicId: string): Promise<void>;
    continueReview(): Promise<void>;
    setRoundLimit(timeLimitMs: number): Promise<void>;
    resetExpedition(): Promise<void>;
}>;

export function useRelicHunters(): RelicHuntersConnection {
    const runtimeRef = useRef<RelicHuntersRuntime | undefined>(undefined);
    runtimeRef.current ??= new RelicHuntersRuntime();
    const runtime = runtimeRef.current;
    const initialSessionRef = useRef<AuthSession | undefined>(runtime.restoreSession());

    const [session, setSession] = useState<AuthSession | undefined>(initialSessionRef.current);
    const [connectionState, setConnectionState] = useState<RelicHuntersRuntimePhase>(
        () => initialSessionRef.current ? 'connecting' : 'signed-out',
    );
    const [diagnostics, setDiagnostics] = useState<RelicRuntimeDiagnostics>(
        () => initialRelicDiagnostics(initialSessionRef.current),
    );
    const [error, setError] = useState<string | undefined>();
    const [roomId, setRoomId] = useState<string | undefined>();
    const [rooms, setRooms] = useState<readonly RallarRoomSummary[]>([]);
    const [snapshot, setSnapshot] = useState<RelicPublicSnapshot | undefined>();
    const timedOutRoundRepairKey = snapshot ? toTimedOutRoundRepairKey(snapshot) : undefined;
    const sessionRef = useRef<AuthSession | undefined>(session);
    const roomIdRef = useRef<string | undefined>(roomId);
    const snapshotRef = useRef<RelicPublicSnapshot | undefined>(snapshot);
    const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
    const commandInFlightRef = useRef<string | undefined>(undefined);
    const roomSnapshotRequestRef = useRef(0);

    const setPhase = useCallback((
        phase: RelicHuntersRuntimePhase,
        patch: Partial<RelicRuntimeDiagnostics> = {},
    ) => {
        setConnectionState(phase);
        setDiagnostics((prev) => ({
            ...prev,
            ...patch,
            phase,
        }));
    }, []);

    useEffect(() => {
        sessionRef.current = session;
        setDiagnostics((prev) => ({
            ...prev,
            authenticated: !!session,
        }));
    }, [session]);

    useEffect(() => {
        roomIdRef.current = roomId;
        setDiagnostics((prev) => ({
            ...prev,
            roomId,
            roomReady: !!roomId,
            rtcReady: prev.middlewareConnected && !!roomId,
            authorityReady: prev.middlewareConnected && !!roomId &&
                !!runtimeRef.current?.authorityStatus()?.started,
            authorityPhase: runtimeRef.current?.authorityStatus()?.phase,
            authorityPeerAssistReadyPeers:
                runtimeRef.current?.authorityStatus()?.peerAssist.readyPeerIds.length ?? 0,
        }));
    }, [roomId]);

    useEffect(() => {
        snapshotRef.current = snapshot;
        setDiagnostics((prev) => ({
            ...prev,
            snapshotReady: !!snapshot,
            rtcReady: prev.middlewareConnected && !!roomIdRef.current,
            authorityReady: prev.middlewareConnected && !!roomIdRef.current &&
                !!runtimeRef.current?.authorityStatus()?.started,
            authorityPhase: runtimeRef.current?.authorityStatus()?.phase,
            authorityPeerAssistReadyPeers:
                runtimeRef.current?.authorityStatus()?.peerAssist.readyPeerIds.length ?? 0,
        }));
    }, [snapshot]);

    const clearSnapshot = useCallback(() => {
        snapshotRef.current = undefined;
        setSnapshot(undefined);
        setDiagnostics((prev) => ({
            ...prev,
            snapshotReady: false,
            lastSnapshotSource: undefined,
        }));
    }, []);

    const publishSnapshotToRtc = useCallback((
        next: RelicPublicSnapshot,
        source: RelicSnapshotSource,
    ) => {
        if (source === 'rallar-rtc') {
            return;
        }

        const currentRoomId = roomIdRef.current ?? next.roomId;
        if (!currentRoomId || currentRoomId !== next.roomId) {
            return;
        }

        void runtime.publishRtcSnapshot(next).catch((err) => {
            setDiagnostics((prev) => ({
                ...prev,
                lastError: `RTC snapshot sync failed: ${toErrorMessage(err)}`,
            }));
        });
    }, [runtime]);

    const acceptSnapshotCandidate = useCallback((
        next: RelicPublicSnapshot,
        source: RelicSnapshotSource,
        expectedRoomId = roomIdRef.current,
    ): boolean => {
        const acceptance = classifyRelicSnapshotAcceptance({
            current: snapshotRef.current,
            candidate: next,
            expectedRoomId,
            allowSemanticRegression: source === 'rest-reset',
        });

        if (!acceptance.accepted) {
            setDiagnostics((prev) => ({
                ...prev,
                ignoredSnapshotCount: prev.ignoredSnapshotCount + 1,
                lastIgnoredSnapshotReason: acceptance.reason,
                lastIgnoredSnapshot: summarizeRuntimeSnapshot(next, source),
            }));
            return false;
        }

        snapshotRef.current = next;
        setSnapshot(next);
        setDiagnostics((prev) => ({
            ...prev,
            snapshotReady: true,
            lastSnapshotSource: source,
            lastAcceptedSnapshot: summarizeRuntimeSnapshot(next, source),
            lastIgnoredSnapshotReason: undefined,
            lastIgnoredSnapshot: undefined,
            lastHydratedAtEpochMs: Date.now(),
        }));
        publishSnapshotToRtc(next, source);
        return true;
    }, [publishSnapshotToRtc]);

    const closeSubscriptions = useCallback(() => {
        unsubscribeRef.current?.();
        unsubscribeRef.current = undefined;
        setDiagnostics((prev) => ({
            ...prev,
            wsListenerReady: false,
            roomListenerReady: false,
            rtcReady: false,
            authorityReady: false,
            authorityPhase: undefined,
            authorityPeerAssistReadyPeers: 0,
        }));
    }, []);

    const resetForSignedOutAuth = useCallback(() => {
        closeSubscriptions();
        commandInFlightRef.current = undefined;
        setSession(undefined);
        setRoomId(undefined);
        roomIdRef.current = undefined;
        runtime.clearRoomId();
        setRooms([]);
        clearSnapshot();
        setError(undefined);
        setPhase('signed-out', initialRelicDiagnostics(undefined));
    }, [clearSnapshot, closeSubscriptions, runtime, setPhase]);

    useEffect(() => {
        return runtime.onAuthChange((state) => {
            if (state.authenticated) {
                setSession(state.session);
                return;
            }

            resetForSignedOutAuth();
        });
    }, [resetForSignedOutAuth, runtime]);

    const acceptSnapshotFromSource = useCallback((
        value: unknown,
        source: RelicSnapshotSource,
    ) => {
        const next = isRelicServerEvent(value) ? value.snapshot : value;
        if (!isRelicSnapshot(next)) {
            return;
        }
        if (source === 'rallar-rtc' && (!roomIdRef.current || next.roomId !== roomIdRef.current)) {
            return;
        }

        acceptSnapshotCandidate(next, source);
    }, [acceptSnapshotCandidate]);

    const acceptWsSnapshot = useCallback((value: unknown) => {
        acceptSnapshotFromSource(value, 'rallar-ws');
    }, [acceptSnapshotFromSource]);

    const acceptRtcSnapshot = useCallback((value: unknown) => {
        acceptSnapshotFromSource(value, 'rallar-rtc');
    }, [acceptSnapshotFromSource]);

    const hydrateSnapshotForRoom = useCallback(async (nextRoomId: string) => {
        const requestId = ++roomSnapshotRequestRef.current;
        try {
            const next = await runtime.fetchSnapshot(nextRoomId);
            if (requestId === roomSnapshotRequestRef.current) {
                const accepted = next
                    ? acceptSnapshotCandidate(next, 'room-hydration', nextRoomId)
                    : false;
                if (next) {
                    if (!accepted && snapshotRef.current?.roomId !== nextRoomId) {
                        clearSnapshot();
                    }
                } else {
                    clearSnapshot();
                }
                setDiagnostics((prev) => ({ ...prev, lastError: undefined }));
            }
        } catch (err) {
            if (requestId === roomSnapshotRequestRef.current) {
                setError(toErrorMessage(err));
                setPhase('degraded', {
                    lastError: toErrorMessage(err),
                    snapshotReady: false,
                });
            }
        }
    }, [acceptSnapshotCandidate, clearSnapshot, runtime, setPhase]);

    const repairTimedOutRoundSnapshot = useCallback(async (nextRoomId: string) => {
        try {
            const next = await runtime.fetchSnapshot(nextRoomId);
            if (next) {
                acceptSnapshotCandidate(next, 'timeout-repair', nextRoomId);
            }
        } catch (err) {
            setDiagnostics((prev) => ({
                ...prev,
                lastError: `Timed-out round snapshot repair failed: ${toErrorMessage(err)}`,
            }));
        }
    }, [acceptSnapshotCandidate, runtime]);

    const applyRoomState = useCallback((state: RallarRoomState) => {
        const nextRoomId = state.currentRoomId;
        const previousRoomId = roomIdRef.current;
        roomIdRef.current = nextRoomId;
        setRooms(state.rooms);
        setRoomId(nextRoomId);
        setDiagnostics((prev) => ({
            ...prev,
            roomReady: !!nextRoomId,
            roomId: nextRoomId,
            rtcReady: prev.middlewareConnected && !!nextRoomId,
        }));

        if (!nextRoomId) {
            clearSnapshot();
            return;
        }

        if (nextRoomId !== previousRoomId) {
            clearSnapshot();
            void hydrateSnapshotForRoom(nextRoomId);
        }
    }, [clearSnapshot, hydrateSnapshotForRoom]);

    const connectAndHydrate = useCallback(async () => {
        const restored = runtime.restoreSession();
        closeSubscriptions();

        if (!restored) {
            setSession(undefined);
            setRooms([]);
            setRoomId(undefined);
            roomIdRef.current = undefined;
            clearSnapshot();
            setError(undefined);
            setPhase('signed-out', initialRelicDiagnostics(undefined));
            return;
        }

        setSession(restored);
        setError(undefined);
        setPhase('connecting', {
            authenticated: true,
            middlewareConnected: false,
            roomReady: false,
            snapshotReady: false,
            wsListenerReady: false,
            roomListenerReady: false,
            rtcReady: false,
            authorityReady: false,
            authorityPhase: undefined,
            authorityPeerAssistReadyPeers: 0,
            lastError: undefined,
        });

        try {
            const hydration = await runtime.connectAndHydrate(
                acceptWsSnapshot,
                applyRoomState,
                acceptRtcSnapshot,
            );
            if (!hydration) {
                setPhase('signed-out', initialRelicDiagnostics(undefined));
                return;
            }

            unsubscribeRef.current = hydration.unsubscribe;
            setSession(hydration.session);
            setRooms(hydration.roomState.rooms);
            setRoomId(hydration.roomState.currentRoomId);
            roomIdRef.current = hydration.roomState.currentRoomId;
            const snapshotAccepted = hydration.snapshot
                ? acceptSnapshotCandidate(
                    hydration.snapshot,
                    'bootstrap',
                    hydration.roomState.currentRoomId,
                )
                : false;
            if (!hydration.snapshot ||
                (hydration.roomState.currentRoomId &&
                    !snapshotAccepted &&
                    snapshotRef.current?.roomId !== hydration.roomState.currentRoomId)) {
                clearSnapshot();
            }
            const ready = !!hydration.roomState.currentRoomId && snapshotAccepted;
            setPhase(hydration.degradedError ? 'degraded' : ready ? 'ready' : 'connected', {
                authenticated: true,
                middlewareConnected: true,
                roomReady: !!hydration.roomState.currentRoomId,
                snapshotReady: snapshotAccepted,
                wsListenerReady: hydration.snapshotListenerReady,
                rtcReady: !!hydration.roomState.currentRoomId,
                roomListenerReady: hydration.roomListenerReady,
                authorityReady: hydration.authorityListenerReady &&
                    !!hydration.roomState.currentRoomId &&
                    !!runtime.authorityStatus()?.started,
                authorityPhase: runtime.authorityStatus()?.phase,
                authorityPeerAssistReadyPeers:
                    runtime.authorityStatus()?.peerAssist.readyPeerIds.length ?? 0,
                roomId: hydration.roomState.currentRoomId,
                lastHydratedAtEpochMs: Date.now(),
                lastError: hydration.degradedError,
            });
            if (hydration.degradedError) {
                setError(hydration.degradedError);
            }
        } catch (err) {
            const message = toErrorMessage(err);
            setError(message);
            setPhase('error', {
                authenticated: true,
                middlewareConnected: false,
                roomReady: false,
                snapshotReady: false,
                wsListenerReady: false,
                roomListenerReady: false,
                rtcReady: false,
                authorityReady: false,
                authorityPhase: undefined,
                authorityPeerAssistReadyPeers: 0,
                lastError: message,
            });
        }
    }, [
        acceptRtcSnapshot,
        acceptSnapshotCandidate,
        acceptWsSnapshot,
        applyRoomState,
        clearSnapshot,
        closeSubscriptions,
        runtime,
        setPhase,
    ]);

    useEffect(() => {
        void connectAndHydrate();
        return () => {
            closeSubscriptions();
        };
    }, [closeSubscriptions, connectAndHydrate]);

    useEffect(() => {
        if (!diagnostics.rtcReady) {
            return;
        }

        const intervalId = window.setInterval(() => {
            const current = snapshotRef.current;
            if (!current || current.roomId !== roomIdRef.current) {
                return;
            }

            void runtime.publishRtcSnapshot(current).catch((err) => {
                setDiagnostics((prev) => ({
                    ...prev,
                    lastError: `RTC snapshot sync failed: ${toErrorMessage(err)}`,
                }));
            });
        }, RTC_SNAPSHOT_REPAIR_INTERVAL_MS);

        return () => window.clearInterval(intervalId);
    }, [diagnostics.rtcReady, runtime]);

    useEffect(() => {
        const current = snapshotRef.current;
        if (!current || !roomIdRef.current || current.roomId !== roomIdRef.current) {
            return;
        }

        const repair = toTimedOutRoundRepair(current);
        if (!repair) {
            return;
        }

        let cancelled = false;
        let timeoutId: number | undefined;
        let intervalId: number | undefined;

        const poll = () => {
            if (cancelled) {
                return;
            }
            void repairTimedOutRoundSnapshot(repair.roomId);
        };
        const startPolling = () => {
            poll();
            intervalId = window.setInterval(
                poll,
                ROUND_TIMEOUT_SNAPSHOT_REPAIR_INTERVAL_MS,
            );
        };
        const delayMs = repair.deadlineEpochMs - Date.now();
        if (delayMs <= 0) {
            startPolling();
        } else {
            timeoutId = window.setTimeout(startPolling, delayMs);
        }

        return () => {
            cancelled = true;
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }
            if (intervalId !== undefined) {
                window.clearInterval(intervalId);
            }
        };
    }, [repairTimedOutRoundSnapshot, timedOutRoundRepairKey]);

    const refreshRooms = useCallback(async () => {
        const state = await runtime.refreshRooms();
        applyRoomState(state);
    }, [applyRoomState, runtime]);

    const login = useCallback(async (username: string, password: string) => {
        closeSubscriptions();
        setError(undefined);
        setPhase('authenticating', {
            authenticated: false,
            middlewareConnected: false,
            lastError: undefined,
        });
        try {
            setSession(await runtime.login(username, password));
            await connectAndHydrate();
        } catch (err) {
            const message = toErrorMessage(err);
            setError(message);
            setPhase('error', { lastError: message });
        }
    }, [closeSubscriptions, connectAndHydrate, runtime, setPhase]);

    const register = useCallback(async (
        username: string,
        password: string,
        displayName?: string,
    ) => {
        closeSubscriptions();
        setError(undefined);
        setPhase('authenticating', {
            authenticated: false,
            middlewareConnected: false,
            lastError: undefined,
        });
        try {
            setSession(await runtime.register(username, password, displayName));
            await connectAndHydrate();
        } catch (err) {
            const message = toErrorMessage(err);
            setError(message);
            setPhase('error', { lastError: message });
        }
    }, [closeSubscriptions, connectAndHydrate, runtime, setPhase]);

    const logout = useCallback(async () => {
        closeSubscriptions();
        await runtime.logout();
        resetForSignedOutAuth();
    }, [closeSubscriptions, resetForSignedOutAuth, runtime]);

    const hydrateRoom = useCallback(async (work: () => Promise<{
        roomId: string;
        roomState: RallarRoomState;
        snapshot?: RelicPublicSnapshot;
    }>) => {
        setError(undefined);
        setPhase('joining-room', {
            lastError: undefined,
            roomReady: false,
            snapshotReady: false,
        });
        try {
            const result = await work();
            setRoomId(result.roomId);
            setRooms(result.roomState.rooms);
            roomIdRef.current = result.roomId;
            const snapshotAccepted = result.snapshot
                ? acceptSnapshotCandidate(result.snapshot, 'room-hydration', result.roomId)
                : false;
            if (!result.snapshot ||
                (!snapshotAccepted && snapshotRef.current?.roomId !== result.roomId)) {
                clearSnapshot();
            }
            setPhase(snapshotAccepted ? 'ready' : 'degraded', {
                middlewareConnected: true,
                roomReady: true,
                snapshotReady: snapshotAccepted,
                rtcReady: true,
                authorityReady: !!runtime.authorityStatus()?.started,
                authorityPhase: runtime.authorityStatus()?.phase,
                authorityPeerAssistReadyPeers:
                    runtime.authorityStatus()?.peerAssist.readyPeerIds.length ?? 0,
                roomId: result.roomId,
                lastHydratedAtEpochMs: Date.now(),
                lastError: snapshotAccepted ? undefined : 'No current relic snapshot accepted for room.',
            });
        } catch (err) {
            const message = toErrorMessage(err);
            setError(message);
            setPhase('error', { lastError: message });
        }
    }, [acceptSnapshotCandidate, clearSnapshot, setPhase]);

    const createRoom = useCallback(async () => {
        await hydrateRoom(() => runtime.createRoom(rooms.map((room) => room.name)));
    }, [hydrateRoom, rooms, runtime]);

    const joinRoom = useCallback(async (nextRoomId: string) => {
        await hydrateRoom(() => runtime.joinRoom(nextRoomId));
    }, [hydrateRoom, runtime]);

    const sendCommand = useCallback(async (
        input: RelicCommandDraft,
    ) => {
        const currentSession = sessionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!currentSession || !currentRoomId) {
            return;
        }

        const commandKey = commandInFlightKey(input);
        if (commandInFlightRef.current === commandKey) {
            return;
        }

        commandInFlightRef.current = commandKey;
        setError(undefined);
        setDiagnostics((prev) => ({
            ...prev,
            commandInFlight: commandKey,
            lastError: undefined,
        }));

        try {
            const next = await runtime.sendCommand(currentSession, currentRoomId, input);
            if (next) {
                acceptSnapshotCandidate(next, 'rest-command', currentRoomId);
            }
            const snapshotReady = !!snapshotRef.current;
            setPhase(snapshotReady ? 'ready' : 'degraded', {
                snapshotReady,
                lastHydratedAtEpochMs: Date.now(),
                lastError: next ? undefined : 'No relic snapshot returned for command.',
            });
        } catch (err) {
            const message = toErrorMessage(err);
            if (
                input.kind === 'continue-review' &&
                message.includes('There is no review to continue') &&
                snapshotRef.current?.phase !== 'review'
            ) {
                setPhase('ready', {
                    snapshotReady: !!snapshotRef.current,
                    lastError: undefined,
                });
                return;
            }
            setError(message);
            setPhase('degraded', { lastError: message });
        } finally {
            commandInFlightRef.current = undefined;
            setDiagnostics((prev) => ({
                ...prev,
                commandInFlight: undefined,
            }));
        }
    }, [acceptSnapshotCandidate, runtime, setPhase]);

    const joinExpedition = useCallback(async (characterId?: RelicCharacterId) => {
        await sendCommand({ kind: 'join-expedition', characterId });
    }, [sendCommand]);

    const startExpedition = useCallback(async () => {
        await sendCommand({ kind: 'start-expedition' });
    }, [sendCommand]);

    const submitAction = useCallback(async (action: RelicActionInput) => {
        await sendCommand({
            kind: 'submit-action',
            action,
        });
    }, [sendCommand]);

    const forceResolveRound = useCallback(async () => {
        await sendCommand({ kind: 'force-resolve-round' });
    }, [sendCommand]);

    const pickupRelic = useCallback(async (relicId: string) => {
        await sendCommand({ kind: 'pickup-relic', relicId });
    }, [sendCommand]);

    const continueReview = useCallback(async () => {
        if (snapshotRef.current?.phase !== 'review') {
            return;
        }
        await sendCommand({ kind: 'continue-review' });
    }, [sendCommand]);

    const setRoundLimit = useCallback(async (timeLimitMs: number) => {
        await sendCommand({ kind: 'set-round-limit', timeLimitMs });
    }, [sendCommand]);

    const resetExpedition = useCallback(async () => {
        const currentRoomId = roomIdRef.current;
        if (!currentRoomId) {
            return;
        }

        setError(undefined);
        try {
            const next = await runtime.resetExpedition(currentRoomId);
            if (next) {
                acceptSnapshotCandidate(next, 'rest-reset', currentRoomId);
            }
            const snapshotReady = !!snapshotRef.current;
            setPhase(snapshotReady ? 'ready' : 'degraded', {
                snapshotReady,
                lastHydratedAtEpochMs: Date.now(),
                lastError: next ? undefined : 'No relic snapshot returned for reset.',
            });
        } catch (err) {
            const message = toErrorMessage(err);
            setError(message);
            setPhase('degraded', { lastError: message });
        }
    }, [acceptSnapshotCandidate, runtime, setPhase]);

    return useMemo(() => ({
        session,
        connectionState,
        diagnostics,
        error,
        roomId,
        rooms,
        snapshot,
        login,
        register,
        logout,
        refreshRooms,
        createRoom,
        joinRoom,
        joinExpedition,
        startExpedition,
        submitAction,
        forceResolveRound,
        pickupRelic,
        continueReview,
        setRoundLimit,
        resetExpedition,
    }), [
        session,
        connectionState,
        diagnostics,
        error,
        roomId,
        rooms,
        snapshot,
        login,
        register,
        logout,
        refreshRooms,
        createRoom,
        joinRoom,
        joinExpedition,
        startExpedition,
        submitAction,
        forceResolveRound,
        pickupRelic,
        continueReview,
        setRoundLimit,
        resetExpedition,
    ]);
}

function isRelicServerEvent(value: unknown): value is RelicServerEvent {
    return typeof value === 'object' &&
        value !== null &&
        'snapshot' in value;
}

function commandInFlightKey(input: RelicCommandDraft): string {
    if (input.kind === 'submit-action') {
        return `${input.kind}:${JSON.stringify(input.action)}`;
    }
    if (input.kind === 'pickup-relic') {
        return `${input.kind}:${input.relicId}`;
    }

    return input.kind;
}

function summarizeRuntimeSnapshot(
    snapshot: RelicPublicSnapshot,
    source: RelicSnapshotSource,
) {
    return {
        source,
        gameId: snapshot.gameId,
        roomId: snapshot.roomId,
        phase: snapshot.phase,
        round: snapshot.round,
        updatedAtEpochMs: snapshot.updatedAtEpochMs,
        playerCount: snapshot.players.length,
        submittedCount: snapshot.submittedPlayerIds.length,
        eventCount: snapshot.events.length,
        roomInvestigationCount: snapshot.roomInvestigations.length,
    };
}

function toTimedOutRoundRepairKey(snapshot: RelicPublicSnapshot): string {
    const repair = toTimedOutRoundRepair(snapshot);
    return repair
        ? [
            repair.roomId,
            repair.round,
            repair.deadlineEpochMs,
            repair.activePlayerCount,
            repair.submittedPlayerCount,
        ].join(':')
        : 'none';
}

function toTimedOutRoundRepair(snapshot: RelicPublicSnapshot):
    | Readonly<{
        roomId: string;
        round: number;
        deadlineEpochMs: number;
        activePlayerCount: number;
        submittedPlayerCount: number;
    }>
    | undefined {
    if (snapshot.phase !== 'planning' || snapshot.roundStartedAtEpochMs === undefined) {
        return undefined;
    }

    const activePlayerCount = snapshot.players.filter((player) =>
        !player.escaped && !player.defeated
    ).length;
    const submittedPlayerCount = snapshot.submittedPlayerIds.length;
    if (activePlayerCount === 0 || submittedPlayerCount >= activePlayerCount) {
        return undefined;
    }

    return {
        roomId: snapshot.roomId,
        round: snapshot.round,
        deadlineEpochMs: snapshot.roundStartedAtEpochMs + snapshot.roundTimeLimitMs,
        activePlayerCount,
        submittedPlayerCount,
    };
}
