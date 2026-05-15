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
    type RelicSnapshotSource,
    shouldAcceptRelicSnapshot,
} from './relic-snapshot-ordering.ts';

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
        }));
    }, [roomId]);

    useEffect(() => {
        snapshotRef.current = snapshot;
        setDiagnostics((prev) => ({
            ...prev,
            snapshotReady: !!snapshot,
            rtcReady: prev.middlewareConnected && !!roomIdRef.current,
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

    const acceptSnapshotCandidate = useCallback((
        next: RelicPublicSnapshot,
        source: RelicSnapshotSource,
        expectedRoomId = roomIdRef.current,
    ): boolean => {
        if (!shouldAcceptRelicSnapshot({
            current: snapshotRef.current,
            candidate: next,
            expectedRoomId,
        })) {
            setDiagnostics((prev) => ({
                ...prev,
                ignoredSnapshotCount: prev.ignoredSnapshotCount + 1,
            }));
            return false;
        }

        snapshotRef.current = next;
        setSnapshot(next);
        setDiagnostics((prev) => ({
            ...prev,
            snapshotReady: true,
            lastSnapshotSource: source,
            lastHydratedAtEpochMs: Date.now(),
        }));
        return true;
    }, []);

    const closeSubscriptions = useCallback(() => {
        unsubscribeRef.current?.();
        unsubscribeRef.current = undefined;
        setDiagnostics((prev) => ({
            ...prev,
            wsListenerReady: false,
            roomListenerReady: false,
            rtcReady: false,
        }));
    }, []);

    const acceptSnapshot = useCallback((value: unknown) => {
        const next = isRelicServerEvent(value) ? value.snapshot : value;
        if (!isRelicSnapshot(next)) {
            return;
        }

        acceptSnapshotCandidate(next, 'rallar-ws');
    }, [acceptSnapshotCandidate]);

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
            lastError: undefined,
        });

        try {
            const hydration = await runtime.connectAndHydrate(
                acceptSnapshot,
                applyRoomState,
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
                roomListenerReady: hydration.roomListenerReady,
                rtcReady: !!hydration.roomState.currentRoomId,
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
                lastError: message,
            });
        }
    }, [
        acceptSnapshot,
        acceptSnapshotCandidate,
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
        commandInFlightRef.current = undefined;
        setSession(undefined);
        setRoomId(undefined);
        roomIdRef.current = undefined;
        setRooms([]);
        clearSnapshot();
        setError(undefined);
        setPhase('signed-out', initialRelicDiagnostics(undefined));
    }, [clearSnapshot, closeSubscriptions, runtime, setPhase]);

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
        await hydrateRoom(() => runtime.createRoom());
    }, [hydrateRoom, runtime]);

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
    if (input.kind !== 'submit-action') {
        return input.kind;
    }

    return `${input.kind}:${JSON.stringify(input.action)}`;
}
