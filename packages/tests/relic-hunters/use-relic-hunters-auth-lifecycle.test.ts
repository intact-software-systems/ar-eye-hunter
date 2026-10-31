// @vitest-environment happy-dom
import { createRallarDataFacade, type RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import '../setup-browser-indexeddb.ts';

import {
    applyRelicCommand,
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    toPublicRelicSnapshot,
    toRelicRoundTrackKey,
    type RelicHunterEvent,
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
import { toRoomEntryUrl } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { toRallarRoomState } from '@shared-web/browser/rooms/room-group-state-translation.ts';
import {
    newALBroadcastMessage,
    newALPrincipalBroadcastMessage,
    newALRoute
} from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';

import { fetchRelicSnapshot, initializeRelicGame, resetRelicGame, sendRelicCommand } from '../../../apps/relic-hunters-v1/src/game/api.ts';
import { RelicReviewPanel } from '../../../apps/relic-hunters-v1/src/game/hud/relic-plan.tsx';
import { browserRelicRuntimeDeps } from '../../../apps/relic-hunters-v1/src/game/relic-hunters-browser.ts';
import type { RelicHuntersRuntime } from '../../../apps/relic-hunters-v1/src/game/relic-hunters-runtime.ts';
import { useRelicHunters } from '../../../apps/relic-hunters-v1/src/game/use-relic-hunters.ts';
import type { RelicPreferences } from '../../../apps/relic-hunters-v1/src/game/use-relic-preferences.ts';
import { useRelicTurn } from '../../../apps/relic-hunters-v1/src/game/use-relic-turn.ts';
import { createActiveGroupPresenceSessionFixture, createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';
import { requireRelicCommandApplied } from './require-relic-command-applied.ts';

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
    data: { open: vi.fn<RallarDataFacade['open']>() },
    serverPeerId: () => 'default-qbox-server',
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
        join: vi.fn(),
        state: vi.fn(),
        refresh: vi.fn(),
        directory: vi.fn(),
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

vi.mock('../../../apps/relic-hunters-v1/src/game/api.ts', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../../apps/relic-hunters-v1/src/game/api.ts')>(),
    fetchRelicSnapshot: vi.fn(),
    initializeRelicGame: vi.fn(),
    resetRelicGame: vi.fn(),
    sendRelicCommand: vi.fn()
}));

describe('useRelicHunters auth lifecycle', () => {
    let root: Root | undefined;
    let container: HTMLDivElement;
    let current: RelicHuntersRuntime.Connection | undefined;

    beforeEach(() => {
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: {
                request: async <T>(_name: string, run: () => Promise<T>): Promise<T> => await run()
            }
        });
        vi.resetAllMocks();
        const data = createRallarDataFacade({ manager: new RepositoryManager(), resolveScopeKey: (scope) => scope });
        const dbName = `relic-browser-test-${crypto.randomUUID()}`;
        mockRallar.data.open.mockImplementation((name, options) => data.open(name, { ...options, dbName, sync: false }));
        authListeners.clear();
        current = undefined;
        container = document.createElement('div');
        document.body.append(container);
        window.sessionStorage.clear();
        window.history.replaceState(null, '', '/');
        mockRallar.auth.restore.mockReturnValue(session);
        mockRallar.session.mockReturnValue(session);
        mockRallar.auth.onChange.mockImplementation((listener) => {
            authListeners.add(listener);
            return () => authListeners.delete(listener);
        });
        mockRallar.start.mockImplementation(async () => {
            const room = relicRoomFixture('relic-room-1');
            mockRallar.rooms.state.mockReturnValue(room.state);
            return { session, connected: true, roomState: room.state };
        });
        mockRallar.subscriptions.mockImplementation(() => new SubscriptionScope());
        mockRallar.rooms.onChange.mockReturnValue(vi.fn());
        mockRallar.rooms.state.mockReturnValue({
            rooms: [],
            members: []
        });
        mockRallar.rooms.directory.mockResolvedValue({ entries: [], nextCursor: null });
        mockRallar.messages.ws.onMessage.mockReturnValue(vi.fn());
        mockRallar.messages.rtc.onMessage.mockReturnValue(vi.fn());
        mockRallar.messages.room.mockImplementation(() => idleRoomChannel());
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

    it('restores a spectator without creating a save or sending game commands', async () => {
        const room = relicRoomFixture('relic-room-1');
        const snapshot: GroupSnapshot = { ...room.snapshot, members: room.snapshot.members.map((member) => ({ ...member, role: 'spectator' })) };
        const state = toRallarRoomState({
            groupSnapshots: [snapshot],
            currentRoom: snapshot,
            currentRoomRef: snapshot.group,
            clientSnapshots: [],
            sessionId: session.sessionId
        });
        mockRallar.start.mockImplementation(async () => {
            mockRallar.rooms.state.mockReturnValue(state);
            return { session, connected: true, roomState: state };
        });
        await renderHook();
        await waitForState(() => current?.participation === 'spectator');
        await act(async () => {
            await current?.joinExpedition();
            await current?.startExpedition();
            await current?.resetExpedition();
        });
        expect(current?.onlinePlayerCount).toBe(0);
        expect(initializeRelicGame).not.toHaveBeenCalled();
        expect(sendRelicCommand).not.toHaveBeenCalled();
        expect(resetRelicGame).not.toHaveBeenCalled();
        expect(current?.snapshot).toBeUndefined();
    });

    it('shows public round review to a spectator without offering director controls', async () => {
        const room = relicRoomFixture('relic-room-1');
        const snapshot: GroupSnapshot = {
            ...room.snapshot,
            members: room.snapshot.members.map((member) => ({ ...member, role: 'spectator' }))
        };
        const state = toRallarRoomState({
            groupSnapshots: [snapshot],
            currentRoom: snapshot,
            currentRoomRef: snapshot.group,
            clientSnapshots: [],
            sessionId: session.sessionId
        });
        mockRallar.start.mockImplementation(async () => {
            mockRallar.rooms.state.mockReturnValue(state);
            return { session, connected: true, roomState: state };
        });
        vi.mocked(fetchRelicSnapshot).mockResolvedValue({ ...relicSnapshot(20), phase: 'review' });
        const preferences: RelicPreferences = {
            lang: 'en',
            ambientEnabled: false,
            helpVisible: false,
            toggleLanguage: vi.fn(),
            toggleAmbient: vi.fn(),
            enableAmbient: vi.fn(),
            setHelpVisible: vi.fn()
        };
        function ReviewHarness() {
            const game = useRelicHunters();
            const turn = useRelicTurn(game, preferences, []);
            return createElement(RelicReviewPanel, { game, turn, lang: 'en' });
        }
        root = createRoot(container);
        await act(async () => root?.render(createElement(ReviewHarness)));
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(container.querySelector('[aria-label="Round review"]')).not.toBeNull();
        });
        expect(container.textContent).toContain('Watch the revealed plans');
        expect(container.querySelector('button')).toBeNull();
    });

    it('clears relic runtime state when auth is unauthorized outside manual logout', async () => {
        await renderHook();
        await waitForState(() => current?.connectionState === 'connected' && current.directory.status === 'ready');

        expect(current?.session).toEqual(session);
        expect(current?.roomId).toBe('relic-room-1');
        expect(current?.diagnostics.authenticated).toBe(true);
        expect(current?.diagnostics.middlewareConnected).toBe(true);
        expect(current?.directory).toEqual({ status: 'ready', entries: [], error: undefined });
        expect(mockRallar.rooms.directory).toHaveBeenCalledWith(
            { kind: 'room', q: 'relic hunters', limit: 50, includeEmpty: false, order: 'online-members' },
            expect.objectContaining({
                scope: { applicationId: DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID },
                timeoutMs: 10_000,
                maxAttempts: 1
            })
        );

        await emitAuthState({
            authenticated: false,
            reason: 'unauthorized'
        });

        expect(current?.session).toBeUndefined();
        expect(current?.connectionState).toBe('signed-out');
        expect(current?.roomId).toBeUndefined();
        expect(current?.rooms).toEqual([]);
        expect(current?.directory).toEqual({ status: 'idle', entries: [], error: undefined });
        expect(current?.snapshot).toBeUndefined();
        expect(current?.diagnostics.authenticated).toBe(false);
        expect(current?.diagnostics.middlewareConnected).toBe(false);
        expect(current?.diagnostics.roomReady).toBe(false);
        expect(current?.diagnostics.rtcReady).toBe(false);
        expect(current?.diagnostics.authorityReady).toBe(false);
        expect(mockRallar.auth.logout).not.toHaveBeenCalled();
    });

    it('carries a private destination through sign-in and adopts it before a previous startup room', async () => {
        const destination = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'private-expedition' };
        const admitted = relicRoomFixture(destination.groupId);
        mockRallar.auth.restore.mockReturnValue(undefined);
        mockRallar.session.mockReturnValue(undefined);
        const invitation = toRoomEntryUrl(window.location.href, { intent: 'join', roomRef: destination, participation: 'preserve', joinCode: 'private-code' });
        if (!invitation.right) {
            throw new Error('The private invitation must encode successfully');
        }
        window.history.replaceState(null, '', invitation.right);
        await renderHook();

        expect(window.location.hash).toBe('');
        expect(current?.roomEntry.getState()).toMatchObject({ status: 'pending', destination: { roomRef: destination } });
        expect(current?.roomId).toBeUndefined();

        mockRallar.auth.login.mockImplementation(async () => {
            mockRallar.auth.restore.mockReturnValue(session);
            mockRallar.session.mockReturnValue(session);
            return session;
        });
        mockRallar.rooms.join.mockImplementation(async () => {
            mockRallar.rooms.state.mockReturnValue(admitted.state);
            return admitted.snapshot;
        });
        vi.mocked(fetchRelicSnapshot).mockImplementation(async (roomId) => relicSnapshot(20, roomId));
        await act(async () => current?.login('relic', 'password'));

        expect(current?.roomId).toBe(destination.groupId);
        expect(current?.snapshot?.roomId).toBe(destination.groupId);
        expect(current?.roomEntry.getState()).toMatchObject({
            status: 'entered',
            destination: { roomRef: destination, participation: 'preserve', joinCode: null }
        });
        expect(window.sessionStorage.getItem('rallar.room-entry:["rallar-server","default"]')).not.toContain('private-code');
    });

    it('previews a scheduled destination while preserving the current expedition', async () => {
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('relic-room-1', 'relic-room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'relic-room-1',
            username: session.username,
            kind: 'join-expedition'
        }, { presentPlayerIds: [session.sessionId], senderId: session.sessionId, now: 2 })).state;
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(toPublicRelicSnapshot(game));
        await renderHook();
        await waitForState(() => current?.diagnostics.middlewareConnected === true && current.snapshot !== undefined);
        const roomId = current?.roomId;
        const before = current?.snapshot;
        const destination = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'next-week' };
        mockRallar.rooms.join.mockClear();
        await act(async () => {
            current?.roomEntry.enter({ intent: 'preview-session', roomRef: destination, joinCode: null, participation: 'player' });
        });
        expect(current?.roomEntry.getState()).toMatchObject({ status: 'preview', destination: { roomRef: destination } });
        expect(current?.roomId).toBe(roomId);
        expect(current?.snapshot).toEqual(before);
        expect(mockRallar.rooms.join).not.toHaveBeenCalled();
    });

    it('discards bootstrap hydration that finishes after sign-out', async () => {
        const late = Promise.withResolvers<RelicPublicSnapshot | undefined>();
        vi.mocked(fetchRelicSnapshot).mockReturnValueOnce(late.promise);
        await renderHook();
        await waitForState(() => current?.diagnostics.middlewareConnected === true && current.snapshot === undefined);

        await emitAuthState({ authenticated: false, reason: 'unauthorized' });
        await act(async () => late.resolve(relicSnapshot(20)));

        expect(current?.connectionState).toBe('signed-out');
        expect(current?.session).toBeUndefined();
        expect(current?.roomId).toBeUndefined();
        expect(current?.snapshot).toBeUndefined();
    });

    it.each(['session-1', 'keeper-other-tab'])('rejects a cold Watch link while %s participates for the same principal', async (keeperSessionId) => {
        const room = relicRoomFixture('relic-room-1');
        const presence = room.snapshot.activeSessions[0];
        if (!presence) {
            throw new Error('The cold-tab fixture requires a live session.');
        }
        const snapshot = {
            ...room.snapshot,
            activeSessions: [...room.snapshot.activeSessions, {
                ...presence,
                sessionId: keeperSessionId
            }]
        };
        mockRallar.rooms.refresh.mockResolvedValue({ ...room.state, rooms: room.state.rooms.map((entry) => ({ ...entry, snapshot })) });
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('relic-room-1', 'relic-room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'relic-room-1',
            username: 'Keeper',
            kind: 'join-expedition'
        }, { presentPlayerIds: [keeperSessionId], senderId: keeperSessionId, now: 2 })).state;
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(toPublicRelicSnapshot(game));
        const link = toRoomEntryUrl(window.location.href, { intent: 'join', roomRef: snapshot.group, participation: 'spectator', joinCode: null });
        if (!link.right) {
            throw new Error('Expected a valid watch link');
        }
        window.history.replaceState(null, '', link.right);
        const deps = browserRelicRuntimeDeps();
        deps.roomEntry.start();
        await deps.roomEntry.resume();
        expect(deps.roomEntry.getState()).toMatchObject({ status: 'failed' });
        expect(mockRallar.rooms.join).not.toHaveBeenCalled();
        expect(initializeRelicGame).not.toHaveBeenCalled();
        deps.roomEntry.stop();
    });

    it.each(['session-change', 'abort', 'read-failure'] as const)('does not Watch when preflight ends with %s', async (failure) => {
        const room = relicRoomFixture('relic-room-1');
        mockRallar.rooms.refresh.mockResolvedValue(room.state);
        vi.mocked(fetchRelicSnapshot).mockImplementation(async () => {
            if (failure === 'session-change') {
                mockRallar.session.mockReturnValue({ ...session, sessionId: 'changed-session' });
            }
            if (failure === 'read-failure') {
                throw new Error('Snapshot read failed');
            }
            return undefined;
        });
        const deps = browserRelicRuntimeDeps();
        deps.roomEntry.start();
        deps.roomEntry.enter({ intent: 'join', roomRef: room.snapshot.group, participation: 'spectator', joinCode: null });
        if (failure === 'abort') {
            vi.mocked(fetchRelicSnapshot).mockImplementation(async () => {
                deps.roomEntry.cancel();
                return undefined;
            });
        }
        await deps.roomEntry.resume();
        expect(mockRallar.rooms.join).not.toHaveBeenCalled();
        deps.roomEntry.stop();
    });

    it('rejects peer and foreign-room WebSocket snapshots before they can pin snapshot ordering', async () => {
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        let handler: ((message: RallarMessage<RelicServerEvent>) => void) | undefined;
        mockRallar.messages.ws.onMessage.mockImplementation((definition, listener) => {
            if (definition.topicId === RELIC_TOPICS.snapshot) {
                handler = listener;
            }
            return vi.fn();
        });
        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true);
        const forged = toSnapshotMessage(relicSnapshot(999_999));
        await act(async () => {
            handler?.({ ...forged, senderId: 'peer-in-another-room', raw: { ...forged.raw, id: { ...forged.raw.id, senderId: 'peer-in-another-room' } } });
            handler?.({
                ...forged,
                raw: {
                    ...forged.raw,
                    targets: {
                        mode: 'broadcast',
                        scope: 'room',
                        groupRef: { applicationId: DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID, groupId: 'another-room' }
                    }
                }
            });
            handler?.(toSnapshotMessage(relicSnapshot(21)));
        });
        expect(current?.snapshot?.updatedAtEpochMs).toBe(21);
        expect(current?.diagnostics.ignoredSnapshotCount).toBe(0);
    });

    it('clears stale snapshot rejection diagnostics after a newer snapshot is accepted', async () => {
        let wsMessageHandler:
            | ((message: RallarMessage<RelicServerEvent>) => void)
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
            wsMessageHandler?.(toSnapshotMessage(relicSnapshot(19)));
        });
        expect(current?.diagnostics.lastIgnoredSnapshotReason).toBe('older-updated-at');

        await act(async () => {
            wsMessageHandler?.(toSnapshotMessage(relicSnapshot(21)));
        });
        expect(current?.diagnostics.lastSnapshotSource).toBe('rallar-ws');
        expect(current?.diagnostics.lastIgnoredSnapshotReason).toBeUndefined();
    });

    it('hears the signed-in hunter\'s own events in the room, and makes a refused command\'s rule text the command error', async () => {
        const channel = captureHunterEventChannel();
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        const refused = refusedHunterEvent(session.sessionId);

        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true && channel.onEvent() !== undefined);
        await act(async () => {
            await channel.onEvent()?.(refused, toHunterMessage(refused));
        });

        expect(channel.definition()).toMatchObject({ topicId: RELIC_TOPICS.hunter, typeId: RELIC_TYPES.hunter, purpose: 'notification' });
        expect(current?.lastHunterEvent).toEqual(refused);
        expect(current?.error).toBe('There is no review to continue.');
    });

    it('drops an event of the signed-in hunter\'s other session, which is another player of the game', async () => {
        const channel = captureHunterEventChannel();
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        const otherSession = refusedHunterEvent('session-2');

        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true && channel.onEvent() !== undefined);
        await act(async () => {
            await channel.onEvent()?.(otherSession, toHunterMessage(otherSession));
        });

        expect(current?.lastHunterEvent).toBeUndefined();
        expect(current?.error).toBeUndefined();
    });

    it('cues the room\'s ordered round transitions and re-reads the game over REST when a track of any of its incarnations needs resynchronizing', async () => {
        let definition: RallarRoomMessageChannelDefinition | undefined;
        let onTransition: RallarTypedPayloadHandler<RelicRoundTransitionEvent> | undefined;
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        mockRallar.messages.room.mockImplementation((roomDefinition: RallarRoomMessageChannelDefinition) => {
            if (roomDefinition.topicId !== RELIC_TOPICS.event) {
                return idleRoomChannel();
            }
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
        const otherIncarnation = { ...ROUND_STARTED, createdAtEpochMs: 7 };
        const heldIncarnation = { ...ROUND_STARTED, createdAtEpochMs: 1 };

        await act(async () => {
            await deliverTransition(channels, 'relic-room-1', otherIncarnation);
        });
        expect(current?.roundTransition).toBeUndefined();
        expect(current?.diagnostics.roundTransitionCues).toEqual([]);

        await act(async () => {
            await deliverTransition(channels, 'relic-room-1', heldIncarnation);
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
            await deliverTransition(channels, 'relic-room-1', anyIncarnation);
        });

        expect(current?.snapshot).toBeUndefined();
        expect(current?.roundTransition).toEqual(anyIncarnation);
    });

    it('drops a round-transition resync that lands after the page signed out', async () => {
        const channels = captureRoomChannels();
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true && channels.has('relic-room-1'));
        const late = Promise.withResolvers<RelicPublicSnapshot | undefined>();
        vi.mocked(fetchRelicSnapshot).mockReturnValueOnce(late.promise);
        await act(async () => requireResync(requireChannel(channels, 'relic-room-1')));

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
        const late = Promise.withResolvers<RelicPublicSnapshot | undefined>();
        vi.mocked(fetchRelicSnapshot).mockReturnValueOnce(late.promise);
        await act(async () => requireResync(requireChannel(channels, 'relic-room-1')));

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
            await deliverTransition(channels, 'relic-room-1', ROUND_STARTED);
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
            await deliverTransition(channels, 'relic-room-1', ROUND_STARTED);
        });

        await rooms.enter('relic-room-2');
        await waitForState(() => channels.get('relic-room-2')?.onTransition !== undefined);

        expect(current?.roundTransition).toBeUndefined();
        const nextRoomStarted = { ...ROUND_STARTED, gameId: 'relic-room-2' };
        await act(async () => {
            await deliverTransition(channels, 'relic-room-2', nextRoomStarted);
        });
        expect(current?.roundTransition).toEqual(nextRoomStarted);
    });

    it('forgets the hunter event when the page signs out', async () => {
        const channel = captureHunterEventChannel();
        vi.mocked(fetchRelicSnapshot).mockResolvedValue(relicSnapshot(20));
        const refused = refusedHunterEvent(session.sessionId);
        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true && channel.onEvent() !== undefined);
        await act(async () => {
            await channel.onEvent()?.(refused, toHunterMessage(refused));
        });
        expect(current?.lastHunterEvent).toEqual(refused);

        await emitAuthState({ authenticated: false, reason: 'unauthorized' });

        expect(current?.lastHunterEvent).toBeUndefined();
    });

    it('forgets the hunter event of the room the page left', async () => {
        const channel = captureHunterEventChannel();
        const rooms = captureRoomsChange();
        vi.mocked(fetchRelicSnapshot).mockImplementation(async (roomId) => relicSnapshot(20, roomId));
        const refused = refusedHunterEvent(session.sessionId);
        await renderHook();
        await waitForState(() => current?.diagnostics.snapshotReady === true && channel.onEvent() !== undefined);
        await act(async () => {
            await channel.onEvent()?.(refused, toHunterMessage(refused));
        });
        expect(current?.lastHunterEvent).toEqual(refused);

        await rooms.enter('relic-room-2');
        await waitForState(() => current?.snapshot?.roomId === 'relic-room-2');

        expect(current?.lastHunterEvent).toBeUndefined();
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
            mockRallar.auth.restore.mockReturnValue(state.authenticated ? state.session : undefined);
            mockRallar.session.mockReturnValue(state.authenticated ? state.session : undefined);
            for (const listener of authListeners) {
                await listener(state);
            }
        });
    }

    async function waitForState(predicate: () => boolean): Promise<void> {
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(
                predicate(),
                JSON.stringify({
                    connectionState: current?.connectionState,
                    error: current?.error,
                    diagnostics: current?.diagnostics
                })
            ).toBe(true);
        });
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

interface RelicRoomFixture {
    readonly snapshot: GroupSnapshot;
    readonly state: RallarRoomState;
}

function relicRoomFixture(roomId: string): RelicRoomFixture {
    const roomRef = {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        groupId: roomId
    };
    const snapshot: GroupSnapshot = {
        ...createGroupSnapshotFixture({ ...roomRef, sessionIds: [session.clientId] }),
        activeSessions: [{
            ...createActiveGroupPresenceSessionFixture({
                ...roomRef,
                principalId: session.clientId,
                sessionId: session.sessionId
            }),
            connectedAtEpochMs: session.expiresAtEpochMs - 60_000,
            lastHeartbeatAtEpochMs: session.expiresAtEpochMs - 60_000,
            expiresAtEpochMs: session.expiresAtEpochMs
        }]
    };
    return {
        snapshot,
        state: toRallarRoomState({
            groupSnapshots: [snapshot],
            currentRoom: snapshot,
            currentRoomRef: roomRef,
            clientSnapshots: [],
            sessionId: session.sessionId
        })
    };
}

/** Every room the hook subscribes to round transitions for, by the room's group id; other room channels stay silent. */
function captureRoomChannels(): ReadonlyMap<string, CapturedRoomChannel> {
    const channels = new Map<string, CapturedRoomChannel>();
    mockRallar.messages.room.mockImplementation((definition: RallarRoomMessageChannelDefinition) => {
        if (definition.topicId !== RELIC_TOPICS.event) {
            return idleRoomChannel();
        }
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
    const listeners = new Set<(state: RallarRoomState) => void>();
    mockRallar.rooms.onChange.mockImplementation((handler: (state: RallarRoomState) => void) => {
        listeners.add(handler);
        return () => {
            listeners.delete(handler);
        };
    });
    return {
        enter: async (roomId) => {
            await act(async () => {
                const state = relicRoomFixture(roomId).state;
                mockRallar.rooms.state.mockReturnValue(state);
                for (const listener of listeners) {
                    listener(state);
                }
            });
        }
    };
}

function requireChannel(channels: ReadonlyMap<string, CapturedRoomChannel>, roomId: string): CapturedRoomChannel {
    const channel = channels.get(roomId);
    if (!channel) {
        throw new Error(`The runtime must subscribe to ${roomId}`);
    }
    return channel;
}

async function deliverTransition(channels: ReadonlyMap<string, CapturedRoomChannel>, roomId: string, event: RelicRoundTransitionEvent): Promise<void> {
    const channel = requireChannel(channels, roomId);
    if (!channel.onTransition) {
        throw new Error('The room must subscribe to round transitions');
    }
    await channel.onTransition(event, toRoomMessage(event));
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

const ROUND_STARTED: RelicRoundTransitionEvent = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    gameId: 'relic-room-1',
    createdAtEpochMs: 20,
    round: 1,
    phase: 'planning',
    transition: 'round-started',
    text: 'relic started the expedition.'
};

/** The room's hunter channel the hook subscribes; other room channels stay silent. */
function captureHunterEventChannel(): Readonly<{
    definition: () => RallarRoomMessageChannelDefinition | undefined;
    onEvent: () => RallarTypedPayloadHandler<RelicHunterEvent> | undefined;
}> {
    let definition: RallarRoomMessageChannelDefinition | undefined;
    let onEvent: RallarTypedPayloadHandler<RelicHunterEvent> | undefined;
    mockRallar.messages.room.mockImplementation((roomDefinition: RallarRoomMessageChannelDefinition) => {
        if (roomDefinition.topicId !== RELIC_TOPICS.hunter) {
            return idleRoomChannel();
        }
        definition = roomDefinition;
        return {
            onWs: vi.fn((handler: RallarTypedPayloadHandler<RelicHunterEvent>) => {
                onEvent = handler;
                return vi.fn(() => {
                    onEvent = undefined;
                });
            })
        };
    });
    return { definition: () => definition, onEvent: () => onEvent };
}

function refusedHunterEvent(playerId: string): RelicHunterEvent {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: 'relic-room-1',
        principalId: session.clientId,
        playerId,
        kind: 'command-refused',
        completedGameId: null,
        command: 'continue-review',
        text: 'There is no review to continue.'
    };
}

function toHunterMessage(event: RelicHunterEvent): RallarMessage<RelicHunterEvent> {
    const groupRef = { applicationId: DEFAULT_STATE_APPLICATION_ID, workspaceId: DEFAULT_STATE_WORKSPACE_ID, groupId: event.gameId };
    const raw = newALPrincipalBroadcastMessage(
        'default-qbox-server',
        newALRoute(RELIC_TOPICS.hunter, event.gameId, `${event.gameId}:${event.principalId}`),
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
        contextId: event.gameId,
        resourceId: raw.route.resourceId,
        roomId: event.gameId,
        senderId: 'default-qbox-server',
        traceId: raw.id.traceId,
        payload: event,
        raw,
        receivedAtEpochMs: 0,
        reply: vi.fn()
    };
}

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
        traceId: raw.id.traceId,
        payload: event,
        raw,
        receivedAtEpochMs: 0,
        reply: vi.fn()
    };
}

function toSnapshotMessage(snapshot: RelicPublicSnapshot): RallarMessage<RelicServerEvent> {
    const payload: RelicServerEvent = { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: snapshot.gameId, snapshot };
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
    return {
        transport: 'ws',
        typeId: RELIC_TYPES.snapshot,
        topicId: RELIC_TOPICS.snapshot,
        contextId: snapshot.gameId,
        resourceId: snapshot.gameId,
        roomId: snapshot.roomId,
        senderId: 'default-qbox-server',
        traceId: raw.id.traceId,
        payload,
        raw,
        receivedAtEpochMs: Date.now(),
        reply: vi.fn()
    };
}

function relicSnapshot(updatedAtEpochMs: number, roomId = 'relic-room-1'): RelicPublicSnapshot {
    return toPublicRelicSnapshot(createRelicGame(roomId, roomId, updatedAtEpochMs));
}

function idleRoomChannel() {
    return {
        onWs: () => () => undefined,
        sendRtc: async () => ({ wait: async () => ({ lifecycle: { state: 'transport-accepted' as const } }) })
    };
}
