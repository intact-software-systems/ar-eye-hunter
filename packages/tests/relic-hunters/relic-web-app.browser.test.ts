// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    RELIC_PROTOCOL_VERSION,
    applyRelicCommand,
    createRelicGame,
    toPublicRelicSnapshot,
    type RelicGameState,
    type RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

const rallarMock = vi.hoisted(() => ({
    session: undefined as AuthSession | undefined,
    roomState: undefined as unknown,
    connectCalls: 0,
    refreshCalls: 0,
    wsMessageHandler: undefined as
        | ((message: { payload: unknown }) => void)
        | undefined,
}));

const soundMock = vi.hoisted(() => ({
    startAmbientSound: vi.fn(() => true),
    stopAmbientSound: vi.fn(),
    isAmbientSoundPlaying: vi.fn(() => false),
    playActionSound: vi.fn(),
    playRelicEventSound: vi.fn(),
    playUiSound: vi.fn(),
}));

vi.mock('@shared-web/browser/rallar.ts', () => ({
    rallar: {
        auth: {
            restore: () => rallarMock.session,
            login: vi.fn(),
            registerAndLogin: vi.fn(),
            logout: vi.fn(),
        },
        connect: async () => {
            rallarMock.connectCalls += 1;
        },
        rooms: {
            refresh: async () => {
                rallarMock.refreshCalls += 1;
                return rallarMock.roomState;
            },
            onChange: () => () => undefined,
            create: vi.fn(),
            join: vi.fn(),
        },
        messages: {
            ws: {
                onMessage: (_selector: unknown, handler: (message: { payload: unknown }) => void) => {
                    rallarMock.wsMessageHandler = handler;
                    return () => {
                        rallarMock.wsMessageHandler = undefined;
                    };
                },
            },
        },
    },
}));

vi.mock('../../../apps/relic-hunters-v1/src/game/RelicScene.tsx', async () => {
    const React = await vi.importActual<typeof import('react')>('react');
    return {
        RelicScene: ({
            children,
            onPrimeAction,
        }: {
            children?: ReactNode;
            onPrimeAction?: (
                action:
                    | { kind: 'move'; targetRoomId: string }
                    | { kind: 'search' }
            ) => void;
        }) =>
            React.createElement(
                'div',
                { 'data-testid': 'relic-scene' },
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        'data-testid': 'scene-move-hallway',
                        onClick: () => onPrimeAction?.({
                            kind: 'move',
                            targetRoomId: 'hallway',
                        }),
                    },
                    'Move to Hallway',
                ),
                React.createElement(
                    'button',
                    {
                        type: 'button',
                        'data-testid': 'scene-search-clue',
                        onClick: () => onPrimeAction?.({ kind: 'search' }),
                    },
                    'Search clue',
                ),
                children,
            ),
    };
});

vi.mock('../../../apps/relic-hunters-v1/src/game/sound.ts', () => soundMock);

import App from '../../../apps/relic-hunters-v1/src/App.tsx';

describe('Relic Hunters browser app', () => {
    let root: Root | undefined;
    let container: HTMLDivElement;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        installMemoryLocalStorage();
        clearSession();
        vi.unstubAllGlobals();
        installMemoryLocalStorage();
        vi.clearAllMocks();
        rallarMock.session = session();
        rallarMock.roomState = roomState(1);
        rallarMock.connectCalls = 0;
        rallarMock.refreshCalls = 0;
        rallarMock.wsMessageHandler = undefined;
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        act(() => {
            root?.unmount();
        });
        root = undefined;
        container.remove();
        clearSession();
        vi.unstubAllGlobals();
    });

    it('asks players whether to restart when online room members no longer match the expedition roster', async () => {
        const snapshot = snapshotWithPlayers(2);
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => container.textContent?.includes('Party Changed') === true);

        expect(container.textContent).toContain('Party Changed');
        expect(container.textContent).toContain('1/2 hunters are online');
        expect(container.textContent).toContain('Start Over');
        expect(container.textContent).toContain('Keep Going');
    });

    it('starts ambient atmosphere from a browser button gesture', async () => {
        const snapshot = snapshotWithPlayers(1);
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => atmosphereButtons().length > 0);
        await act(async () => {
            atmosphereButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(soundMock.startAmbientSound).toHaveBeenCalledTimes(1);
    });

    it('updates the visible expedition when a Rallar WebSocket snapshot event arrives', async () => {
        const initial = snapshotWithPlayers(1);
        const updated = snapshotWithPlayers(2);
        writeSession(session());
        rallarMock.roomState = roomState(2);
        stubSnapshotFetch(initial);

        await renderApp();
        await waitFor(() => rallarMock.wsMessageHandler !== undefined);

        await act(async () => {
            rallarMock.wsMessageHandler?.({
                payload: {
                    protocolVersion: RELIC_PROTOCOL_VERSION,
                    gameId: updated.gameId,
                    snapshot: updated,
                },
            });
        });

        await waitFor(() => container.textContent?.includes('Bob') === true);
        expect(container.textContent).toContain('Bob');
        expect(container.textContent).toContain('Hunters');
        expect(container.textContent).toContain('2');
    });

    it('lets scene doorway prompts prime the normal turn-based move action', async () => {
        const snapshot = snapshotWithPlayers(1, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => sceneMoveButton() !== undefined);
        await act(async () => {
            sceneMoveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        const moveTarget = container.querySelector('select') as HTMLSelectElement | null;
        expect(moveTarget?.value).toBe('hallway');
        expect(container.textContent).toContain('Step into an adjacent room');
    });

    it('lets scene clue prompts prime the normal turn-based search action', async () => {
        const snapshot = snapshotWithPlayers(1, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => sceneMoveButton() !== undefined && sceneSearchButton() !== undefined);
        await act(async () => {
            sceneMoveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(container.textContent).toContain('Step into an adjacent room');

        await act(async () => {
            sceneSearchButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(container.textContent).toContain('Look for relics in this room');
    });

    async function renderApp(): Promise<void> {
        root = createRoot(container);
        await act(async () => {
            root?.render(createElement(App));
        });
    }

    function atmosphereButtons(): HTMLButtonElement[] {
        return Array.from(container.querySelectorAll('button'))
            .filter((button) => button.textContent === 'Atmosphere');
    }

    function sceneMoveButton(): HTMLButtonElement | undefined {
        return container.querySelector<HTMLButtonElement>('[data-testid="scene-move-hallway"]') ??
            undefined;
    }

    function sceneSearchButton(): HTMLButtonElement | undefined {
        return container.querySelector<HTMLButtonElement>('[data-testid="scene-search-clue"]') ??
            undefined;
    }
});

function session(): AuthSession {
    return {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'Alice',
        sessionId: 'alice-session',
        expiresAtEpochMs: Date.now() + 60_000,
    };
}

function roomState(onlineMemberCount: number): unknown {
    return {
        currentRoomId: 'room-1',
        rooms: [
            {
                roomId: 'room-1',
                name: 'Relic Hunters Expedition',
                status: 'active',
                kind: 'party',
                joinMode: 'open',
                memberCount: onlineMemberCount,
                onlineMemberCount,
                isJoined: true,
                isCurrent: true,
                snapshot: {},
            },
        ],
        members: [],
    };
}

function stubSnapshotFetch(snapshot: RelicPublicSnapshot): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
            new Response(JSON.stringify(snapshot), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        ),
    );
}

function snapshotWithPlayers(
    playerCount: 1 | 2,
    phase: 'lobby' | 'planning' = 'lobby',
): RelicPublicSnapshot {
    let state: RelicGameState = createRelicGame('room-1', 'room-1', 1);
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride',
    }, {
        senderId: 'alice-session',
        now: () => 2,
    }).state;

    if (playerCount === 2) {
        state = applyRelicCommand(state, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'Bob',
            characterId: 'nyra-vale',
        }, {
            senderId: 'bob-session',
            now: () => 3,
        }).state;
    }

    if (phase === 'planning') {
        state = applyRelicCommand(state, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'start-expedition',
            gameId: 'room-1',
            username: 'Alice',
        }, {
            senderId: 'alice-session',
            now: () => 4,
        }).state;
    }

    return toPublicRelicSnapshot(state);
}

async function waitFor(assertion: () => boolean, attempts = 20): Promise<void> {
    for (let index = 0; index < attempts; index += 1) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (assertion()) {
            return;
        }
    }

    throw new Error('Timed out waiting for browser app state.');
}

function installMemoryLocalStorage(): void {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
        removeItem: (key: string) => {
            values.delete(key);
        },
        clear: () => {
            values.clear();
        },
        key: (index: number) => Array.from(values.keys())[index] ?? null,
        get length() {
            return values.size;
        },
    } satisfies Storage);
}
