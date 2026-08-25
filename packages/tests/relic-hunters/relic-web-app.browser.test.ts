// @vitest-environment happy-dom

import {
    applyRelicCommand,
    createProceduralRelicExpeditionBlueprint,
    createRelicGame,
    createRelicGameFromBlueprint,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot,
    type RelicGameState,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import type { RallarWsSendInput } from '@shared-web/browser/rallar-message-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTimedOutRoundSnapshots } from './relic-timeout-snapshot-fixture.ts';

const rallarMock = vi.hoisted(() => ({
    session: undefined as AuthSession | undefined,
    roomState: undefined as unknown,
    connectCalls: 0,
    refreshCalls: 0,
    wsMessageHandler: undefined as
        | ((message: {
            payload: unknown;
            senderId: string;
            roomId?: string;
            receivedAtEpochMs: number;
        }) => void)
        | undefined,
    wsAiMessageHandler: undefined as
        | ((message: {
            payload: unknown;
            senderId: string;
            roomId?: string;
            receivedAtEpochMs: number;
        }) => void)
        | undefined,
    wsSend: vi.fn(async (input: RallarWsSendInput<Record<string, unknown>>) => ({
        transport: 'ws',
        status: 'queued',
        entries: []
    }))
}));

const soundMock = vi.hoisted(() => ({
    startAmbientSound: vi.fn(() => true),
    stopAmbientSound: vi.fn(),
    isAmbientSoundPlaying: vi.fn(() => false),
    playActionSound: vi.fn(),
    playRelicEventSound: vi.fn(),
    playUiSound: vi.fn()
}));

vi.mock('@shared-web/browser/rallar.ts', () => ({
    rallar: {
        auth: {
            restore: () => rallarMock.session,
            onChange: vi.fn((
                listener: (state: {
                    authenticated: boolean;
                    reason: 'current';
                    session?: AuthSession;
                }) => void,
                options?: { emitCurrent?: boolean; }
            ) => {
                if (options?.emitCurrent ?? true) {
                    listener({
                        authenticated: rallarMock.session !== undefined,
                        reason: 'current',
                        session: rallarMock.session
                    });
                }
                return () => undefined;
            }),
            login: vi.fn(),
            registerAndLogin: vi.fn(),
            logout: vi.fn()
        },
        session: () => rallarMock.session,
        connect: async () => {
            rallarMock.connectCalls += 1;
        },
        start: async () => {
            rallarMock.connectCalls += 1;
            return {
                session: rallarMock.session,
                connected: !!rallarMock.session,
                roomState: rallarMock.roomState
            };
        },
        subscriptions: () => {
            const scope = {
                add: () => scope,
                unsubscribe: () => undefined,
                size: () => 0
            };
            return scope;
        },
        rooms: {
            state: () => rallarMock.roomState,
            refresh: async () => {
                rallarMock.refreshCalls += 1;
                return rallarMock.roomState;
            },
            onChange: () => () => undefined,
            create: vi.fn(),
            join: vi.fn()
        },
        rtc: {
            onStatus: () => () => undefined,
            readyPeerIds: () => []
        },
        messages: {
            ws: {
                onMessage: (
                    selector: { topicId?: string; } | string,
                    handler: (message: {
                        payload: unknown;
                        senderId: string;
                        roomId?: string;
                        receivedAtEpochMs: number;
                    }) => void
                ) => {
                    const topicId = typeof selector === 'string' ? selector : selector.topicId;
                    if (topicId === 'room.relic.ai.planning') {
                        rallarMock.wsAiMessageHandler = handler;
                        return () => {
                            rallarMock.wsAiMessageHandler = undefined;
                        };
                    }
                    if (topicId !== 'room.relic.snapshot') {
                        return () => undefined;
                    }
                    rallarMock.wsMessageHandler = handler;
                    return () => {
                        rallarMock.wsMessageHandler = undefined;
                    };
                },
                send: rallarMock.wsSend
            },
            rtc: {
                onMessage: () => () => undefined,
                send: vi.fn(async () => ({ status: 'no-route' }))
            }
        },
        data: {
            open: vi.fn(async () => ({
                set: vi.fn(async () => undefined)
            }))
        },
        realtime: {
            sendJson: vi.fn(async () => [])
        }
    }
}));

async function importReactForSceneMock() {
    return await vi.importActual<typeof import('react')>('react');
}

function createMockRelicScene(React: typeof import('react')) {
    return ({
        children,
        onPrimeAction
    }: {
        children?: ReactNode;
        onPrimeAction?: (
            action:
                | { kind: 'move'; targetRoomId: string; }
                | { kind: 'search'; }
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
                    onClick: () =>
                        onPrimeAction?.({
                            kind: 'move',
                            targetRoomId: 'hallway'
                        })
                },
                'Move to Hallway'
            ),
            React.createElement(
                'button',
                {
                    type: 'button',
                    'data-testid': 'scene-search-clue',
                    onClick: () => onPrimeAction?.({ kind: 'search' })
                },
                'Search clue'
            ),
            children
        );
}

vi.mock('../../../apps/relic-hunters-v1/src/game/RelicScene.tsx', async () => {
    const React = await importReactForSceneMock();
    return {
        RelicScene: createMockRelicScene(React)
    };
});

vi.mock('../../../apps/relic-hunters-v1/src/game/RelicSceneNext.tsx', async () => {
    const React = await importReactForSceneMock();
    return {
        RelicSceneNext: createMockRelicScene(React)
    };
});

vi.mock('../../../apps/relic-hunters-v1/src/game/OpeningRelicScene.tsx', async () => {
    const React = await vi.importActual<typeof import('react')>('react');
    return {
        OpeningRelicScene: () => React.createElement('div', { 'data-testid': 'opening-relic-scene' })
    };
});

vi.mock('../../../apps/relic-hunters-v1/src/game/sound.ts', () => soundMock);

import App, { derivePartyCoordination } from '../../../apps/relic-hunters-v1/src/App.tsx';

describe('Relic Hunters browser app', () => {
    let root: Root | undefined;
    let container: HTMLDivElement;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;
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
        rallarMock.wsAiMessageHandler = undefined;
        rallarMock.wsSend.mockClear();
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
                    snapshot: updated
                },
                senderId: 'bob-session',
                roomId: 'room-1',
                receivedAtEpochMs: Date.now()
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

        const moveTarget = targetRoomButton('hallway');
        expect(moveTarget?.getAttribute('aria-pressed')).toBe('true');
        expect(container.textContent).toContain('Step into an adjacent room');
    });

    it('renders generated expedition snapshots through existing map and move controls', async () => {
        const snapshot = generatedSnapshotWithPlayers();
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => sceneMoveButton() !== undefined);

        expect(container.textContent).toContain('Test Keep Gatehouse');
        expect(container.textContent).toContain('Test Keep Long Gallery');

        await act(async () => {
            sceneMoveButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(targetRoomButton('hallway')?.textContent).toContain('Test Keep Long Gallery');
        expect(targetRoomButton('hallway')?.getAttribute('aria-pressed')).toBe('true');
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

    it('asks the browser AI companion for a legal planning suggestion', async () => {
        const snapshot = snapshotWithPlayers(1, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => aiAskButton() !== undefined);
        await act(async () => {
            aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        await waitFor(() => container.textContent?.includes('Suggestion ready') === true);
        expect(container.textContent).toContain('Move toward Hallway');
        expect(rallarMock.wsSend).toHaveBeenCalledWith(
            expect.objectContaining({
                topicId: 'room.relic.ai.planning',
                typeId: 'relic.ai.planning-proposal.v1',
                roomId: 'room-1'
            })
        );
    });

    it('primes the normal draft from a local browser AI suggestion', async () => {
        const snapshot = snapshotWithPlayers(1, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => aiAskButton() !== undefined);
        await act(async () => {
            aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await waitFor(() => aiPrimeButton() !== undefined);
        await act(async () => {
            aiPrimeButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(targetRoomButton('hallway')?.getAttribute('aria-pressed')).toBe('true');
        expect(container.textContent).toContain('Step into an adjacent room');
    });

    it('keeps Submit Plan on the REST command path after AI priming', async () => {
        const snapshot = snapshotWithPlayers(1, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(1);
        const fetchMock = stubSnapshotFetchSequence(snapshot, snapshot);

        await renderApp();
        await waitFor(() => aiAskButton() !== undefined);
        await act(async () => {
            aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await waitFor(() => aiPrimeButton() !== undefined);
        await act(async () => {
            aiPrimeButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await act(async () => {
            submitPlanButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(fetchMock.mock.calls.some(([url, init]) =>
            String(url).includes('/commands') &&
            String(init?.body).includes('"kind":"submit-action"') &&
            String(init?.body).includes('"targetRoomId":"hallway"')
        )).toBe(true);
    });

    it('renders received room AI proposals as read-only party notes', async () => {
        const snapshot = snapshotWithPlayers(2, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(2);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => aiAskButton() !== undefined);
        await act(async () => {
            aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await waitFor(() => rallarMock.wsSend.mock.calls.length > 0);
        const sent = rallarMock.wsSend.mock.calls[0]?.[0];
        await act(async () => {
            rallarMock.wsAiMessageHandler?.({
                payload: {
                    ...sent.payload,
                    generationId: 'remote-generation-1',
                    dedupeKey: 'remote-dedupe-1'
                },
                senderId: 'bob-session',
                roomId: 'room-1',
                receivedAtEpochMs: Date.now()
            });
        });

        await waitFor(() => container.textContent?.includes('Party Notes') === true);
        expect(container.textContent).toContain('Bob');
        expect(container.querySelectorAll('.relic-ai-prime')).toHaveLength(1);
    });

    it('shows an explicit locked-plan waiting state after the local plan is submitted', async () => {
        const snapshot = {
            ...snapshotWithPlayers(2, 'planning'),
            submittedPlayerIds: ['alice-session']
        };
        writeSession(session());
        rallarMock.roomState = roomState(2);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => container.textContent?.includes('Plan locked') === true);

        expect(container.textContent).toContain('Plan locked');
        expect(container.textContent).toContain('Plan submitted');
        expect(container.textContent).toContain('1 hunter still choosing');
    });

    it('repairs a timed-out force-resolved round from authoritative snapshot polling', async () => {
        const { timedOut, resolved } = createTimedOutRoundSnapshots();
        writeSession(session());
        rallarMock.roomState = roomState(2);
        const fetchMock = stubSnapshotFetchSequence(timedOut, resolved);

        await renderApp();
        await waitFor(() =>
            fetchMock.mock.calls.length >= 2 &&
            container.textContent?.includes('Plans revealed') === true
        );

        expect(container.textContent).not.toContain('Resolve Timed-Out Round');
        expect(container.textContent).not.toContain('1 timed-out hunter.');
        expect(container.textContent).toContain('Round 1 Review');
    });

    it('summarizes current-room occupants, readiness, and steal pressure', () => {
        const snapshot = {
            ...snapshotWithPlayers(2, 'planning'),
            submittedPlayerIds: ['alice-session'],
            players: [
                {
                    playerId: 'alice-session',
                    username: 'Alice',
                    characterId: 'kael-ironstride',
                    roomId: 'entrance',
                    health: 3,
                    escaped: false,
                    defeated: false,
                    score: 0,
                    relicIds: []
                },
                {
                    playerId: 'bob-session',
                    username: 'Bob',
                    characterId: 'nyra-vale',
                    roomId: 'entrance',
                    health: 3,
                    escaped: false,
                    defeated: false,
                    score: 5,
                    relicIds: ['sun-disk']
                },
                {
                    playerId: 'cara-session',
                    username: 'Cara',
                    characterId: 'oryn-starcoil',
                    roomId: 'hallway',
                    health: 2,
                    escaped: false,
                    defeated: false,
                    score: 1,
                    relicIds: []
                }
            ]
        } satisfies RelicPublicSnapshot;

        const summary = derivePartyCoordination(snapshot, 'alice-session', 'steal');

        expect(summary).toMatchObject({
            currentRoomName: 'Entrance',
            hereCount: 2,
            elsewhereCount: 1,
            activeCount: 3,
            submittedCount: 1,
            splitLabel: '2 hunters here / 1 elsewhere',
            readinessLabel: '1/3 plans locked',
            relicCarrierCount: 1,
            actionHint: 'Steal is possible here: Bob carries 1 relic.'
        });
        expect(summary?.roomOccupants.map((player) => player.username)).toEqual(['Alice', 'Bob']);
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

    function targetRoomButton(roomId: string): HTMLButtonElement | undefined {
        return container.querySelector<HTMLButtonElement>(`[data-target-room-id="${roomId}"]`) ??
            undefined;
    }

    function aiAskButton(): HTMLButtonElement | undefined {
        return Array.from(container.querySelectorAll<HTMLButtonElement>('#hud-ai button'))
            .find((button) => button.textContent === 'Ask');
    }

    function aiPrimeButton(): HTMLButtonElement | undefined {
        return container.querySelector<HTMLButtonElement>('.relic-ai-prime') ?? undefined;
    }

    function submitPlanButton(): HTMLButtonElement | undefined {
        return Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
            .find((button) => button.textContent?.includes('Submit Plan'));
    }
});

function session(): AuthSession {
    return {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'Alice',
        sessionId: 'alice-session',
        expiresAtEpochMs: Date.now() + 60_000
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
                snapshot: {}
            }
        ],
        members: []
    };
}

function stubSnapshotFetch(snapshot: RelicPublicSnapshot): void {
    stubSnapshotFetchSequence(snapshot);
}

function stubSnapshotFetchSequence(
    ...snapshots: readonly RelicPublicSnapshot[]
): ReturnType<typeof vi.fn> {
    let index = 0;
    const fetchMock = vi.fn(async () => {
        const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
        index += 1;
        return new Response(JSON.stringify(snapshot), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    });

    vi.stubGlobal(
        'fetch',
        fetchMock
    );
    return fetchMock;
}

function snapshotWithPlayers(
    playerCount: 1 | 2,
    phase: 'lobby' | 'planning' = 'lobby'
): RelicPublicSnapshot {
    let state: RelicGameState = createRelicGame('room-1', 'room-1', 1);
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride'
    }, {
        senderId: 'alice-session',
        now: () => 2
    }).state;

    if (playerCount === 2) {
        state = applyRelicCommand(state, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'Bob',
            characterId: 'nyra-vale'
        }, {
            senderId: 'bob-session',
            now: () => 3
        }).state;
    }

    if (phase === 'planning') {
        state = applyRelicCommand(state, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'start-expedition',
            gameId: 'room-1',
            username: 'Alice'
        }, {
            senderId: 'alice-session',
            now: () => 4
        }).state;
    }

    return toPublicRelicSnapshot(state);
}

function generatedSnapshotWithPlayers(): RelicPublicSnapshot {
    let state: RelicGameState = createRelicGameFromBlueprint(
        'room-1',
        'room-1',
        createProceduralRelicExpeditionBlueprint({
            seed: 'browser-generated',
            theme: 'Test Keep'
        }),
        1,
        {
            source: 'procedural',
            seed: 'browser-generated',
            theme: 'Test Keep',
            blueprintId: 'browser-generated'
        }
    );
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride'
    }, {
        senderId: 'alice-session',
        now: () => 2
    }).state;
    state = applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId: 'room-1',
        username: 'Alice'
    }, {
        senderId: 'alice-session',
        now: () => 3
    }).state;

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

    throw new Error(`Timed out waiting for browser app state: ${document.body.textContent?.slice(0, 1_000) ?? ''}`);
}

function installMemoryLocalStorage(): void {
    const values = new Map<string, string>();
    vi.stubGlobal(
        'localStorage',
        {
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
            }
        } satisfies Storage
    );
}
