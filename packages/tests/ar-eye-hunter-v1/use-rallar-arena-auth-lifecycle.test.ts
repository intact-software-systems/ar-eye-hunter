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
    },
    rtc: {
        waitForRoomLane: vi.fn(),
    },
    subscriptions: vi.fn(),
}));

vi.mock('@shared-web/browser/rallar.ts', () => ({
    rallar: mockRallar,
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
        createArenaRallarGameMatch: vi.fn(() => ({
            stop: vi.fn(),
            status: vi.fn(() => ({ directorPeerId: undefined })),
            start: vi.fn(() => Promise.resolve()),
            reportCapability: vi.fn(),
            appointIfElected: vi.fn(),
            onStatus: vi.fn(() => vi.fn()),
            waitForReadyLanes: vi.fn(() => Promise.resolve()),
            publishEvent: vi.fn(),
            publishSnapshot: vi.fn(),
            sendIntent: vi.fn(),
        })),
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
        mockRallar.rooms.onChange.mockReturnValue(vi.fn());
        mockRallar.director.onStatus.mockReturnValue(vi.fn());
        mockRallar.rtc.waitForRoomLane.mockResolvedValue({
            status: 'closed',
            ready: [],
            notReady: [],
        });
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
