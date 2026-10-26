import '../../../packages/tests/setup-browser-indexeddb.ts';

import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    applyRelicCommand,
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot,
    type RelicCommand,
    type RelicHunterEvent,
    type RelicPublicSnapshot,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import { waitForSettledRead } from '@shared-web/browser/connection/wait-for-settled-read.ts';
import { BrowserRallarSubscriptionScope } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import { createRallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import { RallarRecentRooms, RallarRoomEntry } from '@shared-web/browser/rallar-room-entry.ts';
import type {
    RallarAuthChangeListener,
    RallarRoomPresenceWaitOptions,
    RallarRoomPresenceWaitResult,
    RallarRoomState,
    RallarStartOptions
} from '@shared-web/browser/rallar.ts';
import { RallarRoomDirectory } from '@shared-web/browser/rooms/directory/rallar-room-directory.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    GroupDirectoryEntry,
    GroupDirectoryPage,
    GroupDirectoryRequest
} from '@shared/api/group-directory/group-directory-types.ts';
import type { GroupJoinMode, GroupSnapshot } from '@shared/api/group-types.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';

import { requireRelicCommandApplied } from '../../../packages/tests/relic-hunters/require-relic-command-applied.ts';
import { createGroupSnapshotFixture } from '../../../packages/tests/shared-web/authoritative-group-fixtures.ts';
import { createManualTimers } from '../../../packages/tests/shared/resilience/manual-timers.ts';
import { RelicHuntersRuntime } from '../src/game/relic-hunters-runtime.ts';
import type { RelicWsCommandDelivery } from '../src/game/send-relic-ws-command.ts';
import type { RelicHunterEventSubscription } from '../src/game/subscribe-relic-hunter-events.ts';

const runtimes: RelicHuntersRuntime[] = [];
afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
        runtime.stop();
        await runtime.getState().recentRooms.whenIdle();
    }
});

describe('RelicHuntersRuntime', () => {
    it('clears a private rule refusal when authoritative gameplay advances and ignores late refusals after the finale', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const refusal = refusedPlan();
        backend.deliverHunterEvent(refusal);
        expect(runtime.getState().error).toBe(refusal.text);
        backend.deliverSnapshot(relicSnapshot('room-1', 20));
        expect(runtime.getState().error).toBe(refusal.text);
        backend.deliverSnapshot({ ...relicSnapshot('room-1', 21), phase: 'finished' });
        expect(runtime.getState().error).toBeUndefined();
        backend.deliverHunterEvent(refusal);
        expect(runtime.getState().error).toBeUndefined();
    });

    it('clears obsolete rule feedback when another live tab records a plan before the finale', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        backend.deliverHunterEvent(refusedPlan());
        backend.deliverHunterEvent({
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            principalId: 'alice-client',
            playerId: 'alice-session',
            kind: 'action-recorded',
            round: 1,
            action: { kind: 'search' }
        });
        expect(runtime.getState().error).toBeUndefined();
        backend.deliverSnapshot({ ...relicSnapshot('room-1', 21), phase: 'finished' });
        expect(runtime.getState().error).toBeUndefined();
    });

    it('preserves a transport failure when a newer snapshot expires earlier rule feedback', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        backend.deliverHunterEvent(refusedPlan());
        backend.sendWsCommand = async () => {
            throw new Error('Connection unavailable');
        };
        await runtime.getState().submitAction({ kind: 'search' });
        expect(runtime.getState().error).toBe('Connection unavailable');
        backend.deliverSnapshot({ ...relicSnapshot('room-1', 21), phase: 'finished' });
        expect(runtime.getState().error).toBe('Connection unavailable');
    });

    it('timestamps hydration, commands, and resets using its injected clock', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        expect(runtime.getState().diagnostics.lastHydratedAtEpochMs).toBe(1_000);
        await backend.timers.advance(17);
        backend.deliverSnapshot(relicSnapshot('room-1', 21));
        expect(runtime.getState().diagnostics.lastHydratedAtEpochMs).toBe(1_017);
        await backend.timers.advance(13);
        await runtime.getState().forceResolveRound();
        expect(runtime.getState().diagnostics.lastHydratedAtEpochMs).toBe(1_030);
        await backend.timers.advance(11);
        await runtime.getState().resetExpedition();
        expect(runtime.getState().diagnostics.lastHydratedAtEpochMs).toBe(1_041);
    });

    it('repairs at the injected round deadline and cancels all repair timers on stop', async () => {
        const backend = new RelicRuntimeBackend();
        let game = createRelicGame('room-1', 'room-1', 1);
        const command = { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: 'room-1', username: 'Alice' };
        game = requireRelicCommandApplied(applyRelicCommand(game, { ...command, kind: 'join-expedition' }, {
            senderId: 'client-1',
            now: 2
        })).state;
        game = requireRelicCommandApplied(applyRelicCommand(game, { ...command, kind: 'start-expedition' }, {
            senderId: 'client-1',
            now: backend.timers.nowMs()
        })).state;
        const snapshot = toPublicRelicSnapshot(game);
        expect(snapshot.phase).toBe('planning');
        backend.fetchSnapshot = async (roomId) => {
            backend.reads.push(roomId);
            return snapshot;
        };
        const runtime = createRuntime(backend);
        await runtime.start();
        const initialReads = backend.reads.length;
        await backend.timers.advance(snapshot.roundTimeLimitMs - 1);
        expect(backend.reads).toHaveLength(initialReads);
        await backend.timers.advance(1);
        expect(backend.reads).toHaveLength(initialReads + 1);
        expect(runtime.getState().diagnostics.lastSnapshotSource).toBe('timeout-repair');
        await backend.timers.advance(2_000);
        expect(backend.reads).toHaveLength(initialReads + 2);

        runtime.stop();
        expect(backend.timers.pendingCount()).toBe(0);
        await backend.timers.advance(10_000);
        expect(backend.reads).toHaveLength(initialReads + 2);
    });

    it('records and returns to recent rooms without joining or resetting the expedition, then stops history', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        expect(runtime.getState().recentRooms).toBe(backend.recentRooms);
        await runtime.getState().joinRoom('recent-a');
        await runtime.getState().joinRoom('recent-b');
        await backend.recentRooms.whenIdle();
        expect(backend.recentRooms.getState().rooms.map((visit) => visit.roomRef.groupId)).toEqual(['recent-b', 'recent-a']);

        backend.roomEntry.returnTo({ applicationId: 'rallar-server', workspaceId: 'default', groupId: 'recent-a' }, 'client-1');
        await backend.roomEntry.resume();
        await backend.recentRooms.whenIdle();
        expect(runtime.getState().roomId).toBe('recent-a');
        expect(backend.commands).toEqual([]);
        expect(runtime.getState().snapshot?.players).toEqual([]);

        backend.signOut();
        expect(backend.recentRooms.getState()).toMatchObject({ status: 'signed-out', rooms: [] });
        runtime.stop();
        await backend.recentRooms.whenIdle();
        backend.setRooms(stateFor('late-room'));
        expect(backend.recentRooms.getState().rooms).toEqual([]);
    });

    it('loads safe public directory pages without turning them into member snapshots', async () => {
        const backend = new RelicRuntimeBackend();
        backend.setRooms({ rooms: [], currentRoomId: undefined, members: [] });
        const first = directoryEntry('first');
        const second = directoryEntry('second');
        const requests: GroupDirectoryRequest[] = [];
        backend.listDirectory = async (request) => {
            requests.push(request);
            return request.cursor
                ? { entries: [first, second], nextCursor: null }
                : { entries: [first], nextCursor: 'next-page' };
        };
        const runtime = createRuntime(backend);
        await runtime.start();
        expect(runtime.getState().directory).toEqual({ status: 'ready', entries: [first, second], error: undefined });
        expect(requests).toEqual([
            { kind: 'room', q: 'relic hunters', limit: 50, includeEmpty: false, order: 'online-members' },
            { kind: 'room', q: 'relic hunters', limit: 50, includeEmpty: false, order: 'online-members', cursor: 'next-page' }
        ]);
        expect(runtime.getState().rooms).toEqual([]);
        expect(runtime.getState().snapshot).toBeUndefined();
        expect(backend.reads).toEqual([]);
    });

    it('refreshes public discovery automatically without adopting a room or changing the expedition', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const snapshot = runtime.getState().snapshot;
        backend.listDirectory = async () => ({ entries: [directoryEntry('new-room')], nextCursor: null });
        backend.refreshRooms = async () => stateFor('must-not-adopt');
        await backend.timers.advance(30_000);
        expect(runtime.getState().directory.entries.map((entry) => entry.groupRef.groupId)).toEqual(['new-room']);
        expect(runtime.getState().roomId).toBe('room-1');
        expect(runtime.getState().snapshot).toBe(snapshot);
        backend.listDirectory = async () => ({ entries: [], nextCursor: null });
        await backend.timers.advance(30_000);
        expect(runtime.getState().directory.entries).toEqual([]);
    });

    it('retains directory entries on failure and recovers to a successfully empty directory', async () => {
        const backend = new RelicRuntimeBackend();
        const listed = directoryEntry('listed');
        backend.listDirectory = async () => ({ entries: [listed], nextCursor: null });
        const runtime = createRuntime(backend);
        await runtime.start();
        expect(runtime.getState().directory.entries).toEqual([listed]);
        backend.listDirectory = async () => {
            throw new Error('Directory unavailable');
        };
        await runtime.getState().refreshRooms();
        expect(runtime.getState().directory).toEqual({ status: 'error', entries: [listed], error: 'Directory unavailable' });
        backend.listDirectory = async () => ({ entries: [], nextCursor: null });
        await runtime.getState().refreshRooms();
        expect(runtime.getState().directory).toEqual({ status: 'ready', entries: [], error: undefined });
    });

    it('coalesces overlapping reads and admits a fresh directory refresh after completion', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const readStarted = Promise.withResolvers<void>();
        const read = Promise.withResolvers<GroupDirectoryPage>();
        let requests = 0;
        backend.listDirectory = () => {
            requests += 1;
            readStarted.resolve();
            return read.promise;
        };
        const first = runtime.getState().refreshRooms();
        await readStarted.promise;
        const second = runtime.getState().refreshRooms();
        await Promise.resolve();
        expect(requests).toBe(1);
        const listed = directoryEntry('listed');
        read.resolve({ entries: [listed], nextCursor: null });
        await Promise.all([first, second]);
        expect(runtime.getState().directory.entries).toEqual([listed]);
        backend.listDirectory = async () => ({ entries: [], nextCursor: null });
        await runtime.getState().refreshRooms();
        expect(runtime.getState().directory).toEqual({ status: 'ready', entries: [], error: undefined });
    });

    it('discards a pending directory response when the account signs out', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        expect(runtime.getState().directory.status).toBe('ready');
        const readStarted = Promise.withResolvers<void>();
        const oldRead = Promise.withResolvers<GroupDirectoryPage>();
        backend.listDirectory = () => {
            readStarted.resolve();
            return oldRead.promise;
        };
        const pending = runtime.getState().refreshRooms();
        await readStarted.promise;
        backend.signOut();
        oldRead.resolve({ entries: [directoryEntry('old-account')], nextCursor: null });
        await pending;
        expect(runtime.getState().directory).toEqual({ status: 'idle', entries: [], error: undefined });
    });

    it('hydrates the current expedition, accepts newer events, and stops delivery on cleanup', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        expect(runtime.getState()).toMatchObject({ connectionState: 'ready', roomId: 'room-1', snapshot: { updatedAtEpochMs: 20 } });

        backend.deliverSnapshot(relicSnapshot('room-1', 21));
        expect(runtime.getState().snapshot?.updatedAtEpochMs).toBe(21);
        expect(runtime.getState().diagnostics.lastSnapshotSource).toBe('rallar-ws');
        runtime.stop();
        backend.deliverSnapshot(relicSnapshot('room-1', 22));
        expect(runtime.getState().snapshot?.updatedAtEpochMs).toBe(21);
    });

    it('retains membership and event recovery when the bootstrap snapshot cannot be read', async () => {
        const backend = new RelicRuntimeBackend();
        backend.fetchSnapshot = async () => {
            throw new Error('snapshot unavailable');
        };
        const runtime = createRuntime(backend);
        await runtime.start();
        expect(runtime.getState()).toMatchObject({ connectionState: 'degraded', roomId: 'room-1', error: 'snapshot unavailable' });
        expect(runtime.getState().diagnostics).toMatchObject({ middlewareConnected: true, roomListenerReady: true, wsListenerReady: true });
        backend.deliverSnapshot(relicSnapshot('room-1', 22));
        expect(runtime.getState().snapshot?.updatedAtEpochMs).toBe(22);
    });

    it.each(['success', 'failure'] as const)('enters a new private destination during bootstrap and ignores the old read %s', async (outcome) => {
        const backend = new RelicRuntimeBackend();
        const reading = Promise.withResolvers<void>();
        const oldRead = Promise.withResolvers<RelicPublicSnapshot | undefined>();
        backend.fetchSnapshot = async (roomId) => {
            if (roomId === 'room-1') {
                reading.resolve();
                return await oldRead.promise;
            }
            return relicSnapshot(roomId, 25);
        };
        const runtime = createRuntime(backend);
        const started = runtime.start();
        await reading.promise;
        backend.roomEntry.enter({
            roomRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'new-private-room' },
            joinCode: 'new-room-code'
        });
        await vi.waitFor(() => expect(backend.roomEntry.getState().status).toBe('entered'));
        await vi.waitFor(() => expect(runtime.getState().snapshot?.roomId).toBe('new-private-room'));
        if (outcome === 'success') {
            oldRead.resolve(relicSnapshot('room-1', 20));
        }
        else {
            oldRead.reject(new Error('The old room is unavailable'));
        }
        await started;
        expect(runtime.getState()).toMatchObject({
            connectionState: 'ready',
            roomId: 'new-private-room',
            snapshot: { roomId: 'new-private-room', updatedAtEpochMs: 25 },
            diagnostics: { middlewareConnected: true, roomListenerReady: true, wsListenerReady: true },
            error: undefined
        });
    });

    it.each(['open', 'code', 'invite-only'] as const)('creates a %s room without joining the expedition automatically', async (joinMode) => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const created = await runtime.getState().createRoom(joinMode);
        expect(created?.group).toMatchObject({ groupId: 'created-room', joinMode });
        expect(created?.group.displayName).toMatch(/^Relic Hunters Expedition: .+ #[0-9A-F]{6}/);
        expect(runtime.getState()).toMatchObject({ roomId: 'created-room', snapshot: { roomId: 'created-room' } });
        expect(backend.commands).toEqual([]);
    });

    it('keeps the new private room shareable when leaving the previous room is denied', async () => {
        const backend = new RelicRuntimeBackend();
        backend.rejectPreviousLeave = true;
        const runtime = createRuntime(backend);
        await runtime.start();
        const created = await runtime.getState().createRoom('code');
        expect(created?.group.groupId).toBe('created-room');
        expect(runtime.getState()).toMatchObject({ roomId: 'created-room', connectionState: 'ready' });
        expect(runtime.getState().error).toContain('leaving the previous room failed');
    });

    it('keeps creation pending until presence makes the admitted room current', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const admitted = createGroupSnapshotFixture({
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'created-room',
            sessionIds: []
        });
        backend.createRoom = async () => {
            backend.setRooms({ rooms: [], currentRoomId: undefined, members: [] });
            return admitted;
        };
        const pending = runtime.getState().createRoom('code');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(runtime.getState().connectionState).toBe('joining-room');
        backend.setRooms(stateFor('created-room'));
        await expect(pending).resolves.toEqual(admitted);
        expect(runtime.getState()).toMatchObject({
            connectionState: 'ready',
            roomId: 'created-room',
            snapshot: { roomId: 'created-room' }
        });
    });

    it('does not create a room until authenticated startup has completed', async () => {
        const backend = new RelicRuntimeBackend();
        const ready = await backend.start();
        const startup = Promise.withResolvers<typeof ready>();
        backend.start = () => startup.promise;
        const runtime = createRuntime(backend);
        const started = runtime.start();
        const premature = await runtime.getState().createRoom('code');
        expect(premature).toBeUndefined();
        expect(backend.roomState().currentRoomId).toBe('room-1');
        startup.resolve(ready);
        await started;
        const created = await runtime.getState().createRoom('code');
        expect(created?.group.groupId).toBe('created-room');
    });

    it('keeps the auth-event startup alive when the login promise also completes', async () => {
        const backend = new RelicRuntimeBackend();
        const signedIn = backend.session;
        if (!signedIn) {
            throw new Error('The fixture needs a signed-in hunter');
        }
        backend.session = undefined;
        const runtime = createRuntime(backend);
        await runtime.start();
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let signal: AbortSignal | undefined;
        backend.start = async (options) => {
            signal ??= options?.signal;
            started.resolve();
            await release.promise;
            signal?.throwIfAborted();
            return { session: backend.session, connected: true, roomState: backend.roomState() };
        };
        backend.login = async () => {
            backend.signIn(signedIn);
            return signedIn;
        };
        const login = runtime.getState().login('Alice', 'password');
        await started.promise;
        await Promise.resolve();
        expect(signal?.aborted).toBe(false);
        release.resolve();
        await login;
        expect(runtime.getState().connectionState).toBe('ready');
        expect(runtime.getState().error).toBeUndefined();
    });

    it('discards an old authentication failure after another session has connected', async () => {
        const backend = new RelicRuntimeBackend();
        const session = backend.session;
        if (!session) {
            throw new Error('The fixture needs a signed-in hunter');
        }
        backend.session = undefined;
        const runtime = createRuntime(backend);
        await runtime.start();
        const oldLogin = Promise.withResolvers<AuthSession>();
        backend.login = () => oldLogin.promise;
        const pending = runtime.getState().login('old-account', 'password');
        backend.signIn(session);
        await vi.waitFor(() => expect(runtime.getState().connectionState).toBe('ready'));
        oldLogin.reject(new Error('Obsolete login failed'));
        await pending;
        expect(runtime.getState()).toMatchObject({ connectionState: 'ready', session, error: undefined });
    });

    it('sends gameplay over WS and records the receipt without a second REST attempt', async () => {
        const backend = new RelicRuntimeBackend();
        backend.wsDelivery = { state: 'acknowledged', reason: undefined };
        const runtime = createRuntime(backend);
        await runtime.start();
        await runtime.getState().startExpedition();
        expect(backend.commands).toEqual([{
            transport: 'ws',
            roomId: 'room-1',
            command: {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                gameId: 'room-1',
                username: 'Alice',
                kind: 'start-expedition'
            }
        }]);
        expect(runtime.getState().diagnostics.lastCommandDelivery).toBe('acknowledged');
    });

    it('uses REST only while no WS server is known', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        await runtime.getState().forceResolveRound();
        expect(backend.commands).toEqual([{
            transport: 'rest',
            roomId: 'room-1',
            command: {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                gameId: 'room-1',
                username: 'Alice',
                kind: 'force-resolve-round'
            }
        }]);
        expect(runtime.getState().diagnostics.commandTransport).toBe('rest');
    });

    it('does not resend a rejected WS command through REST', async () => {
        const backend = new RelicRuntimeBackend();
        backend.wsDelivery = { state: 'failed', reason: 'denied' };
        const runtime = createRuntime(backend);
        await runtime.start();
        await runtime.getState().startExpedition();
        expect(backend.commands.map((entry) => entry.transport)).toEqual(['ws']);
        expect(runtime.getState().connectionState).toBe('degraded');
    });

    it('keeps signed-out startup free of game reads and commands', async () => {
        const backend = new RelicRuntimeBackend();
        backend.session = undefined;
        const runtime = createRuntime(backend);
        await runtime.start();
        expect(runtime.getState().connectionState).toBe('signed-out');
        expect(backend.reads).toEqual([]);
        expect(backend.commands).toEqual([]);
    });

    it('adopts a chosen room and applies its reset snapshot', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        await runtime.getState().joinRoom('chosen-room');
        await runtime.getState().resetExpedition();
        expect(runtime.getState()).toMatchObject({ roomId: 'chosen-room', snapshot: { roomId: 'chosen-room', updatedAtEpochMs: 30 } });
        expect(runtime.getState().diagnostics.lastSnapshotSource).toBe('rest-reset');
    });

    it('does not expose an obsolete creation when the account changes before hydration finishes', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const late = Promise.withResolvers<RelicPublicSnapshot | undefined>();
        backend.fetchSnapshot = async () => late.promise;
        const pending = runtime.getState().createRoom('code');
        await vi.waitFor(() => expect(runtime.getState().roomId).toBe('created-room'));
        backend.signOut();
        late.resolve(relicSnapshot('created-room', 25));
        await expect(pending).resolves.toBeUndefined();
        expect(runtime.getState()).toMatchObject({ connectionState: 'signed-out', roomId: undefined, snapshot: undefined });
    });
});

function createRuntime(backend: RelicRuntimeBackend): RelicHuntersRuntime {
    const runtime = new RelicHuntersRuntime(backend);
    runtimes.push(runtime);
    return runtime;
}

interface DeliveredCommand {
    readonly transport: 'ws' | 'rest';
    readonly roomId: string;
    readonly command: RelicCommand;
}

/** In-process external ports expose membership, delivered commands and snapshots, without replacing runtime decisions. */
class RelicRuntimeBackend implements RelicHuntersRuntime.Dependencies {
    public readonly timers = createManualTimers(1_000);
    public session: AuthSession | undefined = {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'Alice',
        sessionId: 'alice-session',
        expiresAtEpochMs: 4_000_000_000_000
    };
    public readonly commands: DeliveredCommand[] = [];
    public readonly reads: string[] = [];
    public wsDelivery: RelicWsCommandDelivery | undefined;
    public rejectPreviousLeave = false;
    private state = stateFor('room-1');
    private readonly authListeners = new Set<RallarAuthChangeListener>();
    private readonly roomListeners = new Set<(state: RallarRoomState) => void>();
    private readonly hunterListeners = new Set<RelicHunterEventSubscription>();
    private readonly snapshotListeners = new Set<(event: RelicServerEvent) => void>();
    public readonly roomEntry: RallarRoomEntry;
    public readonly recentRooms: RallarRecentRooms;
    public readonly directory: RallarRoomDirectory;

    public constructor() {
        this.directory = new RallarRoomDirectory({
            auth: { session: () => this.session, onChange: (listener) => this.onAuthChange(listener) },
            rooms: { directory: (request) => this.listDirectory(request) },
            timers: this.timers,
            activity: { isActive: () => true, onChange: () => () => undefined }
        }, {
            scope: { applicationId: 'rallar-server', workspaceId: 'default' },
            request: { kind: 'room', q: 'relic hunters', limit: 50, includeEmpty: false, order: 'online-members' },
            refreshIntervalMs: 30_000,
            timeoutMs: 10_000,
            maxAttempts: 1
        });
        const storage = new Map<string, string>();
        this.roomEntry = new RallarRoomEntry({
            auth: { session: () => this.session, onChange: (listener) => this.onAuthChange(listener) },
            rooms: { onChange: (listener) => this.onRoomsChange(listener), join: async (ref) => this.admit(ref.groupId) },
            storage: {
                getItem: (key) => storage.get(key) ?? null,
                setItem: (key, value) => {
                    storage.set(key, value);
                },
                removeItem: (key) => {
                    storage.delete(key);
                }
            },
            location: { read: () => 'http://localhost/', replace: () => undefined, onChange: () => () => undefined }
        }, { scope: { applicationId: 'rallar-server', workspaceId: 'default' } });
        const data = createRallarDataFacade({ manager: new RepositoryManager(), resolveScopeKey: (scope) => scope });
        const dbName = `relic-recent-rooms-${crypto.randomUUID()}`;
        this.recentRooms = new RallarRecentRooms({
            auth: { session: () => this.session, onChange: (listener) => this.onAuthChange(listener) },
            entry: this.roomEntry,
            data: { open: (input, options) => data.open(input, { ...options, dbName, sync: false }) },
            now: () => this.timers.nowMs()
        }, { scope: { applicationId: 'rallar-server', workspaceId: 'default' } });
    }

    public restoreSession() {
        return this.session;
    }
    public async start(_options?: RallarStartOptions) {
        return { session: this.session, connected: !!this.session, roomState: this.state };
    }
    public subscriptions() {
        return new BrowserRallarSubscriptionScope();
    }
    public async login() {
        if (!this.session) {
            throw new Error('No session configured');
        }
        return this.session;
    }
    public async register() {
        return this.login();
    }
    public async logout() {
        this.signOut();
    }
    public onAuthChange(listener: RallarAuthChangeListener) {
        this.authListeners.add(listener);
        return () => {
            this.authListeners.delete(listener);
        };
    }
    public roomState() {
        return this.state;
    }
    public setRooms(state: RallarRoomState): void {
        this.state = state;
        for (const listener of this.roomListeners) {
            listener(state);
        }
    }
    public async refreshRooms() {
        return this.state;
    }
    public async listDirectory(_request: GroupDirectoryRequest): Promise<GroupDirectoryPage> {
        return { entries: [], nextCursor: null };
    }
    public async waitForPresence(roomId: string, options: RallarRoomPresenceWaitOptions): Promise<RallarRoomPresenceWaitResult> {
        const result = (status: RallarRoomPresenceWaitResult['status']): RallarRoomPresenceWaitResult => ({
            status,
            roomId,
            activeSessionIds: status === 'ready' ? ['alice-session'] : [],
            timedOut: status === 'timeout',
            observedSessionIds: status === 'ready' ? ['alice-session'] : [],
            missingSessionIds: status === 'ready' ? [] : ['alice-session'],
            extraSessionIds: [],
            observedCount: status === 'ready' ? 1 : 0
        });
        return await waitForSettledRead({
            readResult: () => result(this.state.currentRoomId === roomId ? 'ready' : 'empty'),
            isSettled: (value) => value.status === 'ready',
            subscribe: (listener) => this.onRoomsChange(() => void listener()),
            signal: options.signal,
            timeoutMs: options.timeoutMs ?? 10_000,
            toTimedOut: () => result('timeout'),
            toAborted: () => result('aborted')
        });
    }
    public onRoomsChange(listener: (state: RallarRoomState) => void) {
        this.roomListeners.add(listener);
        return () => {
            this.roomListeners.delete(listener);
        };
    }
    public onSnapshotMessage(listener: (event: RelicServerEvent) => void) {
        this.snapshotListeners.add(listener);
        return () => {
            this.snapshotListeners.delete(listener);
        };
    }
    public onRtcSnapshotMessage() {
        return () => undefined;
    }
    public onAuthoritySnapshotMessage() {
        return () => undefined;
    }
    public onRoundTransitionMessage() {
        return () => undefined;
    }
    public onHunterEventMessage(_roomId: string, subscription: RelicHunterEventSubscription) {
        this.hunterListeners.add(subscription);
        return () => {
            this.hunterListeners.delete(subscription);
        };
    }
    public deliverHunterEvent(event: RelicHunterEvent): void {
        for (const subscription of this.hunterListeners) {
            subscription.onEvent(event);
        }
    }
    public authorityStatus() {
        return undefined;
    }
    public async publishRtcSnapshot() {
        return true;
    }
    public async joinRoom(roomId: string) {
        this.admit(roomId);
    }
    public async resetGame(roomId: string) {
        return relicSnapshot(roomId, 30);
    }

    public async createRoom(displayName: string, joinMode: GroupJoinMode): Promise<GroupSnapshot> {
        const admitted = this.admit('created-room', joinMode, displayName);
        if (this.rejectPreviousLeave) {
            throw Object.assign(new Error('Cannot remove the last owner'), {
                name: 'RallarRoomSwitchPartialFailureError',
                operation: 'create-and-switch',
                joinedRoom: admitted
            });
        }
        return admitted;
    }

    public fetchSnapshot = async (roomId: string): Promise<RelicPublicSnapshot | undefined> => {
        this.reads.push(roomId);
        return relicSnapshot(roomId, 20);
    };

    public async sendWsCommand(roomId: string, command: RelicCommand): Promise<RelicWsCommandDelivery | undefined> {
        if (this.wsDelivery) {
            this.commands.push({ transport: 'ws', roomId, command });
        }
        return this.wsDelivery;
    }

    public async sendRestCommand(roomId: string, command: RelicCommand): Promise<RelicPublicSnapshot> {
        this.commands.push({ transport: 'rest', roomId, command });
        return relicSnapshot(roomId, 25);
    }

    public deliverSnapshot(snapshot: RelicPublicSnapshot): void {
        for (const listener of this.snapshotListeners) {
            listener({ protocolVersion: RELIC_PROTOCOL_VERSION, gameId: snapshot.gameId, snapshot });
        }
    }

    public signOut(): void {
        this.session = undefined;
        for (const listener of this.authListeners) {
            void listener({ authenticated: false, reason: 'unauthorized', session: undefined });
        }
    }

    public signIn(session: AuthSession): void {
        this.session = session;
        for (const listener of this.authListeners) {
            void listener({ authenticated: true, reason: 'login', session });
        }
    }

    private admit(roomId: string, joinMode: GroupJoinMode = 'open', displayName = roomId): GroupSnapshot {
        const room = stateFor(roomId).currentRoom;
        if (!room) {
            throw new Error('The test room must contain a snapshot');
        }
        const snapshot = { ...room, group: { ...room.group, joinMode, displayName } };
        this.setRooms({ ...stateFor(roomId), currentRoom: snapshot });
        return snapshot;
    }
}

function stateFor(roomId: string): RallarRoomState {
    const ref = { applicationId: 'rallar-server', workspaceId: 'default', groupId: roomId };
    const currentRoom = createGroupSnapshotFixture({ ...ref, sessionIds: ['alice-session'] });
    return { rooms: [], currentRoomId: roomId, currentRoomRef: ref, currentRoom, members: [] };
}

function relicSnapshot(roomId: string, atEpochMs: number): RelicPublicSnapshot {
    return toPublicRelicSnapshot(createRelicGame(roomId, roomId, atEpochMs));
}

function directoryEntry(groupId: string): GroupDirectoryEntry {
    return {
        groupRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId },
        displayName: `Relic Hunters Expedition: ${groupId}`,
        kind: 'room',
        joinMode: 'open',
        memberCount: 1,
        onlineMemberCount: 1,
        maxMembers: null,
        isFull: false,
        lifecycleState: 'active',
        peerRttMs: null
    };
}

function refusedPlan(): RelicHunterEvent {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        gameId: 'room-1',
        principalId: 'alice-client',
        playerId: 'alice-session',
        kind: 'command-refused',
        command: 'submit-action',
        text: 'Review the revealed actions before planning the next turn.'
    };
}
