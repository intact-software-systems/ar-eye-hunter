// @vitest-environment happy-dom
import { readApiConfig, readIceCandidates } from '@shared-web/browser/api-integration.ts';
import type { RallarAuthState, RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { RallarGameMatchStatus, RallarGamePeerReadiness } from '@shared-web/game/mod.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { validateRallarJsonPayload } from '@shared/api/rallar-validation.ts';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRallarArena, type ArenaConnection } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/use-rallar-arena.ts';
import type { ArenaRallarGameMatchHandle } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import { createInitialArenaState, createInitialVitalsState, toArenaSnapshot } from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const session: AuthSession = {
    clientId: 'hunter-1',
    accessToken: 'token-1',
    username: 'hunter',
    sessionId: 'session-1',
    expiresAtEpochMs: Date.now() + 60_000
};

const authListeners = new Set<(state: RallarAuthState) => void | Promise<void>>();
const unsubscribe = vi.fn();
const mockMatch = vi.hoisted(() => ({
    stop: vi.fn(),
    status: vi.fn<ArenaRallarGameMatchHandle['status']>(() => ({
        phase: 'connecting',
        protocol: 'ar-eye-hunter.v1',
        topicId: 'room.ar-eye-hunter.director',
        directorPeerId: undefined,
        directorIsFresh: false,
        directorAuthority: 'none',
        egress: { reliable: 'empty', realtime: 'empty' },
        recovery: { status: 'idle' },
        started: true,
        stopped: false,
        updatedAtEpochMs: 1
    })),
    diagnostics: vi.fn(() => ({
        generatedAtEpochMs: 1,
        phase: 'starting',
        directorIsFresh: false,
        directorAuthority: 'none',
        egress: { reliable: 'empty', realtime: 'empty' },
        recovery: { status: 'idle' },
        knownPeerIds: [],
        readyPeerIds: [],
        notReadyPeerIds: [],
        capabilityCount: 0,
        rtcPeerCount: 0,
        realtimeHealth: [],
        issues: []
    })),
    canAppointDirector: vi.fn<ArenaRallarGameMatchHandle['canAppointDirector']>(() => ({
        allowed: true,
        status: 'allowed',
        policy: 'metadata-owner-admin-or-member-fallback'
    })),
    start: vi.fn(() => Promise.resolve()),
    reportCapability: vi.fn<ArenaRallarGameMatchHandle['reportCapability']>(() => Promise.resolve({ status: 'sent' })),
    appointIfElected: vi.fn<ArenaRallarGameMatchHandle['appointIfElected']>(() =>
        Promise.resolve({
            status: 'not-elected',
            election: {
                candidates: [],
                nowEpochMs: 1,
                capabilityTtlMs: 10_000
            },
            reason: 'The local peer is not the elected host.'
        })
    ),
    onStatus: vi.fn(() => vi.fn()),
    waitForReadyLanes: vi.fn<ArenaRallarGameMatchHandle['waitForReadyLanes']>(() => Promise.resolve(emptyPeerReadiness())),
    publishEvent: vi.fn(),
    publishSnapshot: vi.fn(),
    sendIntent: vi.fn(),
    sendInput: vi.fn(),
    sendPresence: vi.fn(),
    requestSync: vi.fn<ArenaRallarGameMatchHandle['requestSync']>(() => Promise.resolve({ status: 'sent' }))
}));
const mockRallar = vi.hoisted(() => ({
    auth: {
        restore: vi.fn(),
        onChange: vi.fn(),
        login: vi.fn(),
        registerAndLogin: vi.fn(),
        logout: vi.fn()
    },
    start: vi.fn(),
    rooms: {
        state: vi.fn(),
        onChange: vi.fn(),
        refresh: vi.fn(),
        create: vi.fn(),
        createAndSwitch: vi.fn(),
        join: vi.fn()
    },
    director: {
        status: vi.fn(),
        onStatus: vi.fn(),
        appoint: vi.fn()
    },
    realtime: {
        onJson: vi.fn(),
        sendJson: vi.fn(),
        room: vi.fn(),
        health: vi.fn()
    },
    rtc: {
        status: vi.fn(),
        waitForRoomLane: vi.fn(),
        diagnostics: vi.fn()
    },
    ws: {
        status: vi.fn()
    },
    subscriptions: vi.fn()
}));

vi.mock('@shared-web/browser/rallar.ts', () => ({
    rallar: mockRallar
}));

vi.mock('@shared-web/browser/api-integration.ts', () => ({
    readApiConfig: vi.fn(() =>
        Promise.resolve({
            apiBaseUrl: 'https://api.test',
            wsBaseUrl: 'wss://api.test'
        })
    ),
    readIceCandidates: vi.fn(() =>
        Promise.resolve({
            iceServers: [
                { urls: 'stun:stun.test' }
            ]
        })
    )
}));

vi.mock('@shared-web/browser/auth/websocket-ticket-http-api.ts', () => ({
    readWebSocketTicketBackoffState: vi.fn(() => ({ status: 'idle' }))
}));

vi.mock('@shared-web/browser/rallar-ai.ts', () => ({
    createRallarBrowserAi: () => ({
        complete: vi.fn()
    })
}));

vi.mock(
    '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts',
    async (importOriginal) => {
        const actual = await importOriginal<object>();
        return {
            ...actual,
            createArenaRallarGameMatch: vi.fn(() => mockMatch)
        };
    }
);

describe('useRallarArena auth lifecycle', () => {
    let root: Root | undefined;
    let container: HTMLDivElement;
    let current: ArenaConnection | undefined;

    beforeEach(() => {
        authListeners.clear();
        unsubscribe.mockClear();
        current = undefined;
        container = document.createElement('div');
        document.body.append(container);
        mockRallar.auth.restore.mockReturnValue(session);
        mockRallar.auth.onChange.mockImplementation((listener) => {
            authListeners.add(listener);
            return unsubscribe;
        });
        mockRallar.start.mockResolvedValue({
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
        mockRallar.rooms.state.mockReturnValue({
            rooms: [],
            currentRoomId: undefined
        });
        mockRallar.director.status.mockReturnValue({
            role: 'none',
            state: 'none',
            isDirector: false,
            isFresh: false
        });
        mockRallar.subscriptions.mockReturnValue({
            add: vi.fn().mockReturnThis(),
            unsubscribe: vi.fn()
        });
        mockRallar.realtime.onJson.mockReturnValue(vi.fn());
        mockRallar.realtime.room.mockReturnValue({
            send: vi.fn(() =>
                Promise.resolve({
                    status: 'sent',
                    peerIds: ['peer-b'],
                    desiredPeerIds: ['peer-b'],
                    results: [],
                    transport: 'rtc',
                    laneId: 'combat'
                })
            )
        });
        mockRallar.realtime.health.mockReturnValue([]);
        mockRallar.rooms.onChange.mockReturnValue(vi.fn());
        mockRallar.rooms.refresh.mockResolvedValue({
            rooms: [],
            currentRoomId: undefined
        });
        mockRallar.rooms.create.mockReset();
        mockRallar.rooms.createAndSwitch.mockReset();
        mockRallar.director.onStatus.mockReturnValue(vi.fn());
        mockRallar.ws.status.mockReturnValue({
            connectState: 'connected',
            readyState: 'open',
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 5,
            reconnectExhausted: false
        });
        mockRallar.rtc.status.mockReturnValue({
            laneId: 'motion',
            knownPeerIds: ['peer-b'],
            activePeerIds: ['peer-b'],
            peerIdsWithNoReconnectableLanes: [],
            readyPeerIds: ['peer-b'],
            peers: []
        });
        mockRallar.rtc.diagnostics.mockResolvedValue({
            generatedAtEpochMs: 1,
            peerCount: 1,
            connectedPeerCount: 1,
            relayPeerCount: 0,
            peers: []
        });
        mockRallar.rtc.waitForRoomLane.mockResolvedValue({
            status: 'closed',
            ready: [],
            notReady: []
        });
        mockMatch.stop.mockClear();
        mockMatch.status.mockClear();
        mockMatch.diagnostics.mockClear();
        mockMatch.canAppointDirector.mockClear();
        mockMatch.start.mockClear();
        mockMatch.reportCapability.mockClear();
        mockMatch.appointIfElected.mockClear();
        mockMatch.onStatus.mockClear();
        mockMatch.waitForReadyLanes.mockClear();
        mockMatch.publishEvent.mockClear();
        mockMatch.publishSnapshot.mockClear();
        mockMatch.sendIntent.mockClear();
        mockMatch.sendInput.mockClear();
        mockMatch.sendPresence.mockClear();
        mockMatch.requestSync.mockClear();
    });

    afterEach(async () => {
        if (root) {
            await act(async () => root?.unmount());
        }
        root = undefined;
        container.remove();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('clears arena state when auth expires outside manual logout', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');

        expect(current?.session).toEqual(session);
        expect(current?.roomId).toBe('arena-1');
        expect(current?.rooms).toHaveLength(1);

        await emitAuthState({
            authenticated: false,
            reason: 'expired'
        });

        expect(current?.session).toBeUndefined();
        expect(current?.connectionState).toBe('signed-out');
        expect(current?.roomId).toBeUndefined();
        expect(current?.rooms).toEqual([]);
        expect(current?.arenaSnapshot).toBeUndefined();
        expect(current?.remotePlayers.size).toBe(0);
        expect(current?.remoteEvents).toEqual([]);
        expect(current?.remoteShots).toEqual([]);
        expect(current?.remotePlayerHits).toEqual([]);
        expect(current?.pickupAcceptances).toEqual([]);
        expect(mockRallar.auth.logout).not.toHaveBeenCalled();
    });

    it('catches manual logout rejection and leaves the arena signed out', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        mockRallar.auth.logout.mockRejectedValueOnce(new Error('logout failed'));

        await act(async () => {
            await expect(current?.logout()).resolves.toBeUndefined();
        });

        expect(mockRallar.auth.logout).toHaveBeenCalledOnce();
        expect(current?.session).toBeUndefined();
        expect(current?.connectionState).toBe('signed-out');
        expect(current?.roomId).toBeUndefined();
        expect(current?.rooms).toEqual([]);
        expect(current?.arenaSnapshot).toBeUndefined();
        expect(current?.remotePlayers.size).toBe(0);
        expect(current?.remoteEvents).toEqual([]);
    });

    it('disables network immediately while manual logout revoke is pending', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        const logout = createDeferred<void>();
        mockRallar.auth.logout.mockReturnValueOnce(logout.promise);
        const connectedConnection = current;
        let logoutPromise: Promise<void> | undefined;

        await act(async () => {
            logoutPromise = connectedConnection?.logout();
            await Promise.resolve();
        });

        expect(mockRallar.auth.logout).toHaveBeenCalledOnce();
        expect(current?.connectionState).toBe('signed-out');
        expect(current?.networkEnabled).toBe(false);
        expect(current?.session).toBeUndefined();
        expect(current?.roomId).toBeUndefined();
        expect(mockMatch.stop).toHaveBeenCalled();

        await act(async () => {
            logout.resolve();
            await logoutPromise;
        });
    });

    it('blocks stale canvas callbacks while manual logout revoke is pending', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        const logout = createDeferred<void>();
        mockRallar.auth.logout.mockReturnValueOnce(logout.promise);
        const connectedConnection = current;
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
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');

        await act(async () => {
            await current?.logout();
        });

        vi.mocked(readApiConfig).mockClear();
        vi.mocked(readIceCandidates).mockClear();
        mockRallar.rtc.diagnostics.mockClear();
        mockRallar.rtc.waitForRoomLane.mockClear();

        await act(async () => {
            await current?.refreshDiagnostics({ includeRtcStats: true });
        });

        expect(readApiConfig).not.toHaveBeenCalled();
        expect(readIceCandidates).not.toHaveBeenCalled();
        expect(mockRallar.rtc.diagnostics).not.toHaveBeenCalled();
        expect(mockRallar.rtc.waitForRoomLane).not.toHaveBeenCalled();
        expect(current?.connectionState).toBe('signed-out');
        expect(current?.httpDiagnostics.apiConfig.status).toBe('idle');
        expect(current?.httpDiagnostics.ice.status).toBe('idle');
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
            roomChangeListeners.add(listener as never);
            return () => roomChangeListeners.delete(listener as never);
        });
        mockRallar.rtc.waitForRoomLane.mockImplementation(
            (_room, _lane, options?: { signal?: AbortSignal; }) => {
                if (options?.signal) {
                    waitSignals.push(options.signal);
                }
                return new Promise(() => undefined);
            }
        );

        await renderHook();
        await waitForState(() =>
            current?.connectionState === 'connected' &&
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
        await waitForState(() => current?.roomId === undefined);

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
        const appointment = createDeferred<Awaited<ReturnType<typeof mockMatch.appointIfElected>>>();
        mockRallar.rooms.onChange.mockImplementation((listener) => {
            roomChangeListeners.add(listener as never);
            return () => roomChangeListeners.delete(listener as never);
        });

        await renderHook();
        await waitForState(() =>
            current?.connectionState === 'connected' &&
            roomChangeListeners.size > 0 &&
            current.directorAttempt.status !== 'pending'
        );
        mockMatch.appointIfElected.mockClear();
        mockMatch.reportCapability.mockClear();
        mockMatch.appointIfElected.mockReturnValueOnce(appointment.promise);

        await act(async () => {
            current?.appointSelfAsDirector();
            await Promise.resolve();
        });
        await waitForState(() => current?.directorAttempt.status === 'pending');
        const diagnosticsBeforeResolve = current?.gameDiagnostics;
        const diagnosticsCallsBeforeResolve = mockMatch.diagnostics.mock.calls.length;

        await act(async () => {
            for (const listener of roomChangeListeners) {
                listener({
                    rooms: [],
                    currentRoomId: undefined,
                    currentRoomRef: undefined
                });
            }
        });
        await waitForState(() => current?.roomId === undefined);

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

        expect(current?.roomId).toBeUndefined();
        expect(current?.directorStatus.isDirector).toBe(false);
        expect(current?.directorAttempt.status).toBe('pending');
        expect(mockMatch.diagnostics).toHaveBeenCalledTimes(diagnosticsCallsBeforeResolve);
        expect(current?.gameDiagnostics).toBe(diagnosticsBeforeResolve);
    });

    it('ignores a startup result that resolves after logout', async () => {
        const startup = createDeferred<Awaited<ReturnType<typeof mockRallar.start>>>();
        mockRallar.start.mockReturnValueOnce(startup.promise);

        await renderHook();
        await waitForState(() => current?.connectionState === 'connecting');

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

        expect(current?.session).toBeUndefined();
        expect(current?.connectionState).toBe('signed-out');
        expect(current?.roomId).toBeUndefined();
        expect(current?.rooms).toEqual([]);
    });

    it('blocks stale canvas snapshot publication after logout', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');

        await act(async () => {
            await current?.logout();
        });

        const signedOutConnection = current;
        await act(async () => {
            signedOutConnection?.publishArenaSnapshot(arenaSnapshot(99));
        });

        expect(current?.connectionState).toBe('signed-out');
        expect(current?.arenaSnapshot).toBeUndefined();
        expect(mockMatch.publishSnapshot).not.toHaveBeenCalled();
    });

    it('blocks stale canvas combat callbacks after logout', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');

        await act(async () => {
            await current?.logout();
        });

        const signedOutConnection = current;
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

    it('records director appointment attempts and exposes transport diagnostics', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        await waitForState(() => current?.directorAttempt.status === 'not-elected');

        expect(current?.directorAttempt).toMatchObject({
            source: 'auto',
            status: 'not-elected',
            reason: 'The local peer is not the elected host.'
        });

        mockMatch.appointIfElected.mockResolvedValueOnce({
            status: 'failed',
            election: {
                candidates: [],
                nowEpochMs: 2,
                capabilityTtlMs: 10_000
            },
            reason: 'director write timed out'
        });

        await act(async () => {
            await current?.appointSelfAsDirector();
        });

        expect(current?.directorAttempt).toMatchObject({
            source: 'manual',
            status: 'failed',
            reason: 'director write timed out'
        });

        await act(async () => {
            await current?.refreshDiagnostics({ includeRtcStats: true });
        });

        expect(current?.transportDiagnostics.ws?.readyState).toBe('open');
        expect(current?.transportDiagnostics.rtc?.readyPeerIds).toEqual(['peer-b']);
        expect(current?.transportDiagnostics.rtcDiagnostics?.connectedPeerCount).toBe(1);
        expect(current?.gameDiagnostics?.phase).toBe('starting');
    });

    it('creates a new arena by switching rooms and clearing stale remote players', async () => {
        const realtimeHandlers = new Map<
            string,
            (message: {
                peerId: string;
                data: unknown;
            }) => void | Promise<void>
        >();
        mockRallar.realtime.onJson.mockImplementation((laneId, handler) => {
            realtimeHandlers.set(laneId, handler as never);
            return vi.fn();
        });
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

        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');

        await act(async () => {
            await realtimeHandlers.get('motion')?.({
                peerId: 'peer-1',
                data: {
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
            });
        });
        await waitForState(() => current?.remotePlayers.size === 1);

        await act(async () => {
            await current?.createArenaRoom();
        });

        expect(mockRallar.rooms.createAndSwitch).toHaveBeenCalledWith({
            displayName: expect.stringContaining('AR Eye Hunter Arena:')
        });
        expect(mockRallar.rooms.create).not.toHaveBeenCalled();
        expect(current?.roomId).toBe('arena-2');
        expect(current?.remotePlayers.size).toBe(0);
        expect(current?.remoteEvents).toEqual([]);
        expect(current?.remoteShots).toEqual([]);
        expect(current?.pickupAcceptances).toEqual([]);
    });

    it('requests solo arena sync immediately after director appointment without waiting for RTC lanes', async () => {
        const laneWait = createDeferred<RallarGamePeerReadiness>();
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        mockMatch.appointIfElected.mockResolvedValueOnce({
            status: 'appointed',
            election: {
                candidates: [],
                nowEpochMs: 2,
                capabilityTtlMs: 10_000
            },
            directorStatus: freshDirectorStatus()
        });
        mockMatch.diagnostics.mockReturnValue({
            generatedAtEpochMs: 1,
            phase: 'active',
            directorIsFresh: true,
            directorAuthority: 'active',
            egress: {
                reliable: 'ready',
                realtime: 'empty'
            },
            recovery: { status: 'idle' },
            knownPeerIds: [],
            readyPeerIds: [],
            notReadyPeerIds: [],
            capabilityCount: 0,
            rtcPeerCount: 0,
            realtimeHealth: [],
            issues: []
        });
        mockMatch.waitForReadyLanes.mockReturnValueOnce(laneWait.promise);

        await renderHook();
        await waitForState(() => mockMatch.appointIfElected.mock.calls.length > 0);
        await act(async () => {
            await Promise.resolve();
        });

        expect(mockMatch.requestSync).toHaveBeenCalledWith({ reason: 'arena-join' });
        expect(current?.gameDiagnostics).toMatchObject({
            directorAuthority: 'active',
            egress: {
                reliable: 'ready',
                realtime: 'empty'
            }
        });

        await act(async () => {
            laneWait.resolve(emptyPeerReadiness());
            await laneWait.promise;
        });
    });

    it('keeps diagnostics refresh stable after updating diagnostics state', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        const refreshDiagnostics = current?.refreshDiagnostics;

        await act(async () => {
            await refreshDiagnostics?.({ includeRtcStats: true });
        });

        expect(current?.transportDiagnostics.rtcDiagnostics?.connectedPeerCount).toBe(1);
        expect(current?.refreshDiagnostics).toBe(refreshDiagnostics);
    });

    it('auto-appoints regular room members when the owner is offline', async () => {
        mockMatch.appointIfElected.mockResolvedValueOnce({
            status: 'appointed',
            election: {
                candidates: [],
                nowEpochMs: 2,
                capabilityTtlMs: 10_000
            },
            directorStatus: freshDirectorStatus()
        });
        mockRallar.rooms.state.mockReturnValue({
            rooms: [],
            currentRoomId: 'arena-1',
            members: [
                {
                    principalId: session.clientId,
                    username: session.username,
                    role: 'member',
                    status: 'active',
                    isOwner: false,
                    isOnline: true,
                    sessionIds: [session.sessionId]
                }
            ]
        });

        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        await waitForState(() => current?.directorAttempt.status === 'succeeded');

        expect(current?.directorAttempt).toMatchObject({
            source: 'auto',
            status: 'succeeded',
            resultStatus: 'appointed'
        });
        expect(mockMatch.reportCapability).toHaveBeenCalled();
        expect(mockMatch.appointIfElected).toHaveBeenCalled();
    });

    it('still publishes the local director pose through Rallar Game presence', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        mockMatch.status.mockReturnValue(localDirectorMatchStatus());

        await act(async () => {
            current?.sendPose({
                position: [1, 2, 3],
                rotation: [0, 0.5, 0],
                velocity: [0.1, 0, 0.2],
                score: 12,
                combo: 2,
                seq: 7,
                sentAtEpochMs: 123
            });
        });

        expect(mockMatch.sendInput).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'player-pose-intent',
            pose: expect.objectContaining({
                sessionId: session.sessionId
            })
        }));
        expect(mockMatch.sendPresence).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'player-pose',
                pose: expect.objectContaining({
                    sessionId: session.sessionId,
                    position: [1, 2, 3]
                })
            }),
            expect.objectContaining({
                laneId: 'motion',
                key: `pose:${session.sessionId}`,
                maxAgeMs: 250,
                openTimeoutMs: 1500
            })
        );
        expect(mockRallar.realtime.sendJson).not.toHaveBeenCalledWith(expect.objectContaining({
            laneId: 'motion',
            key: `pose:${session.sessionId}`
        }));
    });

    it('sends Rallar JSON-compatible pose envelopes when optional vitals are unset', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        mockMatch.status.mockReturnValue(localDirectorMatchStatus());

        await act(async () => {
            current?.sendPose({
                position: [1, 2, 3],
                rotation: [0, 0.5, 0],
                score: 12,
                seq: 8,
                sentAtEpochMs: 456,
                vitals: {
                    ...createInitialVitalsState(),
                    deadUntilEpochMs: undefined
                }
            });
        });

        const input = mockMatch.sendInput.mock.calls[0]?.[0];
        const presence = mockMatch.sendPresence.mock.calls[0]?.[0];

        expect(validateRallarJsonPayload(input, { path: '$.payload' }).ok).toBe(true);
        expect(validateRallarJsonPayload(presence, { path: '$.payload' }).ok).toBe(true);
    });

    it('deduplicates reliable director snapshots by revision', async () => {
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        mockMatch.publishSnapshot.mockClear();
        const snapshot = arenaSnapshot(10);

        await act(async () => {
            current?.publishArenaSnapshot(snapshot);
            current?.publishArenaSnapshot(snapshot);
        });

        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);
        expect(mockMatch.publishSnapshot).toHaveBeenCalledWith(
            snapshot,
            { reliable: true }
        );
    });

    it('coalesces rapid reliable director snapshots to the latest revision', async () => {
        vi.useFakeTimers();
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        mockMatch.publishSnapshot.mockClear();

        await act(async () => {
            current?.publishArenaSnapshot(arenaSnapshot(20));
            current?.publishArenaSnapshot(arenaSnapshot(21));
            current?.publishArenaSnapshot(arenaSnapshot(22));
        });

        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);
        expect(mockMatch.publishSnapshot.mock.calls[0]?.[0]).toMatchObject({
            revision: 20
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(999);
        });
        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });

        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(2);
        expect(mockMatch.publishSnapshot.mock.calls[1]?.[0]).toMatchObject({
            revision: 22
        });
        expect(mockMatch.publishSnapshot.mock.calls[1]?.[1]).toEqual({ reliable: true });
    });

    it('cancels pending reliable director snapshots when the network generation resets', async () => {
        vi.useFakeTimers();
        mockRallar.director.status.mockReturnValue(freshDirectorStatus());
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        mockMatch.publishSnapshot.mockClear();

        await act(async () => {
            current?.publishArenaSnapshot(arenaSnapshot(30));
            current?.publishArenaSnapshot(arenaSnapshot(31));
        });
        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);

        await emitAuthState({
            authenticated: false,
            reason: 'expired'
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });

        expect(mockMatch.publishSnapshot).toHaveBeenCalledTimes(1);
    });

    async function renderHook(): Promise<void> {
        root = createRoot(container);
        function Harness() {
            current = useRallarArena();
            return null;
        }
        await act(async () => {
            root?.render(createElement(Harness));
        });
    }

    async function emitAuthState(state: RallarAuthState): Promise<void> {
        await act(async () => {
            for (const listener of authListeners) {
                await listener(state);
            }
        });
    }

    async function waitForState(predicate: () => boolean): Promise<void> {
        for (let i = 0; i < 10; i += 1) {
            if (predicate()) {
                return;
            }
            await act(async () => {
                await Promise.resolve();
            });
        }
        expect(predicate()).toBe(true);
    }
});

function freshDirectorStatus(): RallarDirectorStatus {
    return {
        roomId: 'arena-1',
        role: 'director',
        state: 'fresh',
        appointment: {
            version: 1,
            mode: 'appointed-spa',
            sessionId: session.sessionId,
            principalId: session.clientId,
            epoch: 1,
            appointedAtEpochMs: 1,
            heartbeatTtlMs: 10_000
        },
        isDirector: true,
        isFresh: true,
        active: true,
        freshness: 'fresh',
        lastHeartbeatAtEpochMs: 1,
        nowEpochMs: 1
    };
}

function arenaSnapshot(revision: number) {
    return {
        ...toArenaSnapshot(
            {
                ...createInitialArenaState(1_000),
                revision
            },
            'arena-1',
            1_000 + revision
        ),
        revision
    };
}

function localDirectorMatchStatus(): RallarGameMatchStatus {
    return {
        phase: 'active',
        protocol: 'ar-eye-hunter.v1',
        topicId: 'room.ar-eye-hunter.director',
        roomId: 'arena-1',
        localPeerId: session.sessionId,
        directorPeerId: session.sessionId,
        directorEpoch: 1,
        directorIsFresh: true,
        directorAuthority: 'active',
        egress: { reliable: 'ready', realtime: 'empty' },
        recovery: { status: 'idle' },
        started: true,
        stopped: false,
        updatedAtEpochMs: 2
    };
}

function emptyPeerReadiness(): RallarGamePeerReadiness {
    return {
        status: 'empty',
        laneIds: [],
        readyPeerIds: [],
        notReadyPeerIds: [],
        missingPeerIds: [],
        extraPeerIds: [],
        observedCount: 0,
        lanes: []
    };
}

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
