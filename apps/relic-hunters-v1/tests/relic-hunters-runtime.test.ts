import { describe, expect, it, vi } from 'vitest';
import type { RallarRoomState } from '@ar-eye-hunter/shared-web/browser/rallar.ts';
import type { AuthSession } from 'api/api-config.ts';
import { createRelicGame, RELIC_PROTOCOL_VERSION, toPublicRelicSnapshot, } from '@ar-eye-hunter/relic-hunters/mod.ts';
import { RelicHuntersRuntime, type RelicHuntersRuntimeDeps, } from '../src/game/relic-hunters-runtime.ts';

describe('RelicHuntersRuntime', () => {
    it('connects, installs listeners, refreshes rooms, and fetches the current snapshot', async () => {
        const unsubscribeSnapshot = vi.fn();
        const unsubscribeRooms = vi.fn();
        const deps = runtimeDeps({
            onSnapshotMessage: vi.fn(() => unsubscribeSnapshot),
            onRoomsChange: vi.fn(() => unsubscribeRooms),
        });
        const runtime = new RelicHuntersRuntime(deps);

        const hydration = await runtime.connectAndHydrate(vi.fn(), vi.fn());

        expect(deps.connect).toHaveBeenCalledTimes(1);
        expect(deps.onSnapshotMessage).toHaveBeenCalledTimes(1);
        expect(deps.onRoomsChange).toHaveBeenCalledTimes(1);
        expect(deps.refreshRooms).toHaveBeenCalledTimes(1);
        expect(deps.fetchSnapshot).toHaveBeenCalledWith('room-1');
        expect(hydration).toMatchObject({
            session: session(),
            roomState: roomState(),
            snapshotListenerReady: true,
            roomListenerReady: true,
        });

        hydration?.unsubscribe();
        expect(unsubscribeSnapshot).toHaveBeenCalledTimes(1);
        expect(unsubscribeRooms).toHaveBeenCalledTimes(1);
    });

    it('returns degraded hydration when snapshot fetch fails after connect', async () => {
        const deps = runtimeDeps({
            fetchSnapshot: vi.fn(async () => {
                throw new Error('snapshot unavailable');
            }),
        });
        const runtime = new RelicHuntersRuntime(deps);

        const hydration = await runtime.connectAndHydrate(vi.fn(), vi.fn());

        expect(hydration?.degradedError).toBe('snapshot unavailable');
        expect(hydration?.snapshot).toBeUndefined();
        expect(hydration?.snapshotListenerReady).toBe(true);
        expect(hydration?.roomListenerReady).toBe(true);
    });

    it('sends gameplay commands through the configured command transport', async () => {
        const deps = runtimeDeps();
        const runtime = new RelicHuntersRuntime(deps);

        await runtime.sendCommand(session(), 'room-42', { kind: 'start-expedition' });

        expect(deps.sendCommand).toHaveBeenCalledWith('room-42', {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-42',
            username: 'Alice',
            kind: 'start-expedition',
        });
    });

    it('sends force-resolve commands through the configured command transport', async () => {
        const deps = runtimeDeps();
        const runtime = new RelicHuntersRuntime(deps);

        await runtime.sendCommand(session(), 'room-42', { kind: 'force-resolve-round' });

        expect(deps.sendCommand).toHaveBeenCalledWith('room-42', {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-42',
            username: 'Alice',
            kind: 'force-resolve-round',
        });
    });

    it('does not connect or subscribe when no browser session can be restored', async () => {
        const deps = runtimeDeps({
            restoreSession: vi.fn(() => undefined),
        });
        const runtime = new RelicHuntersRuntime(deps);

        const hydration = await runtime.connectAndHydrate(vi.fn(), vi.fn());

        expect(hydration).toBeUndefined();
        expect(deps.connect).not.toHaveBeenCalled();
        expect(deps.onSnapshotMessage).not.toHaveBeenCalled();
        expect(deps.onRoomsChange).not.toHaveBeenCalled();
    });

    it('hydrates the created room with its current snapshot and refreshed room state', async () => {
        const deps = runtimeDeps({
            createRoom: vi.fn(async () => ({ group: { groupId: 'created-room' } })),
        });
        const runtime = new RelicHuntersRuntime(deps);

        const hydration = await runtime.createRoom();

        expect(deps.createRoom).toHaveBeenCalledWith('Relic Hunters Expedition');
        expect(deps.fetchSnapshot).toHaveBeenCalledWith('created-room');
        expect(deps.refreshRooms).toHaveBeenCalledTimes(1);
        expect(hydration).toMatchObject({
            roomId: 'created-room',
            roomState: roomState(),
        });
        expect(hydration.snapshot?.roomId).toBe('room-1');
    });

    it('hydrates a joined room and delegates resets to the game reset transport', async () => {
        const deps = runtimeDeps({
            joinRoom: vi.fn(async () => ({ group: { groupId: 'joined-room' } })),
        });
        const runtime = new RelicHuntersRuntime(deps);

        const hydration = await runtime.joinRoom('joined-room');
        await runtime.resetExpedition('joined-room');

        expect(deps.joinRoom).toHaveBeenCalledWith('joined-room');
        expect(deps.fetchSnapshot).toHaveBeenCalledWith('joined-room');
        expect(hydration.roomId).toBe('joined-room');
        expect(deps.resetGame).toHaveBeenCalledWith('joined-room');
    });
});

function runtimeDeps(
    overrides: Partial<RelicHuntersRuntimeDeps> = {},
): RelicHuntersRuntimeDeps {
    return {
        restoreSession: vi.fn(() => session()),
        login: vi.fn(async () => session()),
        register: vi.fn(async () => session()),
        logout: vi.fn(async () => undefined),
        connect: vi.fn(async () => undefined),
        refreshRooms: vi.fn(async () => roomState()),
        onRoomsChange: vi.fn(() => () => undefined),
        onSnapshotMessage: vi.fn(() => () => undefined),
        createRoom: vi.fn(async () => ({ group: { groupId: 'room-1' } })),
        joinRoom: vi.fn(async () => ({ group: { groupId: 'room-1' } })),
        fetchSnapshot: vi.fn(async () =>
            toPublicRelicSnapshot(createRelicGame('game-1', 'room-1', 1_700_000_000_000))
        ),
        sendCommand: vi.fn(async () =>
            toPublicRelicSnapshot(createRelicGame('game-1', 'room-1', 1_700_000_000_000))
        ),
        resetGame: vi.fn(async () =>
            toPublicRelicSnapshot(createRelicGame('game-1', 'room-1', 1_700_000_000_000))
        ),
        ...overrides,
    };
}

function session(): AuthSession {
    return {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'Alice',
        sessionId: 'alice-session',
        expiresAtEpochMs: 1_700_000_060_000,
    };
}

function roomState(): RallarRoomState {
    return {
        rooms: [],
        currentRoomId: 'room-1',
        members: [],
    };
}
