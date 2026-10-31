import { onTestFinished } from 'vitest';

import {
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot,
    type RelicCommand,
    type RelicHunterEvent,
    type RelicPublicSnapshot,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import { waitForSettledRead } from '@shared-web/browser/connection/wait-for-settled-read.ts';
import { createRallarDataFacade, type RallarDataFacade } from '@shared-web/browser/rallar-data.ts';
import type {
    RallarAuthChangeListener,
    RallarRoomPresenceWaitOptions,
    RallarRoomPresenceWaitResult,
    RallarRoomState,
    RallarStartOptions
} from '@shared-web/browser/rallar.ts';
import { RallarRoomDirectory } from '@shared-web/browser/rooms/directory/rallar-room-directory.ts';
import { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarRoomMove } from '@shared-web/browser/rooms/move/rallar-room-move.ts';
import { RallarRecentRooms } from '@shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    GroupDirectoryPage,
    GroupDirectoryRequest
} from '@shared/api/group-directory/group-directory-types.ts';
import type { GroupJoinMode, GroupSnapshot } from '@shared/api/group-types.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { BoundedConcurrencyAdmission } from '@shared/resilience/bounded-concurrency-admission.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';

import '../../../packages/tests/setup-browser-indexeddb.ts';
import { createGroupSnapshotFixture } from '../../../packages/tests/shared-web/authoritative-group-fixtures.ts';
import { createManualTimers } from '../../../packages/tests/shared/resilience/manual-timers.ts';
import type { RelicCommandRequest } from '../src/game/api.ts';
import { RelicHuntersRuntime } from '../src/game/relic-hunters-runtime.ts';
import type { RelicWsCommandDelivery } from '../src/game/send-relic-ws-command.ts';
import type { RelicHunterEventSubscription } from '../src/game/subscribe-relic-hunter-events.ts';

export function createRuntime(backend: RelicRuntimeBackend): RelicHuntersRuntime {
    const runtime = new RelicHuntersRuntime(backend);
    onTestFinished(async () => {
        runtime.stop();
        await backend.recentRooms.whenIdle();
    });
    return runtime;
}

interface DeliveredCommand {
    readonly transport: 'ws' | 'rest';
    readonly roomId: string;
    readonly command: RelicCommand;
}

/** In-process external ports expose membership, delivered commands and snapshots, without replacing runtime decisions. */
export class RelicRuntimeBackend implements RelicHuntersRuntime.Dependencies {
    private readonly participationLock = new BoundedConcurrencyAdmission({ maxConcurrent: 1 });
    public withParticipationLock<T>(_roomId: string, _sessionId: string, run: () => Promise<T>): Promise<T> {
        return this.participationLock.admit(run);
    }
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
    private readonly snapshots = new Map<string, RelicPublicSnapshot>();
    public wsDelivery: RelicWsCommandDelivery | undefined;
    public rejectPreviousLeave = false;
    private state = stateFor('room-1');
    private readonly authListeners = new Set<RallarAuthChangeListener>();
    private readonly roomListeners = new Set<(state: RallarRoomState) => void>();
    private readonly hunterListeners = new Set<RelicHunterEventSubscription>();
    private readonly snapshotListeners = new Set<(event: RelicServerEvent) => void>();
    public readonly roomMove = new RallarRoomMove({
        auth: { session: () => this.session, onChange: (listener) => this.onAuthChange(listener) },
        currentRoom: () => this.state.currentRoomRef,
        refreshRooms: async () => {},
        activate: async () => {
            throw new Error('Move activation is not configured in this runtime fixture');
        },
        api: {
            list: async () => [],
            mutate: async () => {
                throw new Error('Move mutation is not configured in this runtime fixture');
            }
        },
        onChanged: () => () => {},
        withEligibility: async (_destination, run) => await run(),
        timers: this.timers
    }, { scope: { applicationId: 'rallar-server', workspaceId: 'default' }, refreshIntervalMs: 15000 });
    public readonly roomEntry: RallarRoomEntry;
    public readonly recentRooms: RallarRecentRooms;
    public readonly directory: RallarRoomDirectory;
    public readonly data: Pick<RallarDataFacade, 'open'>;

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
            rooms: {
                onChange: (listener) => this.onRoomsChange(listener),
                join: async (ref) => this.admit(ref.groupId)
            },
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
        this.data = { open: (input, options) => data.open(input, { ...options, dbName, sync: false }) };
        this.recentRooms = new RallarRecentRooms({
            auth: { session: () => this.session, onChange: (listener) => this.onAuthChange(listener) },
            entry: this.roomEntry,
            data: { open: (input, options) => data.open(input, { ...options, dbName, sync: false }) },
            now: () => this.timers.nowMs()
        }, { scope: { applicationId: 'rallar-server', workspaceId: 'default' } });
    }

    public get authSubscriptionCount(): number {
        return this.authListeners.size;
    }

    public restoreSession() {
        return this.session;
    }
    public async start(_options?: RallarStartOptions) {
        return { session: this.session, connected: !!this.session, roomState: this.state };
    }
    public subscriptions() {
        return new SubscriptionScope();
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
    public async waitForPresence(
        roomId: string,
        options: RallarRoomPresenceWaitOptions
    ): Promise<RallarRoomPresenceWaitResult> {
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
    public async initializeGame(roomId: string) {
        return this.snapshots.get(roomId) ?? relicSnapshot(roomId, 20);
    }
    public async leaveRoom(_roomId: string) {
        this.setRooms({ rooms: [], members: [] });
    }
    public async resetGame(roomId: string) {
        return relicSnapshot(roomId, 30);
    }

    public createRoomNameSeed(): string {
        return 'controlled-room-name-seed';
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
        return this.snapshots.get(roomId) ?? relicSnapshot(roomId, 20);
    };

    public async sendWsCommand(roomId: string, command: RelicCommand): Promise<RelicWsCommandDelivery | undefined> {
        if (this.wsDelivery) {
            this.commands.push({ transport: 'ws', roomId, command });
        }
        return this.wsDelivery;
    }

    public async sendRestCommand({ gameId: roomId, command }: RelicCommandRequest): Promise<RelicPublicSnapshot> {
        this.commands.push({ transport: 'rest', roomId, command });
        return relicSnapshot(roomId, 25);
    }

    public deliverSnapshot(snapshot: RelicPublicSnapshot): void {
        this.snapshots.set(snapshot.roomId, snapshot);
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

export function stateFor(roomId: string): RallarRoomState {
    const ref = { applicationId: 'rallar-server', workspaceId: 'default', groupId: roomId };
    const fixture = createGroupSnapshotFixture({ ...ref, sessionIds: ['client-1'] });
    const currentRoom = {
        ...fixture,
        activeSessions: fixture.activeSessions.map((entry) => ({ ...entry, sessionId: 'alice-session' }))
    };
    return {
        rooms: [],
        currentRoomId: roomId,
        currentRoomRef: ref,
        currentRoom,
        members: [{
            principalId: 'client-1',
            username: 'Alice',
            role: 'owner',
            status: 'active',
            isOwner: true,
            isOnline: true,
            sessionIds: ['alice-session']
        }]
    };
}

export function relicSnapshot(roomId: string, atEpochMs: number): RelicPublicSnapshot {
    return toPublicRelicSnapshot(createRelicGame(roomId, roomId, atEpochMs));
}
