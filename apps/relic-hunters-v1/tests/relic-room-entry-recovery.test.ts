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
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';

import { requireRelicCommandApplied } from '../../../packages/tests/relic-hunters/require-relic-command-applied.ts';
import {
    createRuntime,
    RelicRuntimeBackend,
    relicSnapshot
} from './relic-runtime-backend.ts';

describe('Relic recent-room recovery', () => {
    it('keeps a recent-room return pending until restored participation is known', async () => {
        const backend = new RelicRuntimeBackend();
        const hydration = deferRelicSnapshot(backend);
        const runtime = createRuntime(backend);
        const startup = runtime.start();
        await hydration.started;
        backend.roomEntry.returnTo({ applicationId: 'rallar-server', workspaceId: 'default', groupId: 'recent-room' }, 'client-1');
        expect(backend.roomEntry.getState()).toMatchObject({
            status: 'pending',
            destination: { roomRef: { groupId: 'recent-room' } }
        });
        expect(runtime.getState().roomId).toBe('room-1');
        expect(runtime.getState().error).toBeUndefined();
        hydration.snapshot.resolve(relicSnapshot('room-1', 20));
        await startup;
        await vi.waitFor(() => expect(runtime.getState().roomId).toBe('recent-room'));
        expect(backend.roomEntry.getState().status).toBe('entered');
        expect(backend.commands).toEqual([]);
    });

    it.each(['cancel', 'sign-out', 'account-replacement', 'replacement'])('fences delayed return after %s while checking participation', async (action) => {
        const backend = new RelicRuntimeBackend();
        const hydration = deferRelicSnapshot(backend);
        const runtime = createRuntime(backend);
        const startup = runtime.start();
        await hydration.started;
        backend.roomEntry.returnTo({ applicationId: 'rallar-server', workspaceId: 'default', groupId: 'old-destination' }, 'client-1');
        if (action === 'cancel') {
            backend.roomEntry.cancel();
        }
        else if (action === 'sign-out') {
            backend.signOut();
        }
        else if (action === 'account-replacement') {
            backend.signIn({
                clientId: 'client-2',
                sessionId: 'bob-session',
                username: 'Bob',
                accessToken: 'token-2',
                expiresAtEpochMs: 4_000_000_000_000
            });
        }
        else {
            backend.roomEntry.enter({
                roomRef: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'new-invitation' },
                joinCode: 'fresh-code',
                participation: 'preserve'
            });
        }
        hydration.snapshot.resolve(relicSnapshot('room-1', 20));
        await startup;
        if (action === 'replacement') {
            await vi.waitFor(() => expect(runtime.getState().roomId).toBe('new-invitation'));
        }
        else if (action === 'account-replacement') {
            await vi.waitFor(() => expect(backend.roomEntry.getState().failure?.kind).toBe('account-mismatch'));
            expect(runtime.getState().session?.clientId).toBe('client-2');
        }
        else {
            expect(runtime.getState().roomId).toBe(action === 'cancel' ? 'room-1' : undefined);
        }
        expect(backend.roomState().currentRoomId).not.toBe('old-destination');
        expect(backend.commands).toEqual([]);
    });

    it('refuses a pending return when hydration reveals an unfinished hunter', async () => {
        const backend = new RelicRuntimeBackend();
        const hydration = deferRelicSnapshot(backend);
        const runtime = createRuntime(backend);
        const startup = runtime.start();
        await hydration.started;
        backend.roomEntry.returnTo({ applicationId: 'rallar-server', workspaceId: 'default', groupId: 'recent-room' }, 'client-1');
        const game = requireRelicCommandApplied(applyRelicCommand(createRelicGame('room-1', 'room-1', 1), {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: 'room-1',
            username: 'Alice',
            kind: 'join-expedition'
        }, { senderId: 'alice-session', now: 30, presentPlayerIds: ['alice-session'] })).state;
        hydration.snapshot.resolve(toPublicRelicSnapshot(game));
        await startup;
        expect(backend.roomState().currentRoomId).toBe('room-1');
        expect(backend.roomEntry.getState().status).toBe('idle');
        expect(runtime.getState().error).toContain('Leave expedition');
        expect(runtime.getState().snapshot?.players.map((player) => player.playerId)).toEqual(['alice-session']);
        expect(backend.commands).toEqual([]);
    });

    it('retains a return after hydration failure and resumes it after explicit refresh', async () => {
        const backend = new RelicRuntimeBackend();
        const fetchSnapshot = backend.fetchSnapshot;
        const hydration = deferRelicSnapshot(backend);
        const runtime = createRuntime(backend);
        const startup = runtime.start();
        await hydration.started;
        backend.roomEntry.returnTo({ applicationId: 'rallar-server', workspaceId: 'default', groupId: 'recent-room' }, 'client-1');
        hydration.snapshot.reject(new Error('Expedition state unavailable'));
        await startup;
        expect(backend.roomEntry.getState().status).toBe('pending');
        expect(runtime.getState().error).toBe('Expedition state unavailable');
        backend.fetchSnapshot = fetchSnapshot;
        const refreshRooms = backend.refreshRooms.bind(backend);
        backend.refreshRooms = async () => {
            throw new Error('Membership refresh unavailable');
        };
        await runtime.getState().refreshRooms();
        expect(backend.roomEntry.getState().status).toBe('pending');
        expect(runtime.getState().error).toBe('Membership refresh unavailable');
        backend.refreshRooms = refreshRooms;
        await runtime.getState().refreshRooms();
        await vi.waitFor(() => expect(runtime.getState().roomId).toBe('recent-room'));
        expect(backend.roomEntry.getState().status).toBe('entered');
    });
});

interface DeferredRelicSnapshot {
    readonly started: Promise<void>;
    readonly snapshot: PromiseWithResolvers<RelicPublicSnapshot>;
}

function deferRelicSnapshot(backend: RelicRuntimeBackend): DeferredRelicSnapshot {
    const started = Promise.withResolvers<void>();
    const snapshot = Promise.withResolvers<RelicPublicSnapshot>();
    const fetchSnapshot = backend.fetchSnapshot;
    backend.fetchSnapshot = async (roomId) => {
        if (roomId === 'room-1') {
            started.resolve();
            return await snapshot.promise;
        }
        return await fetchSnapshot(roomId);
    };
    return { started: started.promise, snapshot };
}
