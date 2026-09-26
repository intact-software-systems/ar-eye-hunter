import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, vi } from 'vitest';

import type { RallarAuthState, RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { RallarGameMatchStatus, RallarGamePeerReadiness } from '@shared-web/game/mod.ts';

import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { useRallarArena, type ArenaConnection } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/use-rallar-arena.ts';
import type { ArenaRallarGameMatchHandle } from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import { createInitialArenaState, toArenaSnapshot } from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';

export { mockMatch, mockRallar };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

export const session: AuthSession = {
    clientId: 'hunter-1',
    accessToken: 'token-1',
    username: 'hunter',
    sessionId: 'session-1',
    expiresAtEpochMs: Date.now() + 60_000
};

export const arenaRoomRef: GroupRef = { applicationId: 'ar-eye-hunter', workspaceId: 'players', groupId: 'arena-1' };

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
    publishEvent: vi.fn<ArenaRallarGameMatchHandle['publishEvent']>(() => Promise.resolve({ status: 'sent' })),
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
        const actual = await importOriginal<typeof import('../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts')>();
        return {
            ...actual,
            createArenaRallarGameMatch: vi.fn(() => mockMatch)
        };
    }
);

export namespace ArenaRuntimeTestHarness {
    export interface Mounted {
        readonly root: Root;
        readonly container: HTMLDivElement;
    }
}

export class ArenaRuntimeTestHarness {
    current: ArenaConnection | undefined;
    private mounted: ArenaRuntimeTestHarness.Mounted | undefined;

    reset(): void {
        this.current = undefined;
        resetArenaSessionFixture();
        resetArenaRoomsFixture();
        resetArenaRealtimeFixture();
        resetArenaDiagnosticsFixture();
        resetArenaMatchFixture();
    }

    async render(): Promise<void> {
        if (this.mounted) {
            throw new Error('The arena fixture is already mounted.');
        }
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        this.mounted = { root, container };
        const owner = this;
        function Harness() {
            owner.current = useRallarArena();
            return null;
        }
        await act(async () => root.render(createElement(Harness)));
    }

    async unmount(): Promise<void> {
        const mounted = this.mounted;
        if (!mounted) {
            return;
        }
        await act(async () => mounted.root.unmount());
        mounted.container.remove();
        this.mounted = undefined;
        this.current = undefined;
    }

    async dispose(): Promise<void> {
        await this.unmount();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    }
}

export async function emitAuthState(state: RallarAuthState): Promise<void> {
    await act(async () => {
        for (const listener of authListeners) {
            await listener(state);
        }
    });
}

export async function waitForState(predicate: () => boolean): Promise<void> {
    await vi.waitFor(async () => {
        await act(async () => {
            await Promise.resolve();
        });
        expect(predicate()).toBe(true);
    });
}

function resetArenaSessionFixture(): void {
    authListeners.clear();
    unsubscribe.mockClear();
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
    mockRallar.subscriptions.mockReturnValue({
        add: vi.fn().mockReturnThis(),
        unsubscribe: vi.fn()
    });
}

function resetArenaRoomsFixture(): void {
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
    mockRallar.rooms.onChange.mockReturnValue(vi.fn());
    mockRallar.rooms.refresh.mockResolvedValue({
        rooms: [],
        currentRoomId: undefined
    });
    mockRallar.rooms.create.mockReset();
    mockRallar.rooms.createAndSwitch.mockReset();
    mockRallar.director.onStatus.mockReturnValue(vi.fn());
}

function resetArenaRealtimeFixture(): void {
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
}

function resetArenaDiagnosticsFixture(): void {
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
}

function resetArenaMatchFixture(): void {
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
}

export function freshDirectorStatus(): RallarDirectorStatus {
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

export function arenaSnapshot(revision: number) {
    return {
        ...toArenaSnapshot(
            {
                ...createInitialArenaState(1_000, 1_000),
                revision
            },
            'arena-1',
            1_000 + revision
        ),
        revision
    };
}

export function emptyPeerReadiness(): RallarGamePeerReadiness {
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
