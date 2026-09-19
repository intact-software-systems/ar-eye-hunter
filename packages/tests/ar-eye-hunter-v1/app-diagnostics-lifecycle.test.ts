// @vitest-environment happy-dom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toRallarRoomSummary } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import App from '../../../apps/ar-eye-hunter-v1/src/app.tsx';
import type { ArenaConnection } from '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/use-rallar-arena.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const mockArena = vi.hoisted(() => ({
    current: undefined as ArenaConnection | undefined,
    refreshDiagnostics: vi.fn(() => Promise.resolve())
}));

vi.mock('../../../apps/ar-eye-hunter-v1/src/game/BabylonArena.tsx', () => ({
    BabylonArena: () => createElement('div', { 'data-testid': 'arena-scene' })
}));

vi.mock('../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/use-rallar-arena.ts', () => ({
    useRallarArena: () => mockArena.current
}));

describe('AR Eye Hunter diagnostics lifecycle', () => {
    let root: Root | undefined;
    let container: HTMLDivElement;

    beforeEach(() => {
        vi.useFakeTimers();
        mockArena.refreshDiagnostics.mockClear();
        mockArena.current = createArenaConnection({ networkEnabled: true });
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) {
            await act(async () => root?.unmount());
        }
        root = undefined;
        container.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('stops diagnostics polling when the arena network is disabled', async () => {
        root = createRoot(container);
        await act(async () => {
            root?.render(createElement(App));
        });

        await act(async () => {
            findButton('Diag').click();
        });

        expect(mockArena.refreshDiagnostics).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(4_000);
        });

        expect(mockArena.refreshDiagnostics).toHaveBeenCalledTimes(2);

        mockArena.current = createArenaConnection({
            connectionState: 'signed-out',
            networkEnabled: false,
            logoutQuiesced: true,
            roomId: undefined,
            session: undefined
        });
        await act(async () => {
            root?.render(createElement(App));
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(4_000);
        });

        expect(mockArena.refreshDiagnostics).toHaveBeenCalledTimes(2);
    });

    it.each(
        [
            { state: 'pending', evidence: 'queued', reason: undefined, label: 'pending (queued)' },
            { state: 'confirmed', evidence: 'transport-accepted', reason: undefined, label: 'transport accepted (hop)' },
            { state: 'confirmed', evidence: 'acknowledged', reason: undefined, label: 'acknowledged (hop)' },
            { state: 'failed', evidence: 'rejected', reason: 'membership denied', label: 'failed: membership denied' },
            { state: 'unobservable', evidence: 'unobservable', reason: undefined, label: 'observation lost' },
            { state: 'expired', evidence: 'expired', reason: 'deadline elapsed', label: 'expired: deadline elapsed' },
            { state: 'superseded', evidence: 'superseded', reason: 'newer report', label: 'superseded: newer report' },
            { state: 'cancelled', evidence: 'cancelled', reason: undefined, label: 'cancelled' }
        ] as const
    )('shows capability delivery $state with its evidence beside the appointment', async ({ state, evidence, reason, label }) => {
        mockArena.current = createArenaConnection({
            directorAttempt: {
                source: 'manual',
                status: 'succeeded',
                resultStatus: 'appointed',
                startedAtEpochMs: 1,
                finishedAtEpochMs: 2,
                durationMs: 1,
                reason: undefined,
                capabilityDelivery: { state, evidence, reason }
            }
        });
        root = createRoot(container);
        await act(async () => {
            root?.render(createElement(App));
        });
        await act(async () => {
            findButton('Diag').click();
        });
        const diagnostics = container.querySelector('aside[aria-label="Arena diagnostics"]');
        const delivery = [...(diagnostics?.querySelectorAll('.diagnostics-row') ?? [])]
            .find((row) => row.querySelector('span')?.textContent === 'Capability delivery');
        expect(delivery?.querySelector('strong')?.textContent).toBe(label);
        expect(diagnostics?.textContent).toContain('manual succeeded');
        expect(diagnostics?.querySelector('pre')?.textContent).toContain('"capabilityDelivery"');
    });

    it('reports a rejected clipboard write and releases a pending copy when the drawer closes', async () => {
        const pendingCopy = Promise.withResolvers<void>();
        const writeText = vi.fn<(text: string) => Promise<void>>()
            .mockRejectedValueOnce(new Error('Clipboard permission denied'))
            .mockReturnValueOnce(pendingCopy.promise);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        root = createRoot(container);
        await act(async () => root?.render(createElement(App)));
        await act(async () => findButton('Diag').click());
        await act(async () => findButton('Copy JSON').click());
        expect(findButton('Copy failed')).toBeDefined();
        expect(JSON.parse(writeText.mock.calls[0][0]).directorAttempt).toEqual({ status: 'idle' });
        await act(async () => findButton('Copy failed').click());
        await act(async () => findButton('Close').click());
        const timersAfterClose = vi.getTimerCount();
        await act(async () => pendingCopy.resolve());
        expect(vi.getTimerCount()).toBe(timersAfterClose);
        await act(async () => findButton('Diag').click());
        expect(findButton('Copy JSON')).toBeDefined();
    });

    function findButton(label: string): HTMLButtonElement {
        const button = [...container.querySelectorAll('button')]
            .find((item) => item.textContent === label);
        expect(button).toBeInstanceOf(HTMLButtonElement);
        return button as HTMLButtonElement;
    }
});

function createArenaRoomSnapshot(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        groupId: 'arena-1',
        sessionIds: ['hunter-1']
    });
    return {
        ...snapshot,
        group: { ...snapshot.group, displayName: 'Arena: Vector Circuit' }
    };
}

const arenaConnectionDefaults: Omit<ArenaConnection, 'session' | 'rooms' | 'connectionState' | 'error' | 'roomId'> = {
    directorStatus: {
        role: 'none',
        state: 'none',
        isDirector: false,
        isFresh: false,
        active: false,
        freshness: 'none',
        nowEpochMs: Date.now()
    },
    rtcLanes: [],
    directorAttempt: { status: 'idle' },
    gameDiagnostics: undefined,
    transportDiagnostics: {
        realtimeHealth: [],
        ws: {
            connectState: 'connected',
            readyState: 'open',
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 5,
            reconnectExhausted: false
        }
    },
    httpDiagnostics: {
        apiConfig: { status: 'idle' },
        ice: { status: 'idle' }
    },
    linkState: {
        label: 'solo',
        tone: 'live',
        detail: 'Solo systems hot.',
        playerCount: 0,
        actionNeeded: false
    },
    presenceNotices: [],
    authStorageKind: 'session',
    authGeneration: 1,
    networkEnabled: true,
    logoutQuiesced: false,
    aiStatus: 'idle',
    aiError: undefined,
    activeEvent: undefined,
    arenaSnapshot: undefined,
    remoteEvents: [],
    remotePlayers: new Map(),
    remoteShots: [],
    remotePlayerHits: [],
    pickupAcceptances: [],
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    refreshRooms: vi.fn(),
    createArenaRoom: vi.fn(),
    joinRoom: vi.fn(),
    appointSelfAsDirector: vi.fn(),
    refreshDiagnostics: mockArena.refreshDiagnostics,
    requestArenaSync: vi.fn(),
    dismissPresenceNotice: vi.fn(),
    sendPose: vi.fn(),
    sendShot: vi.fn(),
    sendPlayerHit: vi.fn(),
    sendPickupIntent: vi.fn(),
    startArenaMatch: vi.fn(),
    publishArenaSnapshot: vi.fn()
};

function createArenaConnection(
    overrides: Partial<ArenaConnection> = {}
): ArenaConnection {
    const arenaRoomSnapshot = createArenaRoomSnapshot();
    return {
        session: {
            clientId: 'hunter-1',
            accessToken: 'token-1',
            username: 'hunter',
            sessionId: 'session-1',
            expiresAtEpochMs: Date.now() + 60_000
        },
        connectionState: 'connected',
        error: undefined,
        roomId: 'arena-1',
        rooms: [
            toRallarRoomSummary({
                snapshot: arenaRoomSnapshot,
                sessionId: 'session-1',
                currentRoomRef: arenaRoomSnapshot.group
            })
        ],
        ...arenaConnectionDefaults,
        ...overrides
    };
}
