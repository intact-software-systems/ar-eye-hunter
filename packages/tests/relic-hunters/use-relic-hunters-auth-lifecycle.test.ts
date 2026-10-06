// @vitest-environment happy-dom
import {
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    toPublicRelicSnapshot,
    toRelicRoundTrackKey,
    type RelicPublicSnapshot,
    type RelicRoundTransitionEvent,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import type {
    RallarAuthState,
    RallarMessage,
    RallarRoomMessageChannelDefinition,
    RallarTypedPayloadHandler
} from '@shared-web/browser/rallar.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRelicSnapshot } from '../../../apps/relic-hunters-v1/src/game/api.ts';
import { useRelicHunters, type RelicHuntersConnection } from '../../../apps/relic-hunters-v1/src/game/useRelicHunters.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const session: AuthSession = {
    clientId: 'relic-1',
    accessToken: 'token-1',
    username: 'relic',
    sessionId: 'session-1',
    expiresAtEpochMs: Date.now() + 60_000
};

const authListeners = new Set<(state: RallarAuthState) => void | Promise<void>>();
const mockRallar = vi.hoisted(() => ({
    auth: {
        restore: vi.fn(),
        onChange: vi.fn(),
        login: vi.fn(),
        registerAndLogin: vi.fn(),
        logout: vi.fn()
    },
    session: vi.fn(),
    start: vi.fn(),
    subscriptions: vi.fn(),
    rooms: {
        state: vi.fn(),
        refresh: vi.fn(),
        onChange: vi.fn()
    },
    messages: {
        ws: {
            onMessage: vi.fn()
        },
        rtc: {
            onMessage: vi.fn()
        },
        room: vi.fn()
    },
    channels: {
        room: vi.fn()
    },
    rtc: {
        onStatus: vi.fn(),
        waitForRoomLane: vi.fn()
    },
    director: {
        createRelay: vi.fn(),
        status: vi.fn(),
        appoint: vi.fn()
    }
}));

vi.mock('@shared-web/browser/rallar.ts', () => ({
    rallar: mockRallar
}));

vi.mock('../../../apps/relic-hunters-v1/src/game/api.ts', () => ({
    fetchRelicSnapshot: vi.fn(),
    resetRelicGame: vi.fn(),
    sendRelicCommand: vi.fn()
}));

describe('useRelicHunters auth lifecycle', () => {
    let root: Root | undefined;
    let container: HTMLDivElement;
    let current: RelicHuntersConnection | undefined;

    beforeEach(() => {
        authListeners.clear();
        current = undefined;
        container = document.createElement('div');
        document.body.append(container);
        vi.stubGlobal('localStorage', memoryStorage());
        mockRallar.auth.restore.mockReturnValue(session);
        mockRallar.session.mockReturnValue(session);
        mockRallar.auth.onChange.mockImplementation((listener) => {
            authListeners.add(listener);
            return vi.fn();
        });
        mockRallar.start.mockResolvedValue({
            session,
            connected: true,
            roomState: {
                rooms: [
                    {
                        roomId: 'relic-room-1',
                        groupId: 'relic-room-1',
                        name: 'Relic Hunters Expedition'
                    }
                ],
                currentRoomId: 'relic-room-1'
            }
        });
        mockRallar.subscriptions.mockReturnValue({
            add: vi.fn().mockReturnThis(),
            unsubscribe: vi.fn()
        });
        mockRallar.rooms.onChange.mockReturnValue(vi.fn());
        mockRallar.rooms.state.mockReturnValue({
            rooms: [],
            currentRoomId: undefined
        });
        mockRallar.messages.ws.onMessage.mockReturnValue(vi.fn());
        mockRallar.messages.rtc.onMessage.mockReturnValue(vi.fn());
        mockRallar.messages.room.mockReturnValue({ onWs: vi.fn(() => vi.fn()) });
        mockRallar.rtc.onStatus.mockReturnValue(vi.fn());
        mockRallar.channels.room.mockReturnValue({
            onMessage: vi.fn(() => vi.fn()),
            send: vi.fn()
        });
        mockRallar.director.createRelay.mockReturnValue({
            start: vi.fn(() => vi.fn()),
            status: vi.fn(() => ({ started: false })),
            sendIntent: vi.fn(),
            sendOutput: vi.fn(),
            sendHeartbeat: vi.fn(),
            sendSnapshot: vi.fn(),
            stop: vi.fn()
        });
    });

    afterEach(async () => {
        if (root) {
            await act(async () => root?.unmount());
        }
        root = undefined;
        container.remove();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('clears relic runtime state when auth is unauthorized outside manual logout', async () => {
        localStorage.setItem('relic.currentRoomId', 'relic-room-1');
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected');

        expect(current?.session).toEqual(session);
        expect(current?.roomId).toBe('relic-room-1');
        expect(current?.diagnostics.authenticated).toBe(true);
        expect(current?.diagnostics.middlewareConnected).toBe(true);

        await emitAuthState({
            authenticated: false,
            reason: 'unauthorized'
        });

        expect(current?.session).toBeUndefined();
        expect(current?.connectionState).toBe('signed-out');
        expect(current?.roomId).toBeUndefined();
        expect(current?.rooms).toEqual([]);
        expect(current?.snapshot).toBeUndefined();
        expect(current?.diagnostics.authenticated).toBe(false);
        expect(current?.diagnostics.middlewareConnected).toBe(false);
        expect(current?.diagnostics.roomReady).toBe(false);
        expect(current?.diagnostics.rtcReady).toBe(false);
        expect(current?.diagnostics.authorityReady).toBe(false);
        expect(localStorage.getItem('relic.currentRoomId')).toBeNull();
        expect(mockRallar.auth.logout).not.toHaveBeenCalled();
    });

    it('clears stale snapshot rejection diagnostics after a newer snapshot is accepted', async () => {
        let wsMessageHandler:
            | ((message: { payload: Pick<RelicServerEvent, 'snapshot'>; }) => void)
            | undefined;
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        mockRallar.messages.ws.onMessage.mockImplementation((definition, handler) => {
            if (definition.topicId === 'room.relic.snapshot') {
                wsMessageHandler = handler;
            }
            return vi.fn();
        });

        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true);

        await act(async () => {
            wsMessageHandler?.({ payload: { snapshot: relicSnapshot(19) } });
        });
        expect(current?.diagnostics.lastIgnoredSnapshotReason).toBe('older-updated-at');

        await act(async () => {
            wsMessageHandler?.({ payload: { snapshot: relicSnapshot(21) } });
        });
        expect(current?.diagnostics.lastSnapshotSource).toBe('rallar-ws');
        expect(current?.diagnostics.lastIgnoredSnapshotReason).toBeUndefined();
    });

    it('cues the room\'s ordered round transitions and re-reads the game over REST when a track of any of its incarnations needs resynchronizing', async () => {
        let definition: RallarRoomMessageChannelDefinition | undefined;
        let onTransition: RallarTypedPayloadHandler<RelicRoundTransitionEvent> | undefined;
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        mockRallar.messages.room.mockImplementation((roomDefinition: RallarRoomMessageChannelDefinition) => {
            definition = roomDefinition;
            return {
                onWs: vi.fn((handler: RallarTypedPayloadHandler<RelicRoundTransitionEvent>) => {
                    onTransition = handler;
                    return vi.fn();
                })
            };
        });

        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true && onTransition !== undefined);
        await act(async () => {
            await onTransition?.(ROUND_STARTED, toRoomMessage(ROUND_STARTED));
        });

        expect(current?.roundTransition).toEqual(ROUND_STARTED);
        expect(current?.diagnostics.roundTransitionCues).toEqual(['1:round-started']);

        vi.mocked(fetchRelicSnapshot).mockClear().mockResolvedValue(relicSnapshot(21));
        await act(async () => {
            definition?.recovery?.onResyncRequired({
                orderingKey: toRelicRoundTrackKey({ gameId: 'relic-room-1', createdAtEpochMs: 7 }),
                senderId: 'default-qbox-server',
                epoch: 1,
                lastContiguousSeq: 0,
                expectedSeq: 1,
                observedSeq: 300,
                carrier: 'ws'
            });
        });
        await waitForState(() => current?.diagnostics.lastSnapshotSource === 'resync-recovery');

        expect(fetchRelicSnapshot).toHaveBeenCalledWith('relic-room-1');
        expect(current?.snapshot?.updatedAtEpochMs).toBe(21);
    });

    async function renderHook(): Promise<void> {
        root = createRoot(container);
        function Harness() {
            current = useRelicHunters();
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
        expect(
            predicate(),
            JSON.stringify(
                {
                    connectionState: current?.connectionState,
                    error: current?.error,
                    diagnostics: current?.diagnostics
                },
                null,
                2
            )
        ).toBe(true);
    }
});

const ROUND_STARTED: RelicRoundTransitionEvent = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    gameId: 'relic-room-1',
    round: 1,
    phase: 'planning',
    transition: 'round-started',
    text: 'relic started the expedition.'
};

function toRoomMessage(event: RelicRoundTransitionEvent): RallarMessage<RelicRoundTransitionEvent> {
    const raw = newALBroadcastMessage(
        'default-qbox-server',
        newALRoute(RELIC_TOPICS.event, event.gameId, `${event.gameId}:${event.round}`),
        'room',
        RELIC_TYPES.event,
        event,
        {
            groupRef: {
                applicationId: DEFAULT_STATE_APPLICATION_ID,
                workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                groupId: event.gameId
            }
        }
    );
    return {
        transport: 'ws',
        typeId: RELIC_TYPES.event,
        topicId: RELIC_TOPICS.event,
        contextId: event.gameId,
        resourceId: raw.route.resourceId,
        roomId: event.gameId,
        senderId: 'default-qbox-server',
        payload: event,
        raw,
        receivedAtEpochMs: 0
    };
}

function relicSnapshot(updatedAtEpochMs: number): RelicPublicSnapshot {
    return toPublicRelicSnapshot(
        createRelicGame('relic-room-1', 'relic-room-1', updatedAtEpochMs)
    );
}

function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        removeItem: vi.fn((key: string) => {
            values.delete(key);
        }),
        setItem: vi.fn((key: string, value: string) => {
            values.set(key, value);
        })
    };
}
