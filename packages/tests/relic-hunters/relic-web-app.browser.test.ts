// @vitest-environment happy-dom

import {
    applyRelicCommand,
    createProceduralRelicExpeditionBlueprint,
    createRelicGame,
    createRelicGameFromBlueprint,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    toPublicRelicSnapshot,
    type RelicActionInput,
    type RelicGameState,
    type RelicHunterEvent,
    type RelicPublicSnapshot,
    type RelicRoundTransitionEvent
} from '@relic-hunters/mod.ts';
import { BrowserRallarSubscriptionScope } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type {
    RallarMessage,
    RallarMessageReplyOutcome,
    RallarTypedPayloadHandler,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRoomState } from '@shared-web/browser/rallar.ts';
import {
    newALBroadcastMessage,
    newALPrincipalBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { createInitialALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { createRallarAiJsonResult, createRallarAiMockProvider, type RallarAiJsonRequest } from '@shared/rallar-ai/mod.ts';
import {
    act,
    createElement,
    type ReactNode
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createBrowserTestStorage } from '../shared-test/browser-test-storage.ts';
import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { createTimedOutRoundSnapshots } from './relic-timeout-snapshot-fixture.ts';
import { requireRelicCommandApplied } from './require-relic-command-applied.ts';

interface MockWsMessage {
    readonly payload: object;
    readonly raw: ALMessage;
    readonly senderId: string;
    readonly roomId?: string;
    readonly receivedAtEpochMs: number;
}

type PlanningRequestAnswer = (
    request: RallarAiJsonRequest,
    signal: AbortSignal | undefined
) => RallarMessageReplyOutcome<object> | Promise<RallarMessageReplyOutcome<object>>;

const rallarMock = vi.hoisted(() => ({
    session: undefined as AuthSession | undefined,
    roomState: undefined as RallarRoomState | undefined,
    connectCalls: 0,
    refreshCalls: 0,
    wsMessageHandler: undefined as ((message: MockWsMessage) => void) | undefined,
    wsAiMessageHandler: undefined as ((message: MockWsMessage) => void) | undefined,
    roundTransitionHandler: undefined as RallarTypedPayloadHandler<RelicRoundTransitionEvent> | undefined,
    hunterEventHandler: undefined as RallarTypedPayloadHandler<RelicHunterEvent> | undefined,
    serverPeerId: undefined as string | undefined,
    answerPlanningRequest: undefined as PlanningRequestAnswer | undefined,
    planningRequests: [] as RallarAiJsonRequest[],
    localPlanningProviderOff: false,
    localGenerateJson: vi.fn(),
    /** Set, the planning send settles only when this does: a rejection is a send the transport refused. */
    planningSendSettled: undefined as Promise<void> | undefined,
    wsSend: vi.fn(async (input: RallarWsSendInput<object>) => ({
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
        // Absent unless a test sets it: commands then take the REST fallback these tests read (C13).
        serverPeerId: () => rallarMock.serverPeerId,
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
        subscriptions: () => new BrowserRallarSubscriptionScope(),
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
                    handler: (message: MockWsMessage) => void
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
            },
            room: (definition: { topicId: string; }) => ({
                onWs: <T>(handler: RallarTypedPayloadHandler<T>) => {
                    if (definition.topicId === 'room.relic.hunter') {
                        rallarMock.hunterEventHandler = handler as RallarTypedPayloadHandler<RelicHunterEvent>;
                        return () => {
                            rallarMock.hunterEventHandler = undefined;
                        };
                    }
                    if (definition.topicId !== RELIC_TOPICS.event) {
                        return () => undefined;
                    }
                    rallarMock.roundTransitionHandler = handler as RallarTypedPayloadHandler<RelicRoundTransitionEvent>;
                    return () => {
                        rallarMock.roundTransitionHandler = undefined;
                    };
                },
                sendRtc: async () => ({ wait: async () => ({ lifecycle: { state: 'transport-accepted' as const } }) }),
                sendWs: async (request: RallarAiJsonRequest) => {
                    if (definition.topicId !== RELIC_TOPICS.aiPlanning || rallarMock.answerPlanningRequest === undefined) {
                        throw new Error(`Unexpected WS send on ${definition.topicId}`);
                    }
                    rallarMock.planningRequests.push(request);
                    await rallarMock.planningSendSettled;
                    const answer = rallarMock.answerPlanningRequest;
                    return {
                        awaitReply: async (options: { readonly signal?: AbortSignal; }) => await answer(request, options.signal)
                    };
                }
            })
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

interface MockRelicSceneProps {
    readonly children?: ReactNode;
    readonly onPrimeAction?: (action: RelicActionInput) => void;
}
function MockRelicScene({ children, onPrimeAction }: MockRelicSceneProps) {
    return createElement(
        'div',
        { 'data-testid': 'relic-scene' },
        createElement('button', {
            type: 'button',
            'data-testid': 'scene-move-hallway',
            onClick: () => onPrimeAction?.({ kind: 'move', targetRoomId: 'hallway' })
        }, 'Move to Hallway'),
        createElement('button', { type: 'button', 'data-testid': 'scene-search-clue', onClick: () => onPrimeAction?.({ kind: 'search' }) }, 'Search clue'),
        children
    );
}

vi.mock('../../../apps/relic-hunters-v1/src/game/RelicSceneNext.tsx', () => ({ RelicSceneNext: MockRelicScene }));

vi.mock('../../../apps/relic-hunters-v1/src/game/OpeningRelicScene.tsx', async () => {
    const React = await vi.importActual<typeof import('react')>('react');
    return {
        OpeningRelicScene: () => React.createElement('div', { 'data-testid': 'opening-relic-scene' })
    };
});

vi.mock('../../../apps/relic-hunters-v1/src/game/sound.ts', () => soundMock);

// A production build has no local planning provider; these tests run as a test build, which has one.
vi.mock('../../../apps/relic-hunters-v1/src/game/ai/create-default-relic-planning-ai-provider.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../apps/relic-hunters-v1/src/game/ai/create-default-relic-planning-ai-provider.ts')>();
    return {
        createDefaultRelicPlanningAiProvider: () => {
            const provider = rallarMock.localPlanningProviderOff ? undefined : actual.createDefaultRelicPlanningAiProvider();
            return provider && {
                ...provider,
                generateJson: (request: RallarAiJsonRequest) => {
                    rallarMock.localGenerateJson();
                    return provider.generateJson(request);
                }
            };
        }
    };
});

import App from '../../../apps/relic-hunters-v1/src/app.tsx';
import { computePartyCoordination } from '../../../apps/relic-hunters-v1/src/game/hud/relic-party.tsx';

describe('Relic Hunters browser app', () => {
    let root: Root | undefined;
    let container: HTMLDivElement;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;
        vi.unstubAllGlobals();
        vi.stubGlobal('localStorage', createBrowserTestStorage());
        vi.stubGlobal('sessionStorage', createBrowserTestStorage());
        localStorage.clear();
        sessionStorage.clear();
        window.history.replaceState(null, '', '/');
        vi.clearAllMocks();
        rallarMock.session = session();
        rallarMock.roomState = roomState(1);
        rallarMock.connectCalls = 0;
        rallarMock.refreshCalls = 0;
        rallarMock.wsMessageHandler = undefined;
        rallarMock.wsAiMessageHandler = undefined;
        rallarMock.roundTransitionHandler = undefined;
        rallarMock.hunterEventHandler = undefined;
        rallarMock.serverPeerId = undefined;
        rallarMock.answerPlanningRequest = undefined;
        rallarMock.planningRequests = [];
        rallarMock.localPlanningProviderOff = false;
        rallarMock.planningSendSettled = undefined;
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

    it('withholds keeper controls when the authoritative snapshot assigns no administrator', async () => {
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch({ ...snapshotWithPlayers(1), adminPlayerId: undefined });

        await renderApp();
        await waitFor(() => container.textContent?.includes('Alice') === true);

        expect(container.querySelector('.lobby-begin-btn')).toBeNull();
        expect(container.querySelector('.timer-limit-selector')).toBeNull();
        expect(container.querySelector('.lobby-waiting-admin')).not.toBeNull();
        expect(container.querySelector('.lobby-role-badge')).toBeNull();
        expect(container.querySelector('.lobby-keeper-watch')?.textContent).toBe('No Keeper is assigned.');
        expect(container.textContent).not.toContain('Only Alice can start');
        expect(container.textContent).toContain('A Keeper must be assigned before the hunt can start.');
    });

    it('shows whether ambient playback started after a browser button gesture', async () => {
        const snapshot = snapshotWithPlayers(1);
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => atmosphereButtons().length > 0);
        soundMock.startAmbientSound.mockReturnValueOnce(false);
        await act(async () => {
            atmosphereButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(atmosphereButtons()[0].classList.contains('active')).toBe(false);

        await act(async () => {
            atmosphereButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(atmosphereButtons()[0].classList.contains('active')).toBe(true);
    });

    it('updates the visible expedition when a Rallar WebSocket snapshot event arrives', async () => {
        rallarMock.serverPeerId = 'default-qbox-server';
        const initial = snapshotWithPlayers(1);
        const updated = snapshotWithPlayers(2);
        writeSession(session());
        rallarMock.roomState = roomState(2);
        stubSnapshotFetch(initial);

        await renderApp();
        await waitFor(() => rallarMock.wsMessageHandler !== undefined);

        await act(async () => {
            rallarMock.wsMessageHandler?.(snapshotMessage(updated));
        });

        await waitFor(() => container.textContent?.includes('Bob') === true);
        expect(container.textContent).toContain('Bob');
        expect(container.textContent).toContain('Hunters');
        expect(container.textContent).toContain('2');
    });

    it('cues a phase banner from the room\'s ordered round transition, not from a snapshot that moves the phase', async () => {
        rallarMock.serverPeerId = 'default-qbox-server';
        writeSession(session());
        rallarMock.roomState = roomState(2);
        stubSnapshotFetch(snapshotWithPlayers(2));

        await renderApp();
        await waitFor(() => rallarMock.wsMessageHandler !== undefined && rallarMock.roundTransitionHandler !== undefined);
        const planning = snapshotWithPlayers(2, 'planning');
        await act(async () => {
            rallarMock.wsMessageHandler?.(snapshotMessage(planning));
        });
        await waitFor(() => container.textContent?.includes('Submit Plan') === true);
        expect(container.querySelector('.phase-banner')).toBeNull();

        await act(async () => {
            await rallarMock.roundTransitionHandler?.(ROUND_STARTED, toRoundTransitionMessage(ROUND_STARTED));
        });

        const banner = container.querySelector('.phase-banner.phase-banner-start');
        expect(banner?.textContent).toContain('The Hunt Begins!');
    });

    it('shows the rule text of a refused command where the command error shows', async () => {
        writeSession(session());
        rallarMock.roomState = roomState(2);
        stubSnapshotFetch(snapshotWithPlayers(2, 'planning'));

        await renderApp();
        await waitFor(() => rallarMock.hunterEventHandler !== undefined);
        expect(container.querySelector('.error-panel')).toBeNull();
        await act(async () => {
            await rallarMock.hunterEventHandler?.(REFUSED, toHunterEventMessage(REFUSED));
        });

        expect(container.querySelector('.error-panel')?.textContent).toBe('Round timer has not expired.');
    });

    it('shows nothing of a refused command or a recorded action of the hunter\'s other session, which is another player', async () => {
        writeSession(session());
        rallarMock.roomState = roomState(2);
        // A round that has just started, so the page does not submit for the hunter when its timer runs out.
        stubSnapshotFetch({ ...snapshotWithPlayers(2, 'planning'), roundStartedAtEpochMs: Date.now() });

        await renderApp();
        await waitFor(() => rallarMock.hunterEventHandler !== undefined && submitPlanButton() !== undefined);
        await act(async () => {
            for (const event of [{ ...REFUSED, playerId: 'alice-tablet' }, { ...RECORDED, playerId: 'alice-tablet' }]) {
                await rallarMock.hunterEventHandler?.(event, toHunterEventMessage(event));
            }
        });

        expect(container.querySelector('.error-panel')).toBeNull();
        expect(container.querySelector('.action-command-panel')?.textContent).not.toContain('Search this room');
    });

    it('leaves the locked-plan card the one display of the plan this session submitted', async () => {
        writeSession(session());
        rallarMock.roomState = roomState(2);
        // A round that has just started, so the page does not submit for the hunter when its timer runs out.
        stubSnapshotFetch({ ...snapshotWithPlayers(2, 'planning'), roundStartedAtEpochMs: Date.now() });

        await renderApp();
        await waitFor(() => rallarMock.hunterEventHandler !== undefined && submitPlanButton() !== undefined);
        await act(async () => {
            await rallarMock.hunterEventHandler?.(RECORDED, toHunterEventMessage(RECORDED));
        });

        expect(container.querySelector('.action-command-panel')?.textContent).not.toContain('Search this room');
    });

    it('primes a scene move, then uses the newly selected map room when choosing Move again', async () => {
        const snapshot = { ...snapshotWithPlayers(1, 'planning'), roundStartedAtEpochMs: Date.now() };
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
        const storage = Array.from(container.querySelectorAll<HTMLButtonElement>('.castle-map-room'))
            .find((button) => button.querySelector('.castle-map-room-name')?.textContent === 'Storage');
        expect(storage).toBeDefined();
        await act(async () => storage?.click());
        await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })));
        expect(targetRoomButton('storage')?.getAttribute('aria-pressed')).toBe('true');
        expect(targetRoomButton('hallway')?.getAttribute('aria-pressed')).toBe('false');
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

    it('asks the browser AI companion for a legal planning suggestion and sends it to the hunter\'s own sessions in the room', async () => {
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
                roomId: 'room-1',
                scope: 'principal',
                principalId: 'client-1'
            })
        );
    });

    it('asks the server\'s planning companion first and treats its suggestion as the local one', async () => {
        const snapshot = snapshotWithPlayers(1, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(1);
        rallarMock.serverPeerId = 'default-qbox-server';
        rallarMock.answerPlanningRequest = (request) => repliedWith(request, SERVER_SUGGESTION);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => aiAskButton() !== undefined);
        await act(async () => {
            aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        await waitFor(() => container.textContent?.includes('Suggestion ready') === true);
        expect(container.textContent).toContain(SERVER_SUGGESTION.headline);
        expect(container.textContent).not.toContain('Move toward Hallway');
        expect(rallarMock.planningRequests).toHaveLength(1);
        expect(rallarMock.planningRequests[0]).not.toHaveProperty('signal');
        expect(sentPlanningProposals().map((input) => (input.payload as { value: { headline: string; }; }).value.headline))
            .toEqual([SERVER_SUGGESTION.headline]);
        await waitFor(() => aiPrimeButton() !== undefined);
        await act(async () => {
            aiPrimeButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        expect(targetRoomButton('hallway')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('answers with the local companion when the server\'s planning reply times out', async () => {
        const snapshot = snapshotWithPlayers(1, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(1);
        rallarMock.serverPeerId = 'default-qbox-server';
        rallarMock.answerPlanningRequest = () => ({ status: 'timeout', lifecycle: PLANNING_REQUEST_LIFECYCLE });
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => aiAskButton() !== undefined);
        await act(async () => {
            aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        await waitFor(() => container.textContent?.includes('Suggestion ready') === true);
        expect(rallarMock.planningRequests).toHaveLength(1);
        expect(container.textContent).toContain('Move toward Hallway');
        expect(sentPlanningProposals()).toHaveLength(1);
    });

    it('publishes nothing and runs no local companion for an ask cancelled while it awaits the server', async () => {
        const snapshot = snapshotWithPlayers(1, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(1);
        rallarMock.serverPeerId = 'default-qbox-server';
        rallarMock.answerPlanningRequest = (_request, signal) =>
            new Promise((resolve) => {
                signal?.addEventListener('abort', () => resolve({ status: 'aborted', lifecycle: PLANNING_REQUEST_LIFECYCLE }));
            });
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => aiAskButton() !== undefined);
        await act(async () => {
            aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await waitFor(() => rallarMock.planningRequests.length === 1);
        act(() => {
            root?.unmount();
        });
        root = undefined;
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(sentPlanningProposals()).toEqual([]);
        expect(rallarMock.localGenerateJson).not.toHaveBeenCalled();
    });

    it.each([
        { label: 'its send is refused after the cancel', refuseSend: true },
        { label: 'its request reads undelivered when the cancelled wait ends', refuseSend: false }
    ])('runs no local companion and publishes nothing for a cancelled ask when $label', async ({ refuseSend }) => {
        let refuse: (reason: Error) => void = () => undefined;
        writeSession(session());
        rallarMock.serverPeerId = 'default-qbox-server';
        rallarMock.planningSendSettled = refuseSend
            ? new Promise((_resolve, reject) => {
                refuse = reject;
            })
            : undefined;
        rallarMock.answerPlanningRequest = (_request, signal) =>
            new Promise((resolve) => {
                signal?.addEventListener('abort', () => resolve({ status: 'undelivered', lifecycle: PLANNING_REQUEST_LIFECYCLE }));
            });
        stubSnapshotFetch(snapshotWithPlayers(1, 'planning'));

        await renderApp();
        await waitFor(() => aiAskButton() !== undefined);
        await act(async () => {
            aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await waitFor(() => rallarMock.planningRequests.length === 1);
        act(() => {
            root?.unmount();
        });
        root = undefined;
        refuse(new Error('The WS connection closed before the send was admitted.'));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(sentPlanningProposals()).toEqual([]);
        expect(rallarMock.localGenerateJson).not.toHaveBeenCalled();
    });

    describe('in a build without a local companion', () => {
        beforeEach(() => {
            rallarMock.localPlanningProviderOff = true;
        });

        it('asks the server, which alone answers', async () => {
            writeSession(session());
            rallarMock.serverPeerId = 'default-qbox-server';
            rallarMock.answerPlanningRequest = (request) => repliedWith(request, SERVER_SUGGESTION);
            stubSnapshotFetch(snapshotWithPlayers(1, 'planning'));

            await renderApp();
            await waitFor(() => aiAskButton() !== undefined && !aiAskButton()!.disabled);
            await act(async () => {
                aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });

            await waitFor(() => container.textContent?.includes('Suggestion ready') === true);
            expect(container.textContent).toContain(SERVER_SUGGESTION.headline);
            expect(sentPlanningProposals()).toHaveLength(1);
        });

        it('reads unavailable and publishes nothing when the server\'s reply times out', async () => {
            writeSession(session());
            rallarMock.serverPeerId = 'default-qbox-server';
            rallarMock.answerPlanningRequest = () => ({ status: 'timeout', lifecycle: PLANNING_REQUEST_LIFECYCLE });
            stubSnapshotFetch(snapshotWithPlayers(1, 'planning'));

            await renderApp();
            await waitFor(() => aiAskButton() !== undefined && !aiAskButton()!.disabled);
            await act(async () => {
                aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });

            await waitFor(() => container.querySelector('#hud-ai')?.textContent?.includes('Unavailable') === true);
            expect(rallarMock.planningRequests).toHaveLength(1);
            expect(container.querySelectorAll('.relic-ai-card')).toHaveLength(0);
            expect(sentPlanningProposals()).toEqual([]);
        });

        it('offers no Ask before the server is known', async () => {
            writeSession(session());
            stubSnapshotFetch(snapshotWithPlayers(1, 'planning'));

            await renderApp();
            await waitFor(() => aiAskButton() !== undefined);

            expect(aiAskButton()?.disabled).toBe(true);
            expect(container.querySelector('#hud-ai')?.textContent).toContain('Unavailable');
        });
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

    it('keeps Submit Plan on the REST fallback command path after AI priming (C13)', async () => {
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

    it('renders a proposal from another of the hunter\'s own sessions where the local suggestion renders, read-only', async () => {
        const snapshot = snapshotWithPlayers(1, 'planning');
        writeSession(session());
        rallarMock.roomState = roomState(1);
        stubSnapshotFetch(snapshot);

        await renderApp();
        await waitFor(() => aiAskButton() !== undefined);
        await act(async () => {
            aiAskButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await waitFor(() => container.querySelectorAll('.relic-ai-card.local').length === 1);
        const sent = rallarMock.wsSend.mock.calls[0]?.[0];
        await act(async () => {
            rallarMock.wsAiMessageHandler?.({
                payload: { ...sent.payload, generationId: 'sibling-generation-1', dedupeKey: 'sibling-dedupe-1' },
                senderId: 'alice-tablet-session',
                roomId: 'room-1',
                raw: toOwnPrincipalProposal(),
                receivedAtEpochMs: Date.now() + 1_000
            });
        });

        await waitFor(() => container.querySelectorAll('.relic-ai-card.local').length === 0);
        expect(container.querySelectorAll('.relic-ai-card')).toHaveLength(1);
        expect(container.querySelector('.relic-ai-card-head')?.textContent).toContain('alice-ta');
        expect(container.querySelectorAll('.relic-ai-prime')).toHaveLength(0);
        expect(container.textContent).not.toContain('Party Notes');
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

        const summary = computePartyCoordination(snapshot, 'alice-session', 'steal');

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

    function sentPlanningProposals(): RallarWsSendInput<object>[] {
        return rallarMock.wsSend.mock.calls
            .map(([input]) => input)
            .filter((input) => input.typeId === RELIC_TYPES.aiPlanningProposal);
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

function snapshotMessage(snapshot: RelicPublicSnapshot): MockWsMessage {
    const payload = { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: snapshot.gameId, snapshot };
    const raw = newALBroadcastMessage(
        'default-qbox-server',
        newALRoute(RELIC_TOPICS.snapshot, snapshot.gameId, snapshot.gameId),
        'room',
        RELIC_TYPES.snapshot,
        payload,
        {
            groupRef: { applicationId: DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID, groupId: snapshot.roomId }
        }
    );
    return { payload, raw, senderId: 'default-qbox-server', roomId: snapshot.roomId, receivedAtEpochMs: Date.now() };
}

function roomState(onlineMemberCount: number): RallarRoomState {
    const roomRef = { applicationId: DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID, groupId: 'room-1' };
    const fixture = createGroupSnapshotFixture({
        ...roomRef,
        sessionIds: Array.from({ length: onlineMemberCount }, (_, index) => index === 0 ? session().clientId : `member-${index}`)
    });
    const snapshot = {
        ...fixture,
        activeSessions: fixture.activeSessions.map((entry, index) => ({
            ...entry,
            sessionId: index === 0 ? session().sessionId : entry.sessionId,
            expiresAtEpochMs: Date.now() + 60_000
        }))
    };
    return {
        currentRoomId: 'room-1',
        currentRoomRef: roomRef,
        currentRoom: snapshot,
        rooms: [
            {
                roomId: 'room-1',
                roomRef,
                name: 'Relic Hunters Expedition',
                status: 'active',
                kind: 'party',
                joinMode: 'open',
                memberCount: onlineMemberCount,
                onlineMemberCount,
                isJoined: true,
                isCurrent: true,
                snapshot
            }
        ],
        members: snapshot.members.map((member) => ({
            principalId: member.principalId,
            username: member.principalId,
            role: member.role,
            status: member.status,
            isOwner: member.role === 'owner',
            isOnline: true,
            sessionIds: snapshot.activeSessions.filter((presence) => presence.principalId === member.principalId).map((presence) => presence.sessionId)
        }))
    };
}

function stubSnapshotFetch(snapshot: RelicPublicSnapshot): void {
    stubSnapshotFetchSequence(snapshot);
}

function stubSnapshotFetchSequence(
    ...snapshots: readonly RelicPublicSnapshot[]
): ReturnType<typeof vi.fn> {
    let index = 0;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
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

const ROUND_STARTED: RelicRoundTransitionEvent = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    gameId: 'room-1',
    createdAtEpochMs: 1,
    round: 1,
    phase: 'planning',
    transition: 'round-started',
    text: 'Alice started the expedition.'
};

const RECORDED: RelicHunterEvent = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    gameId: 'room-1',
    principalId: 'client-1',
    playerId: 'alice-session',
    kind: 'action-recorded',
    round: 1,
    action: { kind: 'search' }
};

const REFUSED: RelicHunterEvent = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    gameId: 'room-1',
    principalId: 'client-1',
    playerId: 'alice-session',
    kind: 'command-refused',
    command: 'force-resolve-round',
    text: 'Round timer has not expired.'
};

function toHunterEventMessage(event: RelicHunterEvent): RallarMessage<RelicHunterEvent> {
    const groupRef = { applicationId: DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID, groupId: 'room-1' };
    const raw = newALPrincipalBroadcastMessage(
        'default-qbox-server',
        newALRoute(RELIC_TOPICS.hunter, 'room-1', `${event.gameId}:${event.principalId}`),
        {
            groupRef,
            principalRef: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId, principalId: event.principalId }
        },
        RELIC_TYPES.hunter,
        event
    );
    return {
        transport: 'ws',
        typeId: RELIC_TYPES.hunter,
        topicId: RELIC_TOPICS.hunter,
        contextId: 'room-1',
        resourceId: raw.route.resourceId,
        roomId: 'room-1',
        senderId: 'default-qbox-server',
        traceId: raw.id.traceId,
        payload: event,
        raw,
        receivedAtEpochMs: Date.now(),
        reply: unrepliedInTheseTests
    };
}

function toRoundTransitionMessage(event: RelicRoundTransitionEvent): RallarMessage<RelicRoundTransitionEvent> {
    const raw = newALBroadcastMessage(
        'default-qbox-server',
        newALRoute(RELIC_TOPICS.event, 'room-1', `${event.gameId}:${event.round}`),
        'room',
        RELIC_TYPES.event,
        event,
        {
            groupRef: {
                applicationId: DEFAULT_STATE_APPLICATION_ID,
                workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                groupId: 'room-1'
            }
        }
    );
    return {
        transport: 'ws',
        typeId: RELIC_TYPES.event,
        topicId: RELIC_TOPICS.event,
        contextId: 'room-1',
        resourceId: raw.route.resourceId,
        roomId: 'room-1',
        senderId: 'default-qbox-server',
        traceId: raw.id.traceId,
        payload: event,
        raw,
        receivedAtEpochMs: Date.now(),
        reply: unrepliedInTheseTests
    };
}

function snapshotWithPlayers(
    playerCount: 1 | 2,
    phase: 'lobby' | 'planning' = 'lobby'
): RelicPublicSnapshot {
    let state: RelicGameState = createRelicGame('room-1', 'room-1', 1);
    state = requireRelicCommandApplied(applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride'
    }, {
        senderId: 'alice-session',
        now: 2
    })).state;

    if (playerCount === 2) {
        state = requireRelicCommandApplied(applyRelicCommand(state, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'join-expedition',
            gameId: 'room-1',
            username: 'Bob',
            characterId: 'nyra-vale'
        }, {
            senderId: 'bob-session',
            now: 3
        })).state;
    }

    if (phase === 'planning') {
        state = requireRelicCommandApplied(applyRelicCommand(state, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            kind: 'start-expedition',
            gameId: 'room-1',
            username: 'Alice'
        }, {
            senderId: 'alice-session',
            now: 4
        })).state;
    }

    return toPublicRelicSnapshot(state);
}

function generatedSnapshotWithPlayers(): RelicPublicSnapshot {
    let state: RelicGameState = createRelicGameFromBlueprint(
        {
            gameId: 'room-1',
            roomId: 'room-1',
            blueprint: createProceduralRelicExpeditionBlueprint({
                seed: 'browser-generated',
                theme: 'Test Keep'
            }),
            now: 1,
            setup: {
                source: 'procedural',
                seed: 'browser-generated',
                theme: 'Test Keep',
                blueprintId: 'browser-generated'
            }
        }
    ).fold(
        (refusal) => {
            throw new Error(`Expected a valid fixture blueprint: ${refusal.message}`);
        },
        (state) => state
    );
    state = requireRelicCommandApplied(applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId: 'room-1',
        username: 'Alice',
        characterId: 'kael-ironstride'
    }, {
        senderId: 'alice-session',
        now: 2
    })).state;
    state = requireRelicCommandApplied(applyRelicCommand(state, {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'start-expedition',
        gameId: 'room-1',
        username: 'Alice'
    }, {
        senderId: 'alice-session',
        now: 3
    })).state;

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

/** The principal broadcast that carries a suggestion to the local hunter's own sessions in the room. */
function toOwnPrincipalProposal() {
    const scope = { applicationId: DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID };
    return newALPrincipalBroadcastMessage(
        'alice-tablet-session',
        newALRoute('room.relic.ai.planning', 'room-1', 'sibling-generation-1'),
        { groupRef: { ...scope, groupId: 'room-1' }, principalRef: { ...scope, principalId: 'client-1' } },
        'relic.ai.planning-proposal.v1',
        {}
    );
}

/** The browser app replies to no server event. */
function unrepliedInTheseTests(): never {
    throw new Error('The Relic browser app does not reply to a server event.');
}

const SERVER_SUGGESTION = {
    headline: 'Scout the Hallway before the others do',
    action: { kind: 'move', targetRoomId: 'hallway' },
    rationale: 'The server companion read the same public turn.',
    risks: [],
    confidence: 'medium'
} as const;

const PLANNING_REQUEST_LIFECYCLE = createInitialALDeliveryLifecycle({
    msgId: 'planning-request-1',
    typeId: RELIC_TYPES.aiPlanningRequest,
    ackMode: 'receiver',
    receiptAlgo: 'receiver',
    expiresAtMs: undefined,
    submittedAtMs: 0
});

/** The Relic server's reply: the deterministic companion's result for exactly this request. */
function repliedWith(request: RallarAiJsonRequest, suggestion: object): RallarMessageReplyOutcome<object> {
    const payload = createRallarAiJsonResult({
        request,
        provider: createRallarAiMockProvider({ providerId: 'relic-planning-deterministic' }),
        value: suggestion,
        generationId: 'server-generation-1'
    });
    return { status: 'replied', reply: { payload } as RallarMessage<object>, lifecycle: PLANNING_REQUEST_LIFECYCLE };
}
