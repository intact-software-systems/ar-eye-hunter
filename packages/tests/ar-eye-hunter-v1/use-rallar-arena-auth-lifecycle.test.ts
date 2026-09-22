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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRallarGameEnvelope } from '@shared-web/game/mod.ts';

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
        const diagnosticsBeforeResolve = arena.current?.gameDiagnostics;

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
        expect(arena.current?.gameDiagnostics).toBe(diagnosticsBeforeResolve);
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

    it('creates a new arena by switching rooms and clearing stale remote players', async () => {
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
            displayName: expect.stringContaining('AR Eye Hunter Arena:')
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
