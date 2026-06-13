// @vitest-environment happy-dom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarAuthState } from '@shared-web/browser/rallar.ts';
import { useRallarArena, type ArenaConnection } from '../../../apps/ar-eye-hunter-v1/src/game/useRallarArena.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session: AuthSession = {
    clientId: 'hunter-1',
    accessToken: 'token-1',
    username: 'hunter',
    sessionId: 'session-1',
    expiresAtEpochMs: Date.now() + 60_000,
};

const authListeners = new Set<(state: RallarAuthState) => void | Promise<void>>();
const unsubscribe = vi.fn();
const mockMatch = vi.hoisted(() => ({
    stop: vi.fn(),
    status: vi.fn(() => ({ directorPeerId: undefined, directorIsFresh: false })),
    diagnostics: vi.fn(() => ({
        generatedAtEpochMs: 1,
        phase: 'starting',
        directorIsFresh: false,
        recovery: { status: 'idle' },
        knownPeerIds: [],
        readyPeerIds: [],
        notReadyPeerIds: [],
        capabilityCount: 0,
        rtcPeerCount: 0,
        realtimeHealth: [],
        issues: [],
    })),
    start: vi.fn(() => Promise.resolve()),
    reportCapability: vi.fn(() => Promise.resolve({ status: 'sent' })),
    appointIfElected: vi.fn(() => Promise.resolve({
        status: 'not-elected',
        election: {
            candidates: [],
            nowEpochMs: 1,
            capabilityTtlMs: 10_000,
        },
        reason: 'The local peer is not the elected host.',
    })),
    onStatus: vi.fn(() => vi.fn()),
    waitForReadyLanes: vi.fn(() => Promise.resolve()),
    publishEvent: vi.fn(),
    publishSnapshot: vi.fn(),
    sendIntent: vi.fn(),
    sendInput: vi.fn(),
    requestSync: vi.fn(() => Promise.resolve({ status: 'sent' })),
}));
const mockRallar = vi.hoisted(() => ({
    auth: {
        restore: vi.fn(),
        onChange: vi.fn(),
        login: vi.fn(),
        registerAndLogin: vi.fn(),
        logout: vi.fn(),
    },
    start: vi.fn(),
    rooms: {
        state: vi.fn(),
        onChange: vi.fn(),
        refresh: vi.fn(),
        create: vi.fn(),
        join: vi.fn(),
    },
    director: {
        status: vi.fn(),
        onStatus: vi.fn(),
        appoint: vi.fn(),
    },
    realtime: {
        onJson: vi.fn(),
        sendJson: vi.fn(),
        health: vi.fn(),
    },
    rtc: {
        status: vi.fn(),
        waitForRoomLane: vi.fn(),
        diagnostics: vi.fn(),
    },
    ws: {
        status: vi.fn(),
    },
    subscriptions: vi.fn(),
}));

vi.mock('@shared-web/browser/rallar.ts', () => ({
    rallar: mockRallar,
}));

vi.mock('@shared-web/browser/api-integration.ts', () => ({
    readApiConfig: vi.fn(() => Promise.resolve({
        apiBaseUrl: 'https://api.test',
        wsBaseUrl: 'wss://api.test',
    })),
    readIceCandidates: vi.fn(() => Promise.resolve({
        iceServers: [
            { urls: 'stun:stun.test' },
        ],
    })),
}));

vi.mock('@shared-web/browser/rallar-ai.ts', () => ({
    createRallarBrowserAi: () => ({
        complete: vi.fn(),
    }),
}));

vi.mock('../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts', async (importOriginal) => {
    const actual = await importOriginal<object>();
    return {
        ...actual,
        createArenaRallarGameMatch: vi.fn(() => mockMatch),
    };
});

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
                        name: 'Arena: Vector Circuit',
                    },
                ],
                currentRoomId: 'arena-1',
            },
        });
        mockRallar.rooms.state.mockReturnValue({
            rooms: [],
            currentRoomId: undefined,
        });
        mockRallar.director.status.mockReturnValue({
            role: 'none',
            state: 'none',
            isDirector: false,
            isFresh: false,
        });
        mockRallar.subscriptions.mockReturnValue({
            add: vi.fn().mockReturnThis(),
            unsubscribe: vi.fn(),
        });
        mockRallar.realtime.onJson.mockReturnValue(vi.fn());
        mockRallar.realtime.health.mockReturnValue([]);
        mockRallar.rooms.onChange.mockReturnValue(vi.fn());
        mockRallar.director.onStatus.mockReturnValue(vi.fn());
        mockRallar.ws.status.mockReturnValue({
            connectState: 'connected',
            readyState: 'open',
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 5,
            reconnectExhausted: false,
        });
        mockRallar.rtc.status.mockReturnValue({
            laneId: 'motion',
            knownPeerIds: ['peer-b'],
            activePeerIds: ['peer-b'],
            peerIdsWithNoReconnectableLanes: [],
            readyPeerIds: ['peer-b'],
            peers: [],
        });
        mockRallar.rtc.diagnostics.mockResolvedValue({
            generatedAtEpochMs: 1,
            peerCount: 1,
            connectedPeerCount: 1,
            relayPeerCount: 0,
            peers: [],
        });
        mockRallar.rtc.waitForRoomLane.mockResolvedValue({
            status: 'closed',
            ready: [],
            notReady: [],
        });
        mockMatch.stop.mockClear();
        mockMatch.status.mockClear();
        mockMatch.diagnostics.mockClear();
        mockMatch.start.mockClear();
        mockMatch.reportCapability.mockClear();
        mockMatch.appointIfElected.mockClear();
        mockMatch.onStatus.mockClear();
        mockMatch.waitForReadyLanes.mockClear();
        mockMatch.publishEvent.mockClear();
        mockMatch.publishSnapshot.mockClear();
        mockMatch.sendIntent.mockClear();
        mockMatch.sendInput.mockClear();
        mockMatch.requestSync.mockClear();
    });

    afterEach(async () => {
        if (root) {
            await act(async () => root?.unmount());
        }
        root = undefined;
        container.remove();
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
            reason: 'expired',
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

    it('records director appointment attempts and exposes transport diagnostics', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        await waitForState(() => current?.directorAttempt.status === 'not-elected');

        expect(current?.directorAttempt).toMatchObject({
            source: 'auto',
            status: 'not-elected',
            reason: 'The local peer is not the elected host.',
        });

        mockMatch.appointIfElected.mockResolvedValueOnce({
            status: 'failed',
            election: {
                candidates: [],
                nowEpochMs: 2,
                capabilityTtlMs: 10_000,
            },
            reason: 'director write timed out',
        });

        await act(async () => {
            await current?.appointSelfAsDirector();
        });

        expect(current?.directorAttempt).toMatchObject({
            source: 'manual',
            status: 'failed',
            reason: 'director write timed out',
        });

        await act(async () => {
            await current?.refreshDiagnostics({ includeRtcStats: true });
        });

        expect(current?.transportDiagnostics.ws?.readyState).toBe('open');
        expect(current?.transportDiagnostics.rtc?.readyPeerIds).toEqual(['peer-b']);
        expect(current?.transportDiagnostics.rtcDiagnostics?.connectedPeerCount).toBe(1);
        expect(current?.gameDiagnostics?.phase).toBe('starting');
    });

    it('does not auto-appoint regular room members who cannot update director metadata', async () => {
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
                    sessionIds: [session.sessionId],
                },
            ],
        });

        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        await waitForState(() => current?.directorAttempt.status === 'not-elected');

        expect(current?.directorAttempt).toMatchObject({
            source: 'auto',
            status: 'not-elected',
            resultStatus: 'not-authorized',
            reason: 'Only room owners/admins can appoint the browser director.',
        });
        expect(mockMatch.reportCapability).not.toHaveBeenCalled();
        expect(mockMatch.appointIfElected).not.toHaveBeenCalled();
    });

    it('still publishes the local director pose on the realtime motion lane', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');
        mockMatch.status.mockReturnValue({
            directorPeerId: session.sessionId,
            directorIsFresh: true,
        });

        await act(async () => {
            current?.sendPose({
                position: [1, 2, 3],
                rotation: [0, 0.5, 0],
                velocity: [0.1, 0, 0.2],
                score: 12,
                combo: 2,
                seq: 7,
                sentAtEpochMs: 123,
            });
        });

        expect(mockMatch.sendInput).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'player-pose-intent',
            pose: expect.objectContaining({
                sessionId: session.sessionId,
            }),
        }));
        expect(mockRallar.realtime.sendJson).toHaveBeenCalledWith(expect.objectContaining({
            laneId: 'motion',
            roomId: 'arena-1',
            key: `pose:${session.sessionId}`,
            data: expect.objectContaining({
                kind: 'player-pose',
                pose: expect.objectContaining({
                    sessionId: session.sessionId,
                    position: [1, 2, 3],
                }),
            }),
        }));
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
