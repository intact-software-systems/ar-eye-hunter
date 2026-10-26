// @vitest-environment happy-dom
import {
    ArenaRuntimeTestHarness,
    arenaSnapshot,
    emitAuthState,
    freshDirectorStatus,
    mockMatch,
    mockRallar,
    session,
    waitForState
} from './arena-runtime-test-harness.ts';

import { act } from 'react';

import { readApiConfig, readIceCandidates } from '@shared-web/browser/connection/connection-http-api.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createRallarGameEnvelope } from '@shared-web/game/mod.ts';
import type {
    GroupDirectoryEntry,
    GroupDirectoryPage,
    GroupDirectoryRequest
} from '@shared/api/group-directory/group-directory-types.ts';

import { createArenaRallarGameMatch } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import { createInitialVitalsState } from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';

describe('useRallarArena auth lifecycle', () => {
    const arena = new ArenaRuntimeTestHarness();
    beforeEach(() => arena.reset());
    afterEach(() => arena.dispose());

    it('clears arena state when auth expires outside manual logout', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');

        expect(arena.current?.session).toEqual(session);
        expect(arena.current?.roomId).toBe('arena-1');
        expect(arena.current?.rooms).toHaveLength(1);

        await emitAuthState({
            authenticated: false,
            reason: 'expired'
        });

        expect(arena.current?.session).toBeUndefined();
        expect(arena.current?.connectionState).toBe('signed-out');
        expect(arena.current?.roomId).toBeUndefined();
        expect(arena.current?.rooms).toEqual([]);
        expect(arena.current?.arenaSnapshot).toBeUndefined();
        expect(arena.current?.remotePlayers.size).toBe(0);
        expect(arena.current?.remoteEvents).toEqual([]);
        expect(arena.current?.remoteShots).toEqual([]);
        expect(arena.current?.remotePlayerHits).toEqual([]);
        expect(arena.current?.pickupAcceptances).toEqual([]);
        expect(mockRallar.auth.logout).not.toHaveBeenCalled();
    });

    it('catches manual logout rejection and leaves the arena signed out', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        mockRallar.auth.logout.mockRejectedValueOnce(new Error('logout failed'));

        await act(async () => {
            await expect(arena.current?.logout()).resolves.toBeUndefined();
        });

        expect(mockRallar.auth.logout).toHaveBeenCalledOnce();
        expect(arena.current?.session).toBeUndefined();
        expect(arena.current?.connectionState).toBe('signed-out');
        expect(arena.current?.roomId).toBeUndefined();
        expect(arena.current?.rooms).toEqual([]);
        expect(arena.current?.arenaSnapshot).toBeUndefined();
        expect(arena.current?.remotePlayers.size).toBe(0);
        expect(arena.current?.remoteEvents).toEqual([]);
    });

    it('disables network immediately while manual logout revoke is pending', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const logout = Promise.withResolvers<void>();
        mockRallar.auth.logout.mockReturnValueOnce(logout.promise);
        const connectedConnection = arena.current;
        let logoutPromise: Promise<void> | undefined;

        await act(async () => {
            logoutPromise = connectedConnection?.logout();
            await Promise.resolve();
        });

        expect(mockRallar.auth.logout).toHaveBeenCalledOnce();
        expect(arena.current?.connectionState).toBe('signed-out');
        expect(arena.current?.networkEnabled).toBe(false);
        expect(arena.current?.session).toBeUndefined();
        expect(arena.current?.roomId).toBeUndefined();
        expect(mockMatch.stop).toHaveBeenCalled();

        await act(async () => {
            logout.resolve();
            await logoutPromise;
        });
    });

    it.each(
        [
            { mode: 'login', revoke: 'success' },
            { mode: 'login', revoke: 'failure' },
            { mode: 'register', revoke: 'success' },
            { mode: 'register', revoke: 'failure' }
        ] as const
    )('keeps a replacement $mode session after pending logout $revoke', async ({ mode, revoke }) => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const pendingRevoke = Promise.withResolvers<void>();
        const replacement = { ...session, clientId: 'hunter-2', sessionId: 'replacement-session' };
        mockRallar.auth.logout.mockImplementationOnce(async () => {
            try {
                await pendingRevoke.promise;
            }
            finally {
                await emitAuthState({ authenticated: false, reason: 'logout' });
            }
        });
        mockRallar.auth[mode === 'login' ? 'login' : 'registerAndLogin'].mockImplementationOnce(async () => {
            mockRallar.session.mockReturnValue(replacement);
            return replacement;
        });
        mockRallar.start.mockResolvedValueOnce({ session: replacement, connected: true });
        let logout: Promise<void> | undefined;
        let authentication: Promise<void> | undefined;
        await act(async () => {
            logout = arena.current?.logout();
        });
        await act(async () => {
            authentication = arena.current?.[mode]('replacement', 'password');
        });
        const sessionWhileLogoutPending = arena.current?.session;
        await act(async () => {
            if (revoke === 'success') {
                pendingRevoke.resolve();
            }
            else {
                pendingRevoke.reject(new Error('revocation unavailable'));
            }
            await logout;
            await authentication;
        });
        expect(arena.current?.session).toEqual(replacement);
        expect(arena.current?.connectionState).toBe('connected');
        expect(sessionWhileLogoutPending).toBeUndefined();
        mockRallar.rooms.directory.mockResolvedValueOnce({ entries: [directoryArena('replacement-room')], nextCursor: null });
        await act(async () => {
            await arena.current?.refreshRooms();
        });
        expect(arena.current?.openRooms.map((room) => room.groupRef.groupId)).toEqual(['replacement-room']);
        expect(arena.current?.openRoomsStatus).toBe('ready');
    });

    it('blocks stale canvas callbacks while manual logout revoke is pending', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const logout = Promise.withResolvers<void>();
        mockRallar.auth.logout.mockReturnValueOnce(logout.promise);
        const connectedConnection = arena.current;
        let logoutPromise: Promise<void> | undefined;

        await act(async () => {
            logoutPromise = connectedConnection?.logout();
            await Promise.resolve();
        });

        mockMatch.publishEvent.mockClear();
        mockMatch.publishSnapshot.mockClear();
        mockMatch.sendIntent.mockClear();
        mockMatch.sendInput.mockClear();
        mockMatch.sendPresence.mockClear();
        mockRallar.realtime.room.mockClear();
        mockRallar.realtime.sendJson.mockClear();

        const fullShot = {
            sessionId: session.sessionId,
            username: session.username,
            color: '#00ffaa',
            origin: [0, 1.5, 0] as const,
            direction: [0, 0, 1] as const,
            weaponKind: 'pulse-rifle' as const,
            seq: 1,
            sentAtEpochMs: 5_000
        };
        await act(async () => {
            connectedConnection?.sendPose({
                position: [1, 2, 3],
                rotation: [0, 0.5, 0],
                score: 12,
                seq: 8,
                sentAtEpochMs: 456,
                vitals: createInitialVitalsState()
            });
            connectedConnection?.sendShot(
                {
                    origin: fullShot.origin,
                    direction: fullShot.direction,
                    weaponKind: fullShot.weaponKind,
                    seq: fullShot.seq,
                    sentAtEpochMs: fullShot.sentAtEpochMs
                },
                {
                    shot: fullShot,
                    hit: false,
                    impact: [0, 1.5, 8],
                    scoreDelta: 0,
                    combo: 0,
                    multiplier: 1,
                    overdrive: 0,
                    revision: 1,
                    acceptedAtEpochMs: 5_000
                }
            );
            connectedConnection?.publishArenaSnapshot(arenaSnapshot(99));
        });

        expect(mockMatch.publishEvent).not.toHaveBeenCalled();
        expect(mockMatch.publishSnapshot).not.toHaveBeenCalled();
        expect(mockMatch.sendIntent).not.toHaveBeenCalled();
        expect(mockMatch.sendInput).not.toHaveBeenCalled();
        expect(mockMatch.sendPresence).not.toHaveBeenCalled();
        expect(mockRallar.realtime.room).not.toHaveBeenCalled();
        expect(mockRallar.realtime.sendJson).not.toHaveBeenCalled();

        await act(async () => {
            logout.resolve();
            await logoutPromise;
        });
    });

    it('does not probe diagnostics transports after logout', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');

        await act(async () => {
            await arena.current?.logout();
        });

        vi.mocked(readApiConfig).mockClear();
        vi.mocked(readIceCandidates).mockClear();
        mockRallar.rtc.diagnostics.mockClear();
        mockRallar.rtc.waitForRoomLane.mockClear();

        await act(async () => {
            await arena.current?.refreshDiagnostics({ includeRtcStats: true });
        });

        expect(readApiConfig).not.toHaveBeenCalled();
        expect(readIceCandidates).not.toHaveBeenCalled();
        expect(mockRallar.rtc.diagnostics).not.toHaveBeenCalled();
        expect(mockRallar.rtc.waitForRoomLane).not.toHaveBeenCalled();
        expect(arena.current?.connectionState).toBe('signed-out');
        expect(arena.current?.httpDiagnostics.apiConfig.status).toBe('idle');
        expect(arena.current?.httpDiagnostics.ice.status).toBe('idle');
    });

    it('aborts in-flight RTC lane waits when the current room clears', async () => {
        const roomChangeListeners = new Set<
            (state: {
                rooms: [];
                currentRoomId?: string;
                currentRoomRef?: undefined;
            }) => void
        >();
        const waitSignals: AbortSignal[] = [];
        mockRallar.rooms.onChange.mockImplementation((listener) => {
            roomChangeListeners.add(listener);
            return () => roomChangeListeners.delete(listener);
        });
        mockRallar.rtc.waitForRoomLane.mockImplementation(
            (_room, _lane, options?: { signal?: AbortSignal; }) => {
                if (options?.signal) {
                    waitSignals.push(options.signal);
                }
                return new Promise(() => undefined);
            }
        );

        await arena.render();
        await waitForState(() =>
            arena.current?.connectionState === 'connected' &&
            roomChangeListeners.size > 0 &&
            waitSignals.length > 0
        );

        expect(waitSignals[0].aborted).toBe(false);

        await act(async () => {
            for (const listener of roomChangeListeners) {
                listener({
                    rooms: [],
                    currentRoomId: undefined,
                    currentRoomRef: undefined
                });
            }
        });
        await waitForState(() => arena.current?.roomId === undefined);

        expect(waitSignals[0].aborted).toBe(true);
    });

    it('ignores a pending director appointment after the current room clears', async () => {
        const roomChangeListeners = new Set<
            (state: {
                rooms: [];
                currentRoomId?: string;
                currentRoomRef?: undefined;
            }) => void
        >();
        const appointment = Promise.withResolvers<Awaited<ReturnType<typeof mockMatch.appointIfElected>>>();
        mockRallar.rooms.onChange.mockImplementation((listener) => {
            roomChangeListeners.add(listener);
            return () => roomChangeListeners.delete(listener);
        });

        await arena.render();
        await waitForState(() =>
            arena.current?.connectionState === 'connected' &&
            roomChangeListeners.size > 0 &&
            arena.current.directorAttempt.status !== 'pending'
        );
        mockMatch.appointIfElected.mockClear();
        mockMatch.reportCapability.mockClear();
        mockMatch.appointIfElected.mockReturnValueOnce(appointment.promise);

        await act(async () => {
            arena.current?.appointSelfAsDirector();
            await Promise.resolve();
        });
        await waitForState(() => arena.current?.directorAttempt.status === 'pending');
        expect(arena.current?.gameDiagnostics).toBeDefined();

        await act(async () => {
            for (const listener of roomChangeListeners) {
                listener({
                    rooms: [],
                    currentRoomId: undefined,
                    currentRoomRef: undefined
                });
            }
        });
        await waitForState(() => arena.current?.roomId === undefined);

        await act(async () => {
            appointment.resolve({
                status: 'appointed',
                election: {
                    candidates: [],
                    nowEpochMs: 2,
                    capabilityTtlMs: 10_000
                },
                directorStatus: freshDirectorStatus()
            });
            await appointment.promise;
        });

        expect(arena.current?.roomId).toBeUndefined();
        expect(arena.current?.directorStatus.isDirector).toBe(false);
        expect(arena.current?.directorAttempt.status).toBe('pending');
        expect(arena.current?.gameDiagnostics).toBeUndefined();
    });

    it('ignores a startup result that resolves after logout', async () => {
        const startup = Promise.withResolvers<Awaited<ReturnType<typeof mockRallar.start>>>();
        mockRallar.start.mockReturnValueOnce(startup.promise);

        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connecting');

        await emitAuthState({
            authenticated: false,
            reason: 'logout'
        });

        await act(async () => {
            startup.resolve({
                session,
                connected: true,
                roomState: {
                    rooms: [
                        {
                            roomId: 'arena-1',
                            groupId: 'arena-1',
                            name: 'Arena: Vector Circuit'
                        }
                    ],
                    currentRoomId: 'arena-1'
                }
            });
            await startup.promise;
        });

        expect(arena.current?.session).toBeUndefined();
        expect(arena.current?.connectionState).toBe('signed-out');
        expect(arena.current?.roomId).toBeUndefined();
        expect(arena.current?.rooms).toEqual([]);
    });

    it('blocks stale canvas snapshot publication after logout', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');

        await act(async () => {
            await arena.current?.logout();
        });

        const signedOutConnection = arena.current;
        await act(async () => {
            signedOutConnection?.publishArenaSnapshot(arenaSnapshot(99));
        });

        expect(arena.current?.connectionState).toBe('signed-out');
        expect(arena.current?.arenaSnapshot).toBeUndefined();
        expect(mockMatch.publishSnapshot).not.toHaveBeenCalled();
    });

    it('blocks stale canvas combat callbacks after logout', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');

        await act(async () => {
            await arena.current?.logout();
        });

        const signedOutConnection = arena.current;
        mockMatch.publishEvent.mockClear();
        mockMatch.publishSnapshot.mockClear();
        mockMatch.sendIntent.mockClear();
        mockMatch.sendInput.mockClear();
        mockMatch.sendPresence.mockClear();
        mockRallar.realtime.room.mockClear();
        mockRallar.realtime.sendJson.mockClear();

        const fullShot = {
            sessionId: session.sessionId,
            username: session.username,
            color: '#00ffaa',
            origin: [0, 1.5, 0] as const,
            direction: [0, 0, 1] as const,
            weaponKind: 'pulse-rifle' as const,
            seq: 1,
            sentAtEpochMs: 5_000
        };

        await act(async () => {
            signedOutConnection?.sendShot(
                {
                    origin: fullShot.origin,
                    direction: fullShot.direction,
                    weaponKind: fullShot.weaponKind,
                    seq: fullShot.seq,
                    sentAtEpochMs: fullShot.sentAtEpochMs
                },
                {
                    shot: fullShot,
                    hit: false,
                    impact: [0, 1.5, 8],
                    scoreDelta: 0,
                    combo: 0,
                    multiplier: 1,
                    overdrive: 0,
                    revision: 1,
                    acceptedAtEpochMs: 5_000
                }
            );
            signedOutConnection?.sendPlayerHit({
                shot: fullShot,
                targetSessionId: 'target-session',
                targetSeq: 3,
                predictedImpact: [0, 1.5, 8],
                sentAtEpochMs: 5_001
            });
            signedOutConnection?.sendPickupIntent({
                pickupId: 'pickup-1',
                sessionId: session.sessionId,
                position: [0, 0, 1],
                seq: 1,
                sentAtEpochMs: 5_002
            });
        });

        expect(mockMatch.publishEvent).not.toHaveBeenCalled();
        expect(mockMatch.publishSnapshot).not.toHaveBeenCalled();
        expect(mockMatch.sendIntent).not.toHaveBeenCalled();
        expect(mockMatch.sendInput).not.toHaveBeenCalled();
        expect(mockMatch.sendPresence).not.toHaveBeenCalled();
        expect(mockRallar.realtime.room).not.toHaveBeenCalled();
        expect(mockRallar.realtime.sendJson).not.toHaveBeenCalled();
    });

    it('lists open arenas from the room directory when rooms refresh', async () => {
        const openArena = directoryArena('arena-9');
        mockRallar.rooms.directory.mockImplementation(async (request?: GroupDirectoryRequest) =>
            request?.kind === 'room' && request.q === 'eye hunter'
                ? { entries: [openArena], nextCursor: null }
                : { entries: [], nextCursor: null }
        );

        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        await act(async () => {
            await arena.current?.refreshRooms();
        });

        expect(arena.current?.openRooms).toEqual([openArena]);
        expect(arena.current?.openRoomsStatus).toBe('ready');
        expect(arena.current?.openRoomsError).toBeUndefined();
    });

    it('follows the directory cursor so the lobby is not truncated at one page', async () => {
        mockRallar.rooms.directory.mockImplementation(async (request?: GroupDirectoryRequest) =>
            request?.cursor === 'page-2'
                ? { entries: [directoryArena('arena-1'), directoryArena('arena-2')], nextCursor: null }
                : { entries: [directoryArena('arena-1')], nextCursor: 'page-2' }
        );

        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        await act(async () => {
            await arena.current?.refreshRooms();
        });

        expect(arena.current?.openRooms.map((room) => room.groupRef.groupId)).toEqual(['arena-1', 'arena-2']);
    });

    it('reports a directory failure instead of showing an empty lobby', async () => {
        mockRallar.rooms.directory.mockRejectedValue(new Error('directory unavailable'));

        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        await act(async () => {
            await arena.current?.refreshRooms();
        });

        expect(arena.current?.openRooms).toEqual([]);
        expect(arena.current?.openRoomsStatus).toBe('error');
        expect(arena.current?.openRoomsError).toBe('directory unavailable');
    });

    it.each(['success', 'failure'] as const)('restarts pagination and ignores the previous order result: %s', async (outcome) => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const older = Promise.withResolvers<GroupDirectoryPage>();
        const fast = { ...directoryArena('fast'), peerRttMs: 20 };
        const unmeasured = directoryArena('unknown');
        mockRallar.rooms.directory.mockReturnValueOnce(older.promise)
            .mockResolvedValueOnce({ entries: [fast], nextCursor: 'peer-page-2' })
            .mockResolvedValueOnce({ entries: [unmeasured], nextCursor: null });
        let previousRefresh: Promise<void> | undefined;
        await act(async () => {
            previousRefresh = arena.current?.refreshRooms();
        });
        await act(async () => {
            await arena.current?.changeDirectoryOrder('peer-rtt');
        });
        expect(mockRallar.rooms.directory.mock.calls.map(([request]) => request).filter((request) => request.order === 'peer-rtt')).toEqual([
            { kind: 'room', q: 'eye hunter', limit: 50, includeEmpty: false, order: 'peer-rtt' },
            { kind: 'room', q: 'eye hunter', limit: 50, includeEmpty: false, order: 'peer-rtt', cursor: 'peer-page-2' }
        ]);
        await act(async () => {
            if (outcome === 'success') {
                older.resolve({ entries: [directoryArena('obsolete')], nextCursor: 'old-page-2' });
            }
            else {
                older.reject(new Error('obsolete order failed'));
            }
            await previousRefresh;
        });
        expect(arena.current?.directoryOrder).toBe('peer-rtt');
        expect(arena.current?.openRooms).toEqual([fast, unmeasured]);
        expect(arena.current?.openRoomsStatus).toBe('ready');
        expect(arena.current?.openRoomsError).toBeUndefined();
        expect(mockRallar.rooms.directory.mock.calls.some(([request]) => request.cursor === 'old-page-2')).toBe(false);
    });

    it('keeps the chosen order after a failure and retries it on Refresh', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const measured = { ...directoryArena('z-measured'), peerRttMs: 25 };
        const unmeasured = directoryArena('a-unmeasured');
        mockRallar.rooms.directory.mockRejectedValueOnce(new Error('latency read unavailable'))
            .mockImplementation(async (request: GroupDirectoryRequest) => ({
                entries: request.order === 'peer-rtt' ? [measured, unmeasured] : [unmeasured, measured],
                nextCursor: null
            }));
        await act(async () => {
            await arena.current?.changeDirectoryOrder('peer-rtt');
        });
        expect(arena.current?.openRoomsStatus).toBe('error');
        expect(arena.current?.directoryOrder).toBe('peer-rtt');
        await act(async () => {
            await arena.current?.refreshRooms();
        });
        expect(arena.current?.openRooms).toEqual([measured, unmeasured]);
        expect(arena.current?.openRoomsStatus).toBe('ready');
        expect(arena.current?.openRoomsError).toBeUndefined();
    });

    it('shows automatic loading, reports an initial failure and permits a manual empty recovery', async () => {
        const pending = Promise.withResolvers<GroupDirectoryPage>();
        mockRallar.rooms.directory.mockReturnValueOnce(pending.promise);
        await arena.render();
        await waitForState(() => arena.current?.openRoomsStatus === 'loading');
        await act(async () => {
            pending.reject(new Error('directory unavailable'));
        });
        expect(arena.current?.openRoomsStatus).toBe('error');
        expect(arena.current?.openRooms).toEqual([]);
        await act(async () => {
            await arena.current?.refreshRooms();
        });
        expect(arena.current?.openRoomsStatus).toBe('ready');
        expect(arena.current?.openRooms).toEqual([]);
        expect(arena.current?.openRoomsError).toBeUndefined();
    });

    it('coalesces overlapping directory reads and allows a fresh read after completion', async () => {
        await arena.render();
        await waitForState(() => arena.current?.openRoomsStatus === 'ready');
        const pending = Promise.withResolvers<GroupDirectoryPage>();
        const shared = directoryArena('shared');
        mockRallar.rooms.directory.mockClear().mockReturnValueOnce(pending.promise);
        let first: Promise<void> | undefined;
        let second: Promise<void> | undefined;
        await act(async () => {
            first = arena.current?.refreshRooms();
        });
        await act(async () => {
            second = arena.current?.refreshRooms();
        });
        // Concurrent refreshes must share one network read instead of multiplying polling load.
        expect(mockRallar.rooms.directory).toHaveBeenCalledTimes(1);
        await act(async () => {
            pending.resolve({ entries: [shared], nextCursor: null });
            await Promise.all([first, second]);
        });
        expect(arena.current?.openRooms).toEqual([shared]);
        await act(async () => {
            await arena.current?.refreshRooms();
        });
        expect(arena.current?.openRooms).toEqual([]);
        expect(arena.current?.openRoomsStatus).toBe('ready');
    });

    it('fences owned-room state before the directory request as well as the directory result', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const older = Promise.withResolvers<{ rooms: []; currentRoomId: string; }>();
        mockRallar.rooms.refresh.mockReturnValueOnce(older.promise)
            .mockResolvedValueOnce({ rooms: [], currentRoomId: 'latest-room' });
        mockRallar.rooms.directory.mockResolvedValue({ entries: [directoryArena('latest')], nextCursor: null });
        let refresh: Promise<void> | undefined;
        await act(async () => {
            refresh = arena.current?.refreshRooms();
        });
        await act(async () => {
            await arena.current?.refreshRooms();
        });
        await act(async () => {
            older.resolve({ rooms: [], currentRoomId: 'obsolete-room' });
            await refresh;
        });
        expect(arena.current?.roomId).toBe('latest-room');
        expect(arena.current?.openRooms.map((room) => room.groupRef.groupId)).toEqual(['latest']);
        expect(arena.current?.openRoomsStatus).toBe('ready');
    });

    it.each([
        { outcome: 'success', transition: 'account replacement' },
        { outcome: 'failure', transition: 'account replacement' },
        { outcome: 'success', transition: 'logout and login' },
        { outcome: 'failure', transition: 'logout and login' }
    ])('ignores a pending directory $outcome after $transition', async ({ outcome, transition }) => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const pending = Promise.withResolvers<GroupDirectoryPage>();
        mockRallar.rooms.directory.mockReturnValueOnce(pending.promise);
        let refresh: Promise<void> | undefined;
        await act(async () => {
            refresh = arena.current?.refreshRooms();
        });
        if (transition === 'logout and login') {
            await emitAuthState({ authenticated: false, reason: 'expired' });
        }
        await emitAuthState({
            authenticated: true,
            reason: 'login',
            session: transition === 'account replacement' ? { ...session, sessionId: 'replacement-session' } : session
        });
        await act(async () => {
            if (outcome === 'success') {
                pending.resolve({ entries: [directoryArena('previous-account')], nextCursor: null });
            }
            else {
                pending.reject(new Error('previous account failed'));
            }
            await refresh;
        });
        expect(arena.current?.openRooms).toEqual([]);
        expect(arena.current?.openRoomsStatus).toBe(transition === 'account replacement' ? 'ready' : 'idle');
        expect(arena.current?.openRoomsError).toBeUndefined();
    });

    it.each(['success', 'failure'] as const)('keeps the signed-out directory idle after a pending %s', async (outcome) => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const pending = Promise.withResolvers<GroupDirectoryPage>();
        mockRallar.rooms.directory.mockReturnValueOnce(pending.promise);
        let refresh: Promise<void> | undefined;
        await act(async () => {
            refresh = arena.current?.refreshRooms();
        });
        await emitAuthState({ authenticated: false, reason: 'expired' });
        await act(async () => {
            if (outcome === 'success') {
                pending.resolve({ entries: [directoryArena('signed-out')], nextCursor: null });
            }
            else {
                pending.reject(new Error('signed-out failure'));
            }
            await refresh;
        });
        expect(arena.current?.openRooms).toEqual([]);
        expect(arena.current?.openRoomsStatus).toBe('idle');
        expect(arena.current?.openRoomsError).toBeUndefined();
    });

    it('retains the complete list after a later page fails and atomically replaces it on recovery', async () => {
        const previous = directoryArena('previous');
        mockRallar.rooms.directory.mockResolvedValueOnce({ entries: [previous], nextCursor: null });
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        await waitForState(() => arena.current?.openRoomsStatus === 'ready');
        const laterPage = Promise.withResolvers<GroupDirectoryPage>();
        mockRallar.rooms.directory.mockResolvedValueOnce({ entries: [directoryArena('partial')], nextCursor: 'next' })
            .mockReturnValueOnce(laterPage.promise);
        let refresh: Promise<void> | undefined;
        await act(async () => {
            refresh = arena.current?.refreshRooms();
        });
        expect(arena.current?.openRooms).toEqual([previous]);
        expect(arena.current?.openRoomsStatus).toBe('loading');
        await act(async () => {
            laterPage.reject(new Error('second page failed'));
            await refresh;
        });
        expect(arena.current?.openRooms).toEqual([previous]);
        expect(arena.current?.openRoomsStatus).toBe('error');
        expect(arena.current?.openRoomsError).toBe('second page failed');
        await act(async () => {
            await arena.current?.refreshRooms();
        });
        expect(arena.current?.openRooms).toEqual([]);
        expect(arena.current?.openRoomsStatus).toBe('ready');
        expect(arena.current?.openRoomsError).toBeUndefined();
    });

    it('reports an owned-room refresh failure and permits a subsequent directory refresh', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        mockRallar.rooms.refresh.mockRejectedValueOnce(new Error('rooms unavailable'));
        await act(async () => {
            await arena.current?.refreshRooms();
        });
        expect(arena.current?.openRoomsStatus).toBe('error');
        expect(arena.current?.openRoomsError).toBe('rooms unavailable');
        await act(async () => {
            await arena.current?.refreshRooms();
        });
        expect(arena.current?.openRoomsStatus).toBe('ready');
    });

    it('creates a temporary arena by switching rooms and clearing stale remote players', async () => {
        mockRallar.rooms.createAndSwitch.mockResolvedValue({
            group: {
                groupId: 'arena-2'
            }
        });
        mockRallar.rooms.refresh.mockResolvedValue({
            rooms: [
                {
                    roomId: 'arena-2',
                    name: 'Arena: Hyper Prism'
                }
            ],
            currentRoomId: 'arena-2'
        });

        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');

        await act(async () => {
            await vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0].onPresence?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'presence',
                roomId: 'arena-1',
                senderId: 'peer-1',
                seq: 1,
                directorEpoch: 0,
                sentAtEpochMs: 123,
                payload: {
                    protocol: 'ar-eye-hunter.v1',
                    kind: 'player-pose',
                    pose: {
                        sessionId: 'peer-1',
                        username: 'old-room-peer',
                        color: '#00ffaa',
                        position: [1, 2, 3],
                        rotation: [0, 0.5, 0],
                        velocity: [0, 0, 0],
                        score: 4,
                        combo: 0,
                        seq: 1,
                        sentAtEpochMs: 123
                    }
                }
            }));
        });
        await waitForState(() => arena.current?.remotePlayers.size === 1);

        await act(async () => {
            await arena.current?.createArenaRoom();
        });

        expect(mockRallar.rooms.createAndSwitch).toHaveBeenCalledWith({
            displayName: expect.stringContaining('AR Eye Hunter Arena:'),
            joinMode: 'open',
            retention: { mode: 'temporary', reconnectGraceMs: 600_000 }
        });
        expect(mockRallar.rooms.create).not.toHaveBeenCalled();
        expect(arena.current?.roomId).toBe('arena-2');
        expect(arena.current?.remotePlayers.size).toBe(0);
        expect(arena.current?.remoteEvents).toEqual([]);
        expect(arena.current?.remoteShots).toEqual([]);
        expect(arena.current?.pickupAcceptances).toEqual([]);
    });

    it('keeps diagnostics refresh stable after updating diagnostics state', async () => {
        await arena.render();
        await waitForState(() => arena.current?.connectionState === 'connected');
        const refreshDiagnostics = arena.current?.refreshDiagnostics;

        await act(async () => {
            await refreshDiagnostics?.({ includeRtcStats: true });
        });

        expect(arena.current?.transportDiagnostics.rtcDiagnostics?.connectedPeerCount).toBe(1);
        expect(arena.current?.refreshDiagnostics).toBe(refreshDiagnostics);
    });
});

function directoryArena(groupId: string): GroupDirectoryEntry {
    return {
        groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId },
        displayName: `AR Eye Hunter Arena: ${groupId}`,
        kind: 'room',
        joinMode: 'open',
        memberCount: 1,
        onlineMemberCount: 1,
        maxMembers: 256,
        isFull: false,
        lifecycleState: 'forming',
        peerRttMs: null
    };
}
