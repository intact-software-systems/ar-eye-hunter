// @vitest-environment happy-dom
import { createElement, type SetStateAction } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readApiConfig, readIceCandidates } from '@shared-web/browser/connection/connection-http-api.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRoomRealtimeJsonDefaults } from '@shared-web/browser/rallar-realtime.ts';
import type { RallarAuthState, RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import { createRallarGameEnvelope, type RallarGameMatchStatus, type RallarGamePeerReadiness } from '@shared-web/game/mod.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { validateRallarJsonPayload } from '@shared/api/rallar-validation.ts';

import {
    createArenaMatchRuntime,
    type ArenaMatchRuntimeInput
} from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/match/create-arena-match-runtime.ts';
import { acceptArenaMatchIntent } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/match/handlers/accept-arena-match-intent.ts';
import type { ArenaPeerShotMessage } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/messages/use-arena-peer-message-handlers.ts';
import { useRallarArena, type ArenaConnection } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/use-rallar-arena.ts';
import { createArenaRallarGameMatch, type ArenaRallarGameMatchHandle } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import {
    createInitialArenaState,
    createInitialVitalsState,
    spawnWeaponPickup,
    toArenaSnapshot,
    upsertPlayerPose
} from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';
import type { ArenaEvent, ArenaSnapshot, GameRealtimeMessage, PlayerPose } from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';
import { createMessageDelivery } from '../shared-web/messages/test-message-delivery.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const session: AuthSession = {
    clientId: 'hunter-1',
    accessToken: 'token-1',
    username: 'hunter',
    sessionId: 'session-1',
    expiresAtEpochMs: Date.now() + 60_000
};

const arenaRoomRef: GroupRef = { applicationId: 'ar-eye-hunter', workspaceId: 'players', groupId: 'arena-1' };

const authListeners = new Set<(state: RallarAuthState) => void | Promise<void>>();
const unsubscribe = vi.fn();
const mockMatch = vi.hoisted(() => ({
    stop: vi.fn(),
    status: vi.fn<ArenaRallarGameMatchHandle['status']>(emptyArenaMatchStatus),
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

vi.mock('@shared-web/browser/connection/connection-http-api.ts', () => ({
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
            currentRoomId: 'arena-1',
            currentRoomRef: arenaRoomRef
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
        mockMatch.status.mockReset().mockImplementation(emptyArenaMatchStatus);
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
            roomChangeListeners.add(listener);
            return () => roomChangeListeners.delete(listener);
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

    it.each(
        [
            [undefined, 'pending', undefined],
            [{ kind: 'admitted', durable: false, queuedAttempts: 1 }, 'pending', undefined],
            [{ kind: 'admitted', durable: false, queuedAttempts: 0 }, 'pending', undefined],
            [{ kind: 'deferred', reason: 'not-yet-in-sync', detail: 'waiting for authority' }, 'pending', undefined],
            [{ kind: 'refused', reason: 'unauthorized', detail: 'membership denied' }, 'failed', 'membership denied'],
            [{ kind: 'failed', detail: 'queue unavailable' }, 'failed', 'queue unavailable'],
            [{ kind: 'expired', detail: 'deadline elapsed' }, 'expired', 'deadline elapsed'],
            [{ kind: 'superseded', detail: 'newer report' }, 'superseded', 'newer report']
        ] satisfies readonly [ALDeliveryAdmissionVerdict | undefined, string, string | undefined][]
    )('observes initial capability delivery %j', async (verdict, state, reason) => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const delivery = createMessageDelivery('ws', verdict);
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        await act(async () => {
            await current?.appointSelfAsDirector();
        });
        expect(current?.directorAttempt).toMatchObject({ status: 'not-elected', capabilityDelivery: { state, reason } });
    });

    it('keeps delivery observation after appointment completion and preserves both outcomes', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const delivery = createMessageDelivery('ws', undefined);
        const appointment = createDeferred<Awaited<ReturnType<ArenaRallarGameMatchHandle['appointIfElected']>>>();
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        mockMatch.appointIfElected.mockReturnValueOnce(appointment.promise);
        let completion: Promise<void> | undefined;
        await act(async () => {
            completion = current?.appointSelfAsDirector();
        });
        expect(current?.directorAttempt).toMatchObject({ status: 'pending', capabilityDelivery: { state: 'pending' } });
        await act(async () => {
            delivery.registry.record({
                kind: 'attempt-settled',
                msgId: delivery.handle.msgId,
                carrier: 'ws',
                atMs: Date.now(),
                attemptId: 'ws-attempt',
                outcome: 'not-ready',
                submissionAttempted: false,
                detail: 'connecting',
                willRetry: true
            });
        });
        expect(current?.directorAttempt).toMatchObject({ status: 'pending', capabilityDelivery: { state: 'pending' } });
        await act(async () => {
            appointment.resolve({ status: 'failed', election: { candidates: [], nowEpochMs: 2, capabilityTtlMs: 10_000 }, reason: 'appointment denied' });
            await completion;
        });
        expect(current?.directorAttempt).toMatchObject({ status: 'failed', reason: 'appointment denied', capabilityDelivery: { state: 'pending' } });
        const finishedAtEpochMs = current?.directorAttempt.finishedAtEpochMs;
        await act(async () => {
            delivery.registry.releaseAll();
        });
        expect(current?.directorAttempt).toMatchObject({
            status: 'failed',
            reason: 'appointment denied',
            finishedAtEpochMs,
            capabilityDelivery: { state: 'unobservable' }
        });
    });

    it('fences replaced reports and releases delivery listeners on replacement and network end', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        const report = createDeferred<Awaited<ReturnType<ArenaRallarGameMatchHandle['reportCapability']>>>();
        mockMatch.reportCapability.mockReturnValueOnce(report.promise);
        let oldCompletion: Promise<void> | undefined;
        await act(async () => {
            oldCompletion = current?.appointSelfAsDirector();
        });
        const delivery = createMessageDelivery('ws', undefined);
        const listeners = new Set<Parameters<RallarMessageHandle['onEvent']>[0]>();
        const originalOnEvent = delivery.handle.onEvent.bind(delivery.handle);
        const callbacks: Parameters<RallarMessageHandle['onEvent']>[0][] = [];
        vi.spyOn(delivery.handle, 'onEvent').mockImplementation((listener) => {
            listeners.add(listener);
            callbacks.push(listener);
            const unsubscribeDelivery = originalOnEvent(listener);
            return () => {
                listeners.delete(listener);
                unsubscribeDelivery();
            };
        });
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        await act(async () => {
            await current?.appointSelfAsDirector();
        });
        expect(listeners.size).toBe(1);
        const replacement = current?.directorAttempt;
        mockMatch.appointIfElected.mockClear();
        await act(async () => {
            report.resolve({ status: 'sent', ws: createMessageDelivery('ws', undefined).handle });
            await oldCompletion;
        });
        expect(current?.directorAttempt).toEqual(replacement);
        expect(mockMatch.appointIfElected).not.toHaveBeenCalled();
        await act(async () => {
            await current?.appointSelfAsDirector();
        });
        expect(listeners.size).toBe(0);
        const latest = current?.directorAttempt;
        await act(async () => {
            callbacks[0](delivery.handle.lifecycle());
        });
        expect(current?.directorAttempt).toEqual(latest);
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        await act(async () => {
            await current?.appointSelfAsDirector();
        });
        expect(listeners.size).toBe(1);
        await emitAuthState({ authenticated: false, reason: 'expired' });
        expect(listeners.size).toBe(0);
        await act(async () => {
            callbacks.at(-1)?.(delivery.handle.lifecycle());
        });
        expect(current?.directorAttempt.status).toBe('idle');
        expect(delivery.handle.lifecycle().state).toBe('submitted');
        vi.restoreAllMocks();
    });

    it('preserves transport confirmation when appointment completes and unsubscribes on unmount', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const delivery = createMessageDelivery('ws', undefined);
        const appointment = createDeferred<Awaited<ReturnType<ArenaRallarGameMatchHandle['appointIfElected']>>>();
        const originalOnEvent = delivery.handle.onEvent.bind(delivery.handle);
        const listeners = new Set<Parameters<RallarMessageHandle['onEvent']>[0]>();
        vi.spyOn(delivery.handle, 'onEvent').mockImplementation((listener) => {
            listeners.add(listener);
            const unsubscribeDelivery = originalOnEvent(listener);
            return () => {
                listeners.delete(listener);
                unsubscribeDelivery();
            };
        });
        mockMatch.reportCapability.mockResolvedValueOnce({ status: 'sent', ws: delivery.handle });
        mockMatch.appointIfElected.mockReturnValueOnce(appointment.promise);
        let completion: Promise<void> | undefined;
        await act(async () => {
            completion = current?.appointSelfAsDirector();
        });
        await act(async () => {
            delivery.registry.record({
                kind: 'attempt-settled',
                msgId: delivery.handle.msgId,
                carrier: 'ws',
                atMs: Date.now(),
                attemptId: 'ws-attempt',
                outcome: 'sent',
                submissionAttempted: true,
                detail: undefined,
                willRetry: false
            });
        });
        expect(current?.directorAttempt).toMatchObject({ status: 'pending', capabilityDelivery: { state: 'confirmed', evidence: 'transport-accepted' } });
        await act(async () => {
            appointment.resolve({
                status: 'appointed',
                election: { candidates: [], nowEpochMs: 2, capabilityTtlMs: 10_000 },
                directorStatus: freshDirectorStatus()
            });
            await completion;
        });
        expect(current?.directorAttempt).toMatchObject({ status: 'succeeded', capabilityDelivery: { state: 'confirmed', evidence: 'transport-accepted' } });
        expect(listeners.size).toBe(1);
        await act(async () => {
            root?.unmount();
        });
        root = undefined;
        expect(listeners.size).toBe(0);
        expect(delivery.handle.lifecycle().state).toBe('transport-accepted');
    });

    it('does not appoint after an old capability report resolves across logout', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const report = createDeferred<Awaited<ReturnType<ArenaRallarGameMatchHandle['reportCapability']>>>();
        mockMatch.reportCapability.mockReturnValueOnce(report.promise);
        let completion: Promise<void> | undefined;
        await act(async () => {
            completion = current?.appointSelfAsDirector();
        });
        await emitAuthState({ authenticated: false, reason: 'expired' });
        mockMatch.appointIfElected.mockClear();
        await act(async () => {
            report.resolve({ status: 'sent', ws: createMessageDelivery('ws', undefined).handle });
            await completion;
        });
        expect(current?.directorAttempt.status).toBe('idle');
        expect(mockMatch.appointIfElected).not.toHaveBeenCalled();
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

    it.each([
        { name: 'application', roomRef: { ...arenaRoomRef, applicationId: 'another-app' } },
        { name: 'workspace', roomRef: { ...arenaRoomRef, workspaceId: 'another-workspace' } },
        { name: 'group', roomRef: { ...arenaRoomRef, groupId: 'another-room' } },
        { name: 'missing scope', roomRef: undefined }
    ])('ignores raw accepted shots with wrong $name', async ({ roomRef }) => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () => receive?.({ peerId: 'peer-1', data: peerShotMessage(roomRef) }));
        expect(current?.remoteShots).toEqual([]);
    });

    it('keeps same-room accepted shots but rejects an old subscription after replacement and network end', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const oldReceive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () => oldReceive?.({ peerId: 'peer-1', data: peerShotMessage(arenaRoomRef) }));
        expect(current?.remoteShots.map((shot) => shot.id)).toEqual(['peer-1:1:3']);
        const nextRoomRef = { ...arenaRoomRef, groupId: 'arena-2' };
        const nextRoom = { rooms: [], currentRoomId: 'arena-2', currentRoomRef: nextRoomRef };
        mockRallar.rooms.state.mockReturnValue(nextRoom);
        mockRallar.rooms.createAndSwitch.mockResolvedValue({ group: nextRoomRef });
        mockRallar.rooms.refresh.mockResolvedValue(nextRoom);
        await act(async () => current?.createArenaRoom());
        await act(async () => {
            oldReceive?.({ peerId: 'peer-1', data: peerShotMessage(arenaRoomRef) });
            oldReceive?.({ peerId: 'peer-1', data: peerShotMessage(nextRoomRef) });
        });
        expect(current?.remoteShots).toEqual([]);
        const nextReceive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () => nextReceive?.({ peerId: 'peer-1', data: peerShotMessage(nextRoomRef) }));
        expect(current?.remoteShots.map((shot) => shot.id)).toEqual(['peer-1:1:3']);
        await emitAuthState({ authenticated: false, reason: 'expired' });
        await act(async () => nextReceive?.({ peerId: 'peer-1', data: peerShotMessage(nextRoomRef) }));
        expect(current?.remoteShots).toEqual([]);
    });

    it('ignores raw accepted shots after the network ends even if a listener fires late', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await emitAuthState({ authenticated: false, reason: 'expired' });
        await act(async () => receive?.({ peerId: 'peer-1', data: peerShotMessage(arenaRoomRef) }));
        expect(current?.remoteShots).toEqual([]);
    });

    it('accepts the current full scope when room IDs match after scope replacement', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        const nextRoomRef = { ...arenaRoomRef, workspaceId: 'next-workspace' };
        mockRallar.rooms.state.mockReturnValue({ rooms: [], currentRoomId: 'arena-1', currentRoomRef: nextRoomRef });
        await act(async () => {
            receive?.({ peerId: 'peer-1', data: peerShotMessage(arenaRoomRef) });
            receive?.({ peerId: 'peer-1', data: peerShotMessage(nextRoomRef) });
        });
        expect(current?.remoteShots.map((shot) => shot.id)).toEqual(['peer-1:1:3']);
    });

    it('requires every room identity field even in an empty workspace scope', async () => {
        const emptyWorkspace = { ...arenaRoomRef, workspaceId: '' };
        mockRallar.rooms.state.mockReturnValue({ rooms: [], currentRoomId: 'arena-1', currentRoomRef: emptyWorkspace });
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () =>
            receive?.({
                peerId: 'peer-1',
                data: {
                    ...peerShotMessage(emptyWorkspace),
                    roomRef: { applicationId: arenaRoomRef.applicationId, groupId: arenaRoomRef.groupId }
                }
            })
        );
        expect(current?.remoteShots).toEqual([]);
    });

    it('rejects a raw accepted shot whose shooter is not its sending peer', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const receive = mockRallar.realtime.onJson.mock.calls.findLast(([lane]) => lane === 'combat')?.[1];
        await act(async () => receive?.({ peerId: 'another-peer', data: peerShotMessage(arenaRoomRef) }));
        expect(current?.remoteShots).toEqual([]);
    });

    it('puts current full room identity on the actual accepted-shot fallback payload', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const outgoing: ArenaPeerShotMessage[] = [];
        const targets: RallarRoomRealtimeJsonDefaults[] = [];
        mockRallar.realtime.room.mockImplementation((target: RallarRoomRealtimeJsonDefaults) => {
            targets.push(target);
            return {
                send: async (payload: ArenaPeerShotMessage) => {
                    outgoing.push(payload);
                    return { status: 'sent', peerIds: ['peer-1'], desiredPeerIds: ['peer-1'], results: [], transport: 'rtc', laneId: 'combat' };
                }
            };
        });
        const message = peerShotMessage(arenaRoomRef);
        await act(async () => current?.sendShot(message.accepted.shot, message.accepted));
        expect(targets).toEqual([{ roomRef: arenaRoomRef, laneId: 'combat', openTimeoutMs: 1500 }]);
        expect(outgoing).toEqual([{
            ...message,
            accepted: {
                ...message.accepted,
                shot: { ...message.accepted.shot, sessionId: session.sessionId, username: session.username, color: expect.any(String) }
            }
        }]);
    });

    it.each(['hit', 'pickup'] as const)('applies the local director %s intent through its owning receiver', async (kind) => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        mockMatch.status.mockReturnValueOnce(localDirectorMatchStatus());
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        const fixture = acceptedIntentFixture(kind, session.sessionId);
        const published = createDeferred<ArenaSnapshot>();
        await act(async () => current?.publishArenaSnapshot(fixture.snapshot));
        mockMatch.sendIntent.mockImplementationOnce(async (message) => {
            await config?.onIntent?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: session.sessionId,
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: fixture.nowEpochMs,
                payload: message
            }));
            return { status: 'sent', transport: 'local' };
        });
        mockMatch.publishSnapshot.mockImplementationOnce(async (snapshot: ArenaSnapshot) => {
            published.resolve(snapshot);
            return { status: 'sent' };
        });
        await act(async () => {
            if (fixture.message.kind === 'player-hit-intent') {
                current?.sendPlayerHit(fixture.message.intent);
            }
            else if (fixture.message.kind === 'pickup-intent') {
                current?.sendPickupIntent(fixture.message.intent);
            }
            await published.promise;
        });
        const snapshot = await published.promise;
        expect(snapshot.roomId).toBe('arena-1');
        expect(snapshot.revision).toBeGreaterThan(fixture.snapshot.revision);
        expect(
            kind === 'hit'
                ? current?.remotePlayerHits[0]?.intent.shot.sessionId
                : current?.pickupAcceptances[0]?.player.sessionId
        ).toBe(session.sessionId);
    });

    it('awaits local match-start acceptance through the canonical intent receiver', async () => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        mockMatch.status.mockReturnValue(localDirectorMatchStatus());
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        await act(async () => current?.publishArenaSnapshot(arenaSnapshot(1)));
        const published: ArenaSnapshot[] = [];
        mockMatch.sendIntent.mockImplementationOnce(async (payload) => {
            await config?.onIntent?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: session.sessionId,
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: 1000,
                payload
            }));
            return { status: 'sent', transport: 'local' };
        });
        mockMatch.publishSnapshot.mockImplementationOnce(async (snapshot: ArenaSnapshot) => {
            published.push(snapshot);
            return { status: 'sent' };
        });
        await act(async () => current?.startArenaMatch(60_000));
        expect(current?.arenaSnapshot?.match).toMatchObject({ durationMs: 60_000, status: 'active' });
        expect(published.map((snapshot) => snapshot.match)).toEqual([current?.arenaSnapshot?.match]);
    });

    it.each(['hit', 'pickup'] as const)('rejects a current-room %s intent against a retained prior-room snapshot', async (kind) => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        const fixture = acceptedIntentFixture(kind);
        const previous = { ...fixture.snapshot, roomId: 'prior-room' };
        await act(async () => current?.publishArenaSnapshot(previous));
        await act(async () =>
            config?.onIntent?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: 'peer-1',
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: fixture.nowEpochMs,
                payload: fixture.message
            }))
        );
        expect(current?.arenaSnapshot).toEqual(previous);
        expect(current?.remotePlayerHits).toEqual([]);
        expect(current?.pickupAcceptances).toEqual([]);
    });

    it.each(
        [
            { kind: 'hit', end: 'replacement' },
            { kind: 'pickup', end: 'replacement' },
            { kind: 'hit', end: 'network-end' },
            { kind: 'pickup', end: 'network-end' }
        ] as const
    )('does not publish an accepted $kind snapshot after $end', async ({ kind, end }) => {
        await renderHook();
        await waitForState(() => current?.directorAttempt.status === 'not-elected');
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        const fixture = acceptedIntentFixture(kind);
        await act(async () => current?.publishArenaSnapshot(fixture.snapshot));
        const eventStarted = createDeferred<void>();
        const eventDone = createDeferred<void>();
        const publishedSnapshots: ArenaSnapshot[] = [];
        mockMatch.publishEvent.mockImplementationOnce(() => {
            eventStarted.resolve();
            return eventDone.promise;
        });
        mockMatch.publishSnapshot.mockImplementation(async (snapshot: ArenaSnapshot) => {
            publishedSnapshots.push(snapshot);
            return { status: 'sent' };
        });
        let completion: void | Promise<void>;
        await act(async () => {
            completion = config?.onIntent?.(createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: 'peer-1',
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: fixture.nowEpochMs,
                payload: fixture.message
            }));
            await eventStarted.promise;
        });
        if (end === 'replacement') {
            mockRallar.rooms.createAndSwitch.mockResolvedValue({ group: { groupId: 'arena-2' } });
            mockRallar.rooms.refresh.mockResolvedValue({ rooms: [], currentRoomId: 'arena-2' });
            await act(async () => current?.createArenaRoom());
        }
        else {
            await emitAuthState({ authenticated: false, reason: 'expired' });
        }
        await act(async () => {
            eventDone.resolve();
            await completion;
        });
        expect(publishedSnapshots.map((snapshot) => snapshot.roomId)).toEqual([]);
        mockMatch.publishSnapshot.mockReset();
    });

    it.each(['hit', 'pickup'] as const)('fences accepted %s continuation when its network ends with its match still installed', async (kind) => {
        const fixture = acceptedIntentFixture(kind);
        const eventDone = createDeferred<void>();
        const eventStarted = createDeferred<void>();
        const publishedSnapshots: string[] = [];
        let networkEnabled = true;
        mockMatch.publishEvent.mockImplementationOnce(() => {
            eventStarted.resolve();
            return eventDone.promise;
        });
        mockMatch.publishSnapshot.mockImplementation(async (snapshot: ArenaSnapshot) => {
            publishedSnapshots.push(snapshot.roomId ?? '');
            return { status: 'sent' };
        });
        const input: ArenaMatchRuntimeInput = {
            nowMs: () => fixture.nowEpochMs,
            arenaMatchRef: { current: undefined },
            arenaSnapshotRef: { current: fixture.snapshot },
            roomIdRef: { current: 'arena-1' },
            isCurrentNetworkGeneration: () => networkEnabled,
            acceptDirectorOutput: () => {},
            acceptPeerShot: () => {},
            acceptMatchStartIntent: async () => {},
            acceptMotionMessage: () => {},
            acceptPickup: () => {},
            acceptPlayerHit: () => {},
            setActiveEvent: () => {},
            setArenaSnapshot: () => {},
            setRemoteEvents: () => {}
        };
        input.arenaMatchRef.current = createArenaMatchRuntime(input, 1, 'arena-1');
        const completion = acceptArenaMatchIntent(
            input,
            1,
            createRallarGameEnvelope({
                protocol: 'ar-eye-hunter.v1',
                kind: 'intent',
                roomId: 'arena-1',
                senderId: 'peer-1',
                seq: 1,
                directorEpoch: 1,
                sentAtEpochMs: fixture.nowEpochMs,
                payload: fixture.message
            })
        );
        await eventStarted.promise;
        networkEnabled = false;
        eventDone.resolve();
        await completion;
        expect(publishedSnapshots).toEqual([]);
        mockMatch.publishSnapshot.mockReset();
    });

    it.each(['snapshot', 'hit', 'pickup'] as const)('keeps deferred %s publication out of a replacement runtime', async (kind) => {
        const fixture = acceptedIntentFixture(kind === 'snapshot' ? 'hit' : kind);
        let networkEnabled = true;
        let snapshot: ArenaSnapshot | undefined = fixture.snapshot;
        let activeEvent = fixture.snapshot.activeEvent;
        let events = fixture.snapshot.events;
        const pendingSnapshots: SetStateAction<ArenaSnapshot | undefined>[] = [];
        const pendingActiveEvents: SetStateAction<typeof activeEvent>[] = [];
        const pendingEvents: SetStateAction<typeof events>[] = [];
        const input: ArenaMatchRuntimeInput = {
            nowMs: () => fixture.nowEpochMs,
            arenaMatchRef: { current: undefined },
            arenaSnapshotRef: { current: fixture.snapshot },
            roomIdRef: { current: 'arena-1' },
            isCurrentNetworkGeneration: () => networkEnabled,
            acceptDirectorOutput: () => {},
            acceptPeerShot: () => {},
            acceptMatchStartIntent: async () => {},
            acceptMotionMessage: () => {},
            acceptPickup: () => {},
            acceptPlayerHit: () => {},
            setActiveEvent: (update) => pendingActiveEvents.push(update),
            setArenaSnapshot: (update) => pendingSnapshots.push(update),
            setRemoteEvents: (update) => pendingEvents.push(update)
        };
        input.arenaMatchRef.current = createArenaMatchRuntime(input, 1, 'arena-1');
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        if (!config?.onSnapshot || !config.onIntent) {
            throw new Error('The arena runtime did not install its incoming callbacks.');
        }
        if (kind === 'snapshot') {
            const event: ArenaEvent = {
                id: 'previous-room-event',
                kind: 'spawn-eye',
                source: 'director',
                startsAtEpochMs: fixture.nowEpochMs,
                expiresAtEpochMs: fixture.nowEpochMs + 4000,
                revision: fixture.snapshot.revision
            };
            await config.onSnapshot(
                createRallarGameEnvelope({
                    protocol: 'ar-eye-hunter.v1',
                    kind: 'snapshot',
                    roomId: 'arena-1',
                    senderId: 'peer-1',
                    seq: 1,
                    directorEpoch: 1,
                    sentAtEpochMs: fixture.nowEpochMs,
                    payload: { ...fixture.snapshot, activeEvent: event, events: [event] }
                })
            );
        }
        else {
            await config.onIntent(
                createRallarGameEnvelope({
                    protocol: 'ar-eye-hunter.v1',
                    kind: 'intent',
                    roomId: 'arena-1',
                    senderId: 'peer-1',
                    seq: 1,
                    directorEpoch: 1,
                    sentAtEpochMs: fixture.nowEpochMs,
                    payload: fixture.message
                })
            );
        }
        networkEnabled = false;
        const replacement = toArenaSnapshot(createInitialArenaState(12, fixture.nowEpochMs), 'replacement', fixture.nowEpochMs);
        snapshot = replacement;
        activeEvent = undefined;
        events = [];
        input.arenaSnapshotRef.current = replacement;
        input.roomIdRef.current = 'replacement';
        for (const update of pendingSnapshots) {
            snapshot = typeof update === 'function' ? update(snapshot) : update;
        }
        for (const update of pendingActiveEvents) {
            activeEvent = typeof update === 'function' ? update(activeEvent) : update;
        }
        for (const update of pendingEvents) {
            events = typeof update === 'function' ? update(events) : update;
        }
        expect(snapshot).toBe(replacement);
        expect(input.arenaSnapshotRef.current).toBe(replacement);
        expect(activeEvent).toBeUndefined();
        expect(events).toEqual([]);
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
        await vi.waitFor(async () => {
            await act(async () => {
                await Promise.resolve();
            });
            expect(predicate()).toBe(true);
        });
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

function createDeferred<T>() {
    return Promise.withResolvers<T>();
}

interface AcceptedIntentFixture {
    readonly nowEpochMs: number;
    readonly snapshot: ArenaSnapshot;
    readonly message: GameRealtimeMessage;
}

function acceptedIntentFixture(kind: 'hit' | 'pickup', peerId = 'peer-1'): AcceptedIntentFixture {
    const nowEpochMs = Date.now();
    const initial = spawnWeaponPickup(createInitialArenaState(44, nowEpochMs), nowEpochMs, 'audit-pea-shooter');
    const pickup = initial.pickups[0];
    const player: PlayerPose = {
        sessionId: peerId,
        username: 'peer',
        color: '#00ffaa',
        position: kind === 'pickup' ? pickup.position : [0, 1.72, 0],
        rotation: [0, 0, 0],
        vitals: createInitialVitalsState(),
        score: 0,
        seq: 1,
        sentAtEpochMs: nowEpochMs
    };
    const state = upsertPlayerPose(upsertPlayerPose(initial, player, nowEpochMs), {
        ...player,
        sessionId: 'target',
        position: [0, 1.72, 9]
    }, nowEpochMs);
    const message: GameRealtimeMessage = kind === 'pickup'
        ? {
            protocol: 'ar-eye-hunter.v1',
            kind: 'pickup-intent',
            intent: { pickupId: pickup.id, sessionId: peerId, position: pickup.position, seq: 1, sentAtEpochMs: nowEpochMs }
        }
        : {
            protocol: 'ar-eye-hunter.v1',
            kind: 'player-hit-intent',
            intent: {
                shot: {
                    sessionId: peerId,
                    username: 'peer',
                    color: '#00ffaa',
                    origin: [0, 1.72, 0],
                    direction: [0, 0, 1],
                    seq: 1,
                    sentAtEpochMs: nowEpochMs
                },
                targetSessionId: 'target',
                predictedImpact: [0, 1.72, 9],
                sentAtEpochMs: nowEpochMs
            }
        };
    return { nowEpochMs, snapshot: toArenaSnapshot(state, 'arena-1', nowEpochMs), message };
}

function peerShotMessage(roomRef: GroupRef | undefined) {
    return {
        protocol: 'ar-eye-hunter.v1' as const,
        kind: 'director-shot-accepted' as const,
        roomRef,
        accepted: {
            shot: {
                sessionId: 'peer-1',
                username: 'peer',
                color: '#00ffaa',
                origin: [0, 2, 0] as const,
                direction: [0, 0, 1] as const,
                seq: 1,
                sentAtEpochMs: 1000
            },
            hit: true,
            targetId: 'eye-1',
            impact: [0, 2, 4] as const,
            scoreDelta: 120,
            combo: 2,
            multiplier: 1,
            overdrive: 20,
            revision: 3,
            acceptedAtEpochMs: 1000
        }
    };
}

function emptyArenaMatchStatus(): RallarGameMatchStatus {
    return {
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
    };
}
