import {
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
    type RelicHunterEvent,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    GroupDirectoryEntry,
    GroupDirectoryPage,
    GroupDirectoryRequest
} from '@shared/api/group-directory/group-directory-types.ts';

import { requireRelicCommandApplied } from '../../../packages/tests/relic-hunters/require-relic-command-applied.ts';
import { createGroupSnapshotFixture } from '../../../packages/tests/shared-web/authoritative-group-fixtures.ts';
import { RelicCommandRefusedError } from '../src/game/api.ts';
import { RelicHuntersRuntime } from '../src/game/relic-hunters-runtime.ts';
import type { RelicWsCommandDelivery } from '../src/game/send-relic-ws-command.ts';
import {
    createRuntime,
    RelicRuntimeBackend,
    relicSnapshot,
    stateFor
} from './relic-runtime-backend.ts';

describe('RelicHuntersRuntime', () => {
    it('cleans up every auth subscription after a listener stops and restarts startup', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        let restarted: Promise<void> | undefined;
        let restartRequested = false;
        runtime.subscribe(() => {
            if (!restartRequested) {
                restartRequested = true;
                runtime.stop();
                restarted = runtime.start();
            }
        });
        await runtime.start();
        await restarted;
        expect(runtime.getState().connectionState).toBe('ready');
        runtime.stop();
        await backend.recentRooms.whenIdle();
        expect(backend.authSubscriptionCount).toBe(0);
        expect(backend.timers.pendingCount()).toBe(0);
    });

    it('keeps entry observation when startup discovers a restored session', async () => {
        const backend = new RelicRuntimeBackend();
        const session = backend.session;
        backend.session = undefined;
        const runtime = createRuntime(backend);
        backend.session = session;
        const subscribeAuth = backend.onAuthChange.bind(backend);
        backend.onAuthChange = (listener) => {
            const unsubscribe = subscribeAuth(listener);
            void listener({ authenticated: !!backend.session, session: backend.session, reason: 'current' });
            return unsubscribe;
        };
        await runtime.start();
        expect(runtime.getState().connectionState).toBe('ready');
        backend.roomEntry.returnTo({ applicationId: 'rallar-server', workspaceId: 'default', groupId: 'invited-room' }, 'client-1');
        await vi.waitFor(() => expect(runtime.getState().roomId).toBe('invited-room'));
    });

    it.each(['login', 'command', 'reset'])('keeps logout authoritative when a %s failure listener signs out', async (operation) => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        backend.login = async () => {
            throw new Error('operation refused');
        };
        backend.sendWsCommand = async () => {
            throw new Error('operation refused');
        };
        backend.resetGame = async () => {
            throw new Error('operation refused');
        };
        let logout: Promise<void> | undefined;
        let loggingOut = false;
        const observed: RelicHuntersRuntime.Connection[] = [];
        runtime.subscribe(() => {
            if (!loggingOut && runtime.getState().error === 'operation refused') {
                loggingOut = true;
                logout = runtime.getState().logout();
            }
        });
        runtime.subscribe(() => {
            if (loggingOut) {
                observed.push(runtime.getState());
            }
        });
        if (operation === 'login') {
            await runtime.getState().login('Alice', 'password');
        }
        else if (operation === 'command') {
            await runtime.getState().startExpedition();
        }
        else {
            await runtime.getState().resetExpedition();
        }
        await logout;
        expect(observed.length).toBeGreaterThan(0);
        for (const state of observed) {
            expect(state).toMatchObject({ connectionState: 'signed-out', error: undefined });
            expect(state.diagnostics.phase).toBe('signed-out');
        }
    });

    it('does not install repair timers after a connected listener stops the runtime', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        runtime.subscribe(() => {
            if (runtime.getState().connectionState === 'connected') {
                runtime.stop();
            }
        });
        await runtime.start();
        expect(backend.timers.pendingCount()).toBe(0);
        await backend.timers.advance(10_000);
        expect(backend.reads).toEqual([]);
    });

    it('does not send a command after its pending notification stops the runtime', async () => {
        const backend = new RelicRuntimeBackend();
        backend.wsDelivery = { state: 'acknowledged', reason: undefined };
        const runtime = createRuntime(backend);
        await runtime.start();
        runtime.subscribe(() => {
            if (runtime.getState().diagnostics.commandInFlight) {
                runtime.stop();
            }
        });
        await runtime.getState().startExpedition();
        expect(backend.commands).toEqual([]);
        expect(backend.timers.pendingCount()).toBe(0);
    });

    it('does not admit a room after its joining notification logs out', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        let logout: Promise<void> | undefined;
        runtime.subscribe(() => {
            if (runtime.getState().connectionState === 'joining-room') {
                logout = runtime.getState().logout();
            }
        });
        await runtime.getState().joinRoom('obsolete-room');
        await logout;
        expect(backend.roomState().currentRoomId).toBe('room-1');
        expect(runtime.getState()).toMatchObject({ connectionState: 'signed-out', roomId: undefined });
    });

    it('does not restore snapshot diagnostics after its notification logs out', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        let logout: Promise<void> | undefined;
        runtime.subscribe(() => {
            if (runtime.getState().snapshot?.updatedAtEpochMs === 21) {
                logout = runtime.getState().logout();
            }
        });
        const observed: RelicHuntersRuntime.Connection[] = [];
        runtime.subscribe(() => {
            observed.push(runtime.getState());
        });
        backend.deliverSnapshot(relicSnapshot('room-1', 21));
        await logout;
        expect(observed.length).toBeGreaterThan(0);
        for (const state of observed) {
            expect(state).toMatchObject({ connectionState: 'signed-out', snapshot: undefined });
            expect(state.diagnostics.lastAcceptedSnapshot).toBeUndefined();
        }
    });

    it('keeps startup and later observers working when a state listener fails', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
        const observed: string[] = [];
        const unsubscribe = runtime.subscribe(() => {
            throw new Error('view failed');
        });
        runtime.subscribe(() => {
            observed.push(runtime.getState().connectionState);
        });
        try {
            await runtime.start();
            expect(runtime.getState().connectionState).toBe('ready');
            expect(observed.at(-1)).toBe('ready');
            unsubscribe();
            backend.signOut();
            expect(observed.at(-1)).toBe('signed-out');
        }
        finally {
            unsubscribe();
            reported.mockRestore();
        }
    });

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

    it('shows a rematch refusal while results remain and ignores it after the next expedition starts', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const finished = { ...relicSnapshot('room-1', 21), phase: 'finished' as const };
        backend.deliverSnapshot(finished);
        const refusal = {
            ...refusedPlan(),
            command: 'set-rematch-ready' as const,
            completedGameId: `room-1:${finished.createdAtEpochMs}`,
            text: 'Your room membership changed. Confirm again.'
        };
        backend.deliverHunterEvent(refusal);
        expect(runtime.getState().error).toBe(refusal.text);
        expect(runtime.getState().snapshot?.phase).toBe('finished');
        backend.deliverSnapshot({ ...finished, createdAtEpochMs: finished.createdAtEpochMs + 1, updatedAtEpochMs: 22, phase: 'planning' });
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
        game = requireRelicCommandApplied(
            applyRelicCommand(game, { ...command, kind: 'join-expedition' }, { presentPlayerIds: ['client-1'], senderId: 'client-1', now: 2 })
        ).state;
        game = requireRelicCommandApplied(
            applyRelicCommand(game, { ...command, kind: 'start-expedition' }, {
                presentPlayerIds: ['client-1'],
                senderId: 'client-1',
                now: backend.timers.nowMs()
            })
        ).state;
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

    it.each(['success', 'failure'] as const)('enters a new private destination during spectator bootstrap and ignores the old read %s', async (outcome) => {
        const backend = new RelicRuntimeBackend();
        const rooms = backend.roomState();
        if (!rooms.currentRoom) {
            throw new Error('Expected current room');
        }
        backend.setRooms({
            ...rooms,
            currentRoom: { ...rooms.currentRoom, members: rooms.currentRoom.members.map((member) => ({ ...member, role: 'spectator' })) }
        });
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
            joinCode: 'new-room-code',
            participation: 'preserve'
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

    it('uses the supplied seed to make room naming reproducible', async () => {
        const firstBackend = new RelicRuntimeBackend();
        const secondBackend = new RelicRuntimeBackend();
        const first = createRuntime(firstBackend);
        const second = createRuntime(secondBackend);
        await first.start();
        await second.start();
        const firstRoom = await first.getState().createRoom('code');
        const secondRoom = await second.getState().createRoom('code');
        expect(firstRoom?.group.displayName).toMatch(/^Relic Hunters Expedition: .+ #[0-9A-F]{6}/);
        expect(secondRoom?.group.displayName).toBe(firstRoom?.group.displayName);
        secondBackend.createRoomNameSeed = () => 'another-controlled-seed';
        const anotherRoom = await second.getState().createRoom('code');
        expect(anotherRoom?.group.displayName).toMatch(/^Relic Hunters Expedition: /);
        expect(anotherRoom?.group.displayName).not.toBe(firstRoom?.group.displayName);
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

    it('keeps a created code room shareable when its cache expires before previous-room cleanup fails', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const room = createGroupSnapshotFixture({
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'created-room',
            sessionIds: ['alice-session']
        });
        const admitted = { ...room, group: { ...room.group, joinMode: 'code' as const } };
        backend.createRoom = async () => {
            backend.setRooms({ rooms: [], currentRoomId: undefined, members: [] });
            throw Object.assign(new Error('Cannot remove the last owner'), {
                name: 'RallarRoomSwitchPartialFailureError',
                operation: 'create-and-switch',
                joinedRoom: admitted
            });
        };
        const created = runtime.getState().createRoom('code');
        const result = expect(created).resolves.toMatchObject({ group: { groupId: 'created-room' } });
        // Deliver the already-rejected cleanup result before the independent cache recovery.
        await Promise.resolve();
        backend.setRooms(stateFor('created-room'));
        await result;
        expect(runtime.getState()).toMatchObject({ roomId: 'created-room', connectionState: 'ready' });
        expect(backend.commands).toEqual([]);
    });

    it('does not report a different current room as the newly created room after cleanup fails', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const created = createGroupSnapshotFixture({
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'created-room',
            sessionIds: ['alice-session']
        });
        backend.createRoom = async () => {
            backend.setRooms(stateFor('selected-elsewhere'));
            throw Object.assign(new Error('Cannot remove the last owner'), {
                name: 'RallarRoomSwitchPartialFailureError',
                operation: 'create-and-switch',
                joinedRoom: created
            });
        };
        // Both rooms still have live presence; current selection alone chooses which one the app adopts.
        backend.waitForPresence = async (roomId) => ({
            status: 'ready',
            roomId,
            activeSessionIds: ['alice-session'],
            timedOut: false,
            observedSessionIds: ['alice-session'],
            missingSessionIds: [],
            extraSessionIds: [],
            observedCount: 1
        });
        await expect(runtime.getState().createRoom('code')).resolves.toBeUndefined();
        expect(runtime.getState().roomId).toBe('selected-elsewhere');
    });

    it.each([undefined, { group: { groupId: 'missing-snapshot-fields' } }])(
        'rejects a cleanup failure with an invalid created snapshot (%j)',
        async (joinedRoom) => {
            const backend = new RelicRuntimeBackend();
            const runtime = createRuntime(backend);
            await runtime.start();
            backend.createRoom = async () => {
                throw Object.assign(new Error('Invalid partial result'), {
                    name: 'RallarRoomSwitchPartialFailureError',
                    operation: 'create-and-switch',
                    joinedRoom
                });
            };
            await expect(runtime.getState().createRoom('code')).rejects.toThrow();
            expect(runtime.getState().roomId).toBe('room-1');
        }
    );

    it('preserves a real creation failure without accepting the previously selected room', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const failure = new Error('Room creation refused');
        backend.createRoom = async () => {
            throw failure;
        };
        await expect(runtime.getState().createRoom('code')).rejects.toBe(failure);
        expect(runtime.getState()).toMatchObject({ roomId: 'room-1', connectionState: 'error', error: failure.message });
    });

    it('discards late creation hydration after the runtime stops', async () => {
        const backend = new RelicRuntimeBackend();
        backend.rejectPreviousLeave = true;
        const runtime = createRuntime(backend);
        await runtime.start();
        const late = Promise.withResolvers<RelicPublicSnapshot | undefined>();
        backend.fetchSnapshot = async () => late.promise;
        const pending = runtime.getState().createRoom('code');
        await vi.waitFor(() => expect(runtime.getState().roomId).toBe('created-room'));
        runtime.stop();
        const stopped = runtime.getState();
        late.resolve(relicSnapshot('created-room', 25));
        await expect(pending).resolves.toBeUndefined();
        expect(runtime.getState()).toBe(stopped);
        expect(backend.timers.pendingCount()).toBe(0);
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

    it('binds Play again commands to the displayed completed expedition and settings', async () => {
        const backend = new RelicRuntimeBackend();
        backend.wsDelivery = { state: 'acknowledged', reason: undefined };
        const runtime = createRuntime(backend);
        await runtime.start();
        const finished = { ...relicSnapshot('room-1', 21), phase: 'finished' as const };
        backend.deliverSnapshot(finished);
        await runtime.getState().setRematchReady(true, 'kael-ironstride');
        await runtime.getState().startRematch();
        await runtime.getState().setRematchRoundLimit(180_000);
        expect(backend.commands.map((entry) => entry.command)).toEqual([
            expect.objectContaining({
                kind: 'set-rematch-ready',
                ready: true,
                characterId: 'kael-ironstride',
                completedGameId: `room-1:${finished.createdAtEpochMs}`,
                settingsKey: `round-limit:${finished.roundTimeLimitMs}:0`
            }),
            expect.objectContaining({ kind: 'start-rematch', completedGameId: `room-1:${finished.createdAtEpochMs}` }),
            expect.objectContaining({ kind: 'set-rematch-round-limit', timeLimitMs: 180_000 })
        ]);
        backend.deliverSnapshot({ ...finished, phase: 'planning', updatedAtEpochMs: finished.updatedAtEpochMs + 1 });
        await runtime.getState().setRematchReady(false, 'kael-ironstride');
        expect(backend.commands).toHaveLength(3);
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

    it('requires explicit departure before an unfinished participant can watch through either entry path', async () => {
        const backend = new RelicRuntimeBackend();
        const admission = vi.spyOn(backend, 'joinRoom');
        const runtime = createRuntime(backend);
        await runtime.start();
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            username: 'Alice',
            kind: 'join-expedition'
        }, { presentPlayerIds: ['alice-session'], senderId: 'alice-session', now: 30 })).state;
        backend.deliverSnapshot(toPublicRelicSnapshot(game));
        await runtime.getState().watchRoom('room-1');
        expect(admission).not.toHaveBeenCalled();
        backend.roomEntry.enter({
            roomRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'other-room' },
            joinCode: null,
            participation: 'spectator'
        });
        expect(backend.roomEntry.getState().status).toBe('idle');
        expect(runtime.getState().roomId).toBe('room-1');
        expect(runtime.getState().error).toContain('Leave expedition');
        backend.sendRestCommand = async () => ({ ...toPublicRelicSnapshot(game), updatedAtEpochMs: 31, players: [], adminPlayerId: undefined });
        await runtime.getState().leaveRoom();
        await runtime.getState().watchRoom('other-room');
        expect(admission).toHaveBeenCalledWith('other-room', 'spectator');
    });

    it('keeps an unfinished hunter in their room across create, direct entry and room-link entry', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            username: 'Alice',
            kind: 'join-expedition'
        }, { senderId: 'alice-session', now: 30, presentPlayerIds: ['alice-session'] })).state;
        backend.deliverSnapshot(toPublicRelicSnapshot(game));
        expect(await runtime.getState().createRoom('open')).toBeUndefined();
        expect(backend.roomState().currentRoomId).toBe('room-1');
        await runtime.getState().joinRoom('other-room');
        expect(backend.roomState().currentRoomId).toBe('room-1');
        backend.roomEntry.enter({
            roomRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'other-room' },
            joinCode: null,
            participation: 'preserve'
        });
        expect(backend.roomEntry.getState().status).toBe('idle');
        expect(runtime.getState().snapshot?.players.map((player) => player.playerId)).toEqual(['alice-session']);
        expect(runtime.getState().error).toContain('Leave expedition');
    });

    it('keeps committed withdrawal visible when room removal fails and lets room departure retry', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            username: 'Alice',
            kind: 'join-expedition'
        }, { senderId: 'alice-session', now: 30, presentPlayerIds: ['alice-session'] })).state;
        backend.deliverSnapshot(toPublicRelicSnapshot(game));
        backend.sendRestCommand = async () => ({ ...toPublicRelicSnapshot(game), updatedAtEpochMs: 31, players: [], adminPlayerId: undefined });
        const leaveRoom = backend.leaveRoom.bind(backend);
        backend.leaveRoom = async () => {
            throw new Error('Room departure unavailable');
        };
        await runtime.getState().leaveRoom();
        expect(runtime.getState().roomId).toBe('room-1');
        expect(runtime.getState().snapshot?.players).toEqual([]);
        expect(runtime.getState().error).toContain('Room departure unavailable');
        backend.leaveRoom = leaveRoom;
        await runtime.getState().leaveRoom();
        expect(runtime.getState().roomId).toBeUndefined();
    });

    it('waits for durable admission before allowing departure, even with a WebSocket server', async () => {
        const backend = new RelicRuntimeBackend();
        backend.wsDelivery = { state: 'acknowledged', reason: undefined };
        const admitted = Promise.withResolvers<RelicPublicSnapshot>();
        const requests: string[] = [];
        backend.sendRestCommand = async ({ command }) => {
            requests.push(command.kind);
            return await admitted.promise;
        };
        const runtime = createRuntime(backend);
        await runtime.start();
        const joining = runtime.getState().joinExpedition();
        await runtime.getState().leaveRoom();
        await runtime.getState().startExpedition();
        expect(await runtime.getState().createRoom('open')).toBeUndefined();
        expect(backend.roomState().currentRoomId).toBe('room-1');
        await vi.waitFor(() => expect(requests).toEqual(['join-expedition']));
        expect(backend.commands).toEqual([]);
        admitted.resolve(relicSnapshot('room-1', 25));
        await joining;
    });

    it('reconciles an uncertain admission with the same request before withdrawing and leaving', async () => {
        const backend = new RelicRuntimeBackend();
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            username: 'Alice',
            kind: 'join-expedition'
        }, { senderId: 'alice-session', now: 30, presentPlayerIds: ['alice-session'] })).state;
        const requests: { kind: string; requestId: string; }[] = [];
        backend.sendRestCommand = async ({ command, requestId }) => {
            requests.push({ kind: command.kind, requestId });
            backend.fetchSnapshot = async () => toPublicRelicSnapshot(game);
            if (requests.length === 1) {
                throw new TypeError('Response lost after admission');
            }
            return command.kind === 'join-expedition'
                ? toPublicRelicSnapshot(game)
                : { ...toPublicRelicSnapshot(game), updatedAtEpochMs: 31, players: [], adminPlayerId: undefined };
        };
        const runtime = createRuntime(backend);
        await runtime.start();
        await runtime.getState().joinExpedition();
        await runtime.getState().joinRoom('other-room');
        expect(backend.roomState().currentRoomId).toBe('room-1');
        await runtime.getState().leaveRoom();
        expect(requests.map((request) => request.kind)).toEqual(['join-expedition', 'join-expedition', 'leave-expedition']);
        expect(requests[1].requestId).toBe(requests[0].requestId);
        expect(requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(backend.roomState().currentRoomId).toBeUndefined();
    });

    it('allows departure after a definitive admission refusal without replaying Join', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const requests: string[] = [];
        backend.sendRestCommand = async ({ command }) => {
            requests.push(command.kind);
            throw new RelicCommandRefusedError('The expedition is full');
        };
        await runtime.getState().joinExpedition();
        await runtime.getState().leaveRoom();
        expect(requests).toEqual(['join-expedition']);
        expect(backend.roomState().currentRoomId).toBeUndefined();
    });

    it('does not submit Join or remove membership when admission cannot be persisted', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        backend.data.open = async () => {
            throw new Error('Local storage unavailable');
        };
        await runtime.getState().joinExpedition();
        expect(runtime.getState().error).toContain('Local storage unavailable');
        await runtime.getState().leaveRoom();
        expect(backend.commands).toEqual([]);
        expect(backend.roomState().currentRoomId).toBe('room-1');
    });

    it('reconciles a persisted uncertain Join when a replacement runtime starts', async () => {
        const backend = new RelicRuntimeBackend();
        const requests: string[] = [];
        backend.sendRestCommand = async ({ requestId }) => {
            requests.push(requestId);
            if (requests.length === 1) {
                throw new TypeError('Connection lost');
            }
            return relicSnapshot('room-1', 25);
        };
        const first = createRuntime(backend);
        await first.start();
        await first.getState().joinExpedition();
        first.stop();
        const recovered = createRuntime(backend);
        await recovered.start();
        expect(requests).toHaveLength(2);
        expect(requests[1]).toBe(requests[0]);
        expect(recovered.getState().connectionState).toBe('ready');
        await recovered.getState().leaveRoom();
        expect(backend.roomState().currentRoomId).toBeUndefined();
    });

    it('keeps same-room role admission blocked while spectator departure is pending', async () => {
        const backend = new RelicRuntimeBackend();
        const state = backend.roomState();
        const room = state.currentRoom;
        if (!room) {
            throw new Error('Expected room');
        }
        backend.setRooms({ ...state, currentRoom: { ...room, members: room.members.map((member) => ({ ...member, role: 'spectator' })) } });
        const runtime = createRuntime(backend);
        await runtime.start();
        const removed = Promise.withResolvers<void>();
        backend.leaveRoom = () => removed.promise;
        const leaving = runtime.getState().leaveRoom();
        await runtime.getState().joinAsPlayer();
        expect(runtime.getState().participation).toBe('spectator');
        expect(runtime.getState().diagnostics.commandInFlight).toBe('leave-expedition');
        removed.resolve();
        await leaving;
    });

    it('does not let an old departure unlock a new departure after room-role changes', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            username: 'Alice',
            kind: 'join-expedition'
        }, { senderId: 'alice-session', now: 30, presentPlayerIds: ['alice-session'] })).state;
        backend.deliverSnapshot(toPublicRelicSnapshot(game));
        const older = Promise.withResolvers<RelicPublicSnapshot>();
        const newer = Promise.withResolvers<RelicPublicSnapshot>();
        backend.sendRestCommand = () => older.promise;
        const first = runtime.getState().leaveExpedition();
        const playerState = backend.roomState();
        const room = playerState.currentRoom;
        if (!room) {
            throw new Error('Expected current room');
        }
        backend.setRooms({ ...playerState, currentRoom: { ...room, members: room.members.map((member) => ({ ...member, role: 'spectator' })) } });
        backend.setRooms(playerState);
        backend.sendRestCommand = () => newer.promise;
        const second = runtime.getState().leaveExpedition();
        const withdrawn = { ...toPublicRelicSnapshot(game), updatedAtEpochMs: 31, players: [], adminPlayerId: undefined };
        older.resolve(withdrawn);
        await first;
        expect(runtime.getState().diagnostics.commandInFlight).toBe('leave-expedition');
        await runtime.getState().joinExpedition();
        expect(backend.commands).toEqual([]);
        newer.resolve(withdrawn);
        await second;
    });

    it('keeps room membership when expedition hydration has not established participation', async () => {
        const backend = new RelicRuntimeBackend();
        const hydrate = Promise.withResolvers<RelicPublicSnapshot | undefined>();
        backend.fetchSnapshot = () => hydrate.promise;
        const runtime = createRuntime(backend);
        const started = runtime.start();
        await vi.waitFor(() => expect(runtime.getState().roomId).toBe('room-1'));
        expect(runtime.getState().snapshot).toBeUndefined();
        await runtime.getState().leaveRoom();
        expect(backend.roomState().currentRoomId).toBe('room-1');
        expect(runtime.getState().error).toContain('Expedition state is not ready');
        hydrate.resolve(relicSnapshot('room-1', 20));
        await started;
    });

    it('keeps membership when a newer hunter snapshot supersedes the withdrawal response', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            username: 'Alice',
            kind: 'join-expedition'
        }, { senderId: 'alice-session', now: 30, presentPlayerIds: ['alice-session'] })).state;
        backend.deliverSnapshot(toPublicRelicSnapshot(game));
        const committed = Promise.withResolvers<RelicPublicSnapshot>();
        backend.sendRestCommand = () => committed.promise;
        const leaving = runtime.getState().leaveRoom();
        backend.deliverSnapshot({ ...toPublicRelicSnapshot(game), updatedAtEpochMs: 32 });
        committed.resolve({ ...toPublicRelicSnapshot(game), updatedAtEpochMs: 31, players: [], adminPlayerId: undefined });
        await leaving;
        expect(backend.roomState().currentRoomId).toBe('room-1');
        expect(runtime.getState().snapshot?.players.map((player) => player.playerId)).toEqual(['alice-session']);
        expect(runtime.getState().error).toContain('Expedition changed');
    });

    it('keeps room membership until withdrawal commits even when WebSocket delivery is available', async () => {
        const backend = new RelicRuntimeBackend();
        backend.wsDelivery = { state: 'acknowledged', reason: undefined };
        const runtime = createRuntime(backend);
        await runtime.start();
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            username: 'Alice',
            kind: 'join-expedition'
        }, { senderId: 'alice-session', now: 30, presentPlayerIds: ['alice-session'] })).state;
        backend.deliverSnapshot(toPublicRelicSnapshot(game));
        const committed = Promise.withResolvers<RelicPublicSnapshot>();
        backend.sendRestCommand = async ({ gameId: roomId, command }) => {
            backend.commands.push({ transport: 'rest', roomId, command });
            return await committed.promise;
        };
        const leaving = runtime.getState().leaveRoom();
        await vi.waitFor(() => expect(backend.commands.some((entry) => entry.command.kind === 'leave-expedition')).toBe(true));
        expect(backend.roomState().currentRoomId).toBe('room-1');
        backend.deliverSnapshot({ ...toPublicRelicSnapshot(game), updatedAtEpochMs: 31, players: [], adminPlayerId: undefined });
        await runtime.getState().joinExpedition();
        await runtime.getState().joinRoom('another-room');
        expect(backend.roomState().currentRoomId).toBe('room-1');
        expect(backend.commands.map((entry) => [entry.transport, entry.command.kind])).toEqual([['rest', 'leave-expedition']]);
        committed.resolve({ ...toPublicRelicSnapshot(game), updatedAtEpochMs: 31, players: [], adminPlayerId: undefined });
        await leaving;
        expect(runtime.getState().roomId).toBeUndefined();
    });

    it('keeps the hunter and room selected when durable withdrawal fails', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            username: 'Alice',
            kind: 'join-expedition'
        }, { senderId: 'alice-session', now: 30, presentPlayerIds: ['alice-session'] })).state;
        backend.deliverSnapshot(toPublicRelicSnapshot(game));
        backend.sendRestCommand = async () => {
            throw new Error('Withdrawal outcome unavailable');
        };
        await runtime.getState().leaveRoom();
        expect(runtime.getState().roomId).toBe('room-1');
        expect(runtime.getState().snapshot?.players.map((player) => player.playerId)).toEqual(['alice-session']);
        expect(runtime.getState().error).toContain('Withdrawal outcome unavailable');
        expect(backend.roomState().currentRoomId).toBe('room-1');
    });

    it('fences a delayed command after participation changes even when player status returns', async () => {
        const backend = new RelicRuntimeBackend();
        const runtime = createRuntime(backend);
        await runtime.start();
        const pending = Promise.withResolvers<RelicWsCommandDelivery | undefined>();
        backend.sendWsCommand = () => pending.promise;
        const send = runtime.getState().startExpedition();
        const playerState = backend.roomState();
        const room = playerState.currentRoom;
        if (!room) {
            throw new Error('Expected current room');
        }
        backend.setRooms({ ...playerState, currentRoom: { ...room, members: room.members.map((member) => ({ ...member, role: 'spectator' })) } });
        expect(runtime.getState().participation).toBe('spectator');
        backend.setRooms(playerState);
        pending.resolve(undefined);
        await send;
        expect(backend.commands).toEqual([]);
        expect(runtime.getState().diagnostics.commandInFlight).toBeUndefined();
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

    it('discards an old creation when another account takes over during presence recovery', async () => {
        const backend = new RelicRuntimeBackend();
        backend.rejectPreviousLeave = true;
        const runtime = createRuntime(backend);
        await runtime.start();
        const waiting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const waitForPresence = backend.waitForPresence.bind(backend);
        backend.waitForPresence = async (roomId, options) => {
            const result = await waitForPresence(roomId, options);
            waiting.resolve();
            await release.promise;
            return result;
        };
        const pending = runtime.getState().createRoom('code');
        await waiting.promise;
        backend.signIn({
            clientId: 'client-2',
            accessToken: 'token-2',
            username: 'Bob',
            sessionId: 'bob-session',
            expiresAtEpochMs: 4_000_000_000_000
        });
        await vi.waitFor(() =>
            expect(runtime.getState()).toMatchObject({
                connectionState: 'connected',
                session: { clientId: 'client-2', sessionId: 'bob-session' },
                roomId: undefined,
                snapshot: undefined
            })
        );
        const replacement = runtime.getState();
        release.resolve();
        await expect(pending).resolves.toBeUndefined();
        expect(runtime.getState()).toBe(replacement);
    });

    it.each([false, true])(
        'does not expose an obsolete creation when the account changes before hydration finishes (cleanup failed: %s)',
        async (cleanupFailed) => {
            const backend = new RelicRuntimeBackend();
            backend.rejectPreviousLeave = cleanupFailed;
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
        }
    );
});

function directoryEntry(groupId: string): GroupDirectoryEntry {
    return {
        groupRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId },
        displayName: `Relic Hunters Expedition: ${groupId}`,
        kind: 'room',
        joinMode: 'open',
        memberCount: 1,
        onlineMemberCount: 1,
        playerCount: 1,
        onlinePlayerCount: 1,
        spectatorCount: 0,
        maxSpectators: 16,
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
        completedGameId: null,
        command: 'submit-action',
        text: 'Review the revealed actions before planning the next turn.'
    };
}
