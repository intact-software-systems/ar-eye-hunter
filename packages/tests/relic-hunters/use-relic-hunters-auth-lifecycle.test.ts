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
    RallarRoomState,
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

    it('drops a round transition of another incarnation of the game the page holds', async () => {
        const channels = captureRoomChannels();
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(1));
        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true && channels.get('relic-room-1')?.onTransition !== undefined);
        const onTransition = channels.get('relic-room-1')!.onTransition!;
        const otherIncarnation = { ...ROUND_STARTED, createdAtEpochMs: 7 };
        const heldIncarnation = { ...ROUND_STARTED, createdAtEpochMs: 1 };

        await act(async () => {
            await onTransition(otherIncarnation, toRoomMessage(otherIncarnation));
        });
        expect(current?.roundTransition).toBeUndefined();
        expect(current?.diagnostics.roundTransitionCues).toEqual([]);

        await act(async () => {
            await onTransition(heldIncarnation, toRoomMessage(heldIncarnation));
        });
        expect(current?.roundTransition).toEqual(heldIncarnation);
        expect(current?.diagnostics.roundTransitionCues).toEqual(['1:round-started']);
    });

    it('cues a round transition of any incarnation while the page holds no snapshot', async () => {
        const channels = captureRoomChannels();
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(undefined);
        await renderHook();
        await waitForState(() => channels.get('relic-room-1')?.onTransition !== undefined);
        const anyIncarnation = { ...ROUND_STARTED, createdAtEpochMs: 7 };

        await act(async () => {
            await channels.get('relic-room-1')!.onTransition!(anyIncarnation, toRoomMessage(anyIncarnation));
        });

        expect(current?.snapshot).toBeUndefined();
        expect(current?.roundTransition).toEqual(anyIncarnation);
    });

    it('drops a round-transition resync that lands after the page signed out', async () => {
        const channels = captureRoomChannels();
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true && channels.has('relic-room-1'));
        const late = createDeferred<RelicPublicSnapshot | undefined>();
        vi.mocked(fetchRelicSnapshot).mockReturnValueOnce(late.promise);
        await act(async () => requireResync(channels.get('relic-room-1')!));

        await emitAuthState({ authenticated: false, reason: 'unauthorized' });
        await act(async () => late.resolve(relicSnapshot(21)));

        expect(current?.snapshot).toBeUndefined();
        expect(current?.diagnostics.lastError).toBeUndefined();
    });

    it('drops a failed round-transition resync of the room the page left', async () => {
        const channels = captureRoomChannels();
        const rooms = captureRoomsChange();
        vi.mocked(fetchRelicSnapshot).mockImplementation(async (roomId) => relicSnapshot(20, roomId));
        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true && channels.has('relic-room-1'));
        const late = createDeferred<RelicPublicSnapshot | undefined>();
        vi.mocked(fetchRelicSnapshot).mockReturnValueOnce(late.promise);
        await act(async () => requireResync(channels.get('relic-room-1')!));

        await rooms.enter('relic-room-2');
        await waitForState(() => current?.snapshot?.roomId === 'relic-room-2');
        await act(async () => late.reject(new Error('Relic snapshot read failed')));

        expect(current?.diagnostics.lastError).toBeUndefined();
        expect(current?.snapshot?.roomId).toBe('relic-room-2');
    });

    it('forgets the round transition when the page signs out', async () => {
        const channels = captureRoomChannels();
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        await renderHook();
        await waitForState(() => channels.get('relic-room-1')?.onTransition !== undefined);
        await act(async () => {
            await channels.get('relic-room-1')!.onTransition!(ROUND_STARTED, toRoomMessage(ROUND_STARTED));
        });
        expect(current?.roundTransition).toEqual(ROUND_STARTED);

        await emitAuthState({ authenticated: false, reason: 'unauthorized' });

        expect(current?.roundTransition).toBeUndefined();
    });

    it('forgets the round transition of the room the page left until the next room cues its own', async () => {
        const channels = captureRoomChannels();
        const rooms = captureRoomsChange();
        vi.mocked(fetchRelicSnapshot).mockImplementation(async (roomId) => relicSnapshot(20, roomId));
        await renderHook();
        await waitForState(() => channels.get('relic-room-1')?.onTransition !== undefined);
        await act(async () => {
            await channels.get('relic-room-1')!.onTransition!(ROUND_STARTED, toRoomMessage(ROUND_STARTED));
        });

        await rooms.enter('relic-room-2');
        await waitForState(() => channels.get('relic-room-2')?.onTransition !== undefined);

        expect(current?.roundTransition).toBeUndefined();
        const nextRoomStarted = { ...ROUND_STARTED, gameId: 'relic-room-2' };
        await act(async () => {
            await channels.get('relic-room-2')!.onTransition!(nextRoomStarted, toRoomMessage(nextRoomStarted));
        });
        expect(current?.roundTransition).toEqual(nextRoomStarted);
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

interface CapturedRoomChannel {
    readonly roomId: string;
    readonly definition: RallarRoomMessageChannelDefinition;
    onTransition: RallarTypedPayloadHandler<RelicRoundTransitionEvent> | undefined;
}

interface CapturedRoomsChange {
    enter(roomId: string): Promise<void>;
}

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
}

/** Every room the hook subscribes to round transitions for, by the room's group id. */
function captureRoomChannels(): ReadonlyMap<string, CapturedRoomChannel> {
    const channels = new Map<string, CapturedRoomChannel>();
    mockRallar.messages.room.mockImplementation((definition: RallarRoomMessageChannelDefinition) => {
        const roomId = definition.roomRef?.groupId;
        if (roomId === undefined) {
            throw new Error('A Relic round-transition channel names its room');
        }
        const channel: CapturedRoomChannel = { roomId, definition, onTransition: undefined };
        channels.set(roomId, channel);
        return {
            onWs: vi.fn((handler: RallarTypedPayloadHandler<RelicRoundTransitionEvent>) => {
                channel.onTransition = handler;
                return vi.fn();
            })
        };
    });
    return channels;
}

/** Moves the page to another room the way the room state reports it. */
function captureRoomsChange(): CapturedRoomsChange {
    let listener: ((state: RallarRoomState) => void) | undefined;
    mockRallar.rooms.onChange.mockImplementation((handler: (state: RallarRoomState) => void) => {
        listener = handler;
        return vi.fn();
    });
    return {
        enter: async (roomId) => {
            await act(async () => {
                listener?.({ rooms: [], currentRoomId: roomId, members: [] });
            });
        }
    };
}

function requireResync(channel: CapturedRoomChannel): void {
    channel.definition.recovery?.onResyncRequired({
        orderingKey: toRelicRoundTrackKey({ gameId: channel.roomId, createdAtEpochMs: 20 }),
        senderId: 'default-qbox-server',
        epoch: 1,
        lastContiguousSeq: 0,
        expectedSeq: 1,
        observedSeq: 300,
        carrier: 'ws'
    });
}

function createDeferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

const ROUND_STARTED: RelicRoundTransitionEvent = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    gameId: 'relic-room-1',
    createdAtEpochMs: 20,
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

function relicSnapshot(updatedAtEpochMs: number, roomId = 'relic-room-1'): RelicPublicSnapshot {
    return toPublicRelicSnapshot(createRelicGame(roomId, roomId, updatedAtEpochMs));
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
