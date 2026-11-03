import { EMPTY_INPUT } from '@ar-eye-hunter/arena-player-state.ts';
import { createTournamentArena } from '@ar-eye-hunter/tournament-arena.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { ArenaTournamentClient } from '../../../apps/ar-eye-hunter-v1/src/game/tournament/arena-tournament-client.ts';

vi.mock('@shared-web/browser/api-client-config.ts', () => ({ readApiBaseUrl: () => 'http://api.test' }));
vi.mock(
    '../../../apps/ar-eye-hunter-v1/src/game/arena-runtime/arena-room-entry.ts',
    () => ({ ARENA_ROOM_SCOPE: { applicationId: 'ar-eye-hunter', workspaceId: 'default' } })
);
const owners: ArenaTournamentClient[] = [];
afterEach(() => {
    owners.splice(0).forEach((owner) => owner.stop());
    vi.unstubAllGlobals();
});

it('resumes native input sequence and sends controls without browser-authored poses or scores', async () => {
    const ref = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'room' };
    const state = createTournamentArena({ gameId: 'room', principalIds: ['alice', 'bob'], seed: 1, startedAtEpochMs: 1000, durationMs: 60000 });
    const snapshot = {
        binding: {
            tournamentRef: { applicationId: ref.applicationId, workspaceId: ref.workspaceId, tournamentId: 'cup' },
            roomRef: ref,
            slot: 'semifinal-1',
            attemptId: 'attempt',
            gameId: 'room',
            rulesId: 'ar-eye-native-60s-v1',
            principalIds: ['alice', 'bob']
        },
        status: 'playing',
        observedAtEpochMs: 1000,
        state: { ...state, players: state.players.map((player) => ({ ...player, input: { ...player.input, sequence: 7 } })) }
    };
    const writes: { url: string; body: string; }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (url, options) => {
            if (options?.method === 'POST') {
                writes.push({ url: String(url), body: String(options.body) });
                return Response.json({ status: 'applied', roomRef: ref, reason: null, simulatedAtEpochMs: 1000, complete: false });
            }
            return Response.json(snapshot);
        })
    );
    let now = 1000;
    const owner = new ArenaTournamentClient({
        auth: {
            session: () => ({
                clientId: 'alice',
                sessionId: 'replacement-session',
                username: 'alice',
                accessToken: 'test-only',
                expiresAtEpochMs: 9999999999999
            }),
            onChange: () => () => {}
        },
        activity: { isActive: () => true, onChange: () => () => {} },
        timers: { ...createDefaultTimers(), nowMs: () => now },
        createId: () => crypto.randomUUID()
    }, 'room');
    owners.push(owner);
    await owner.start();
    expect(owner.getState().error).toBeNull();
    owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: Math.PI * 4 + 0.2, pitch: 0 });
    await vi.waitFor(() => expect(owner.getState().busy).toBe(false));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].body)).toMatchObject({ sequence: 8, pitch: 0, controls: { ...EMPTY_INPUT, fire: true } });
    expect(JSON.parse(writes[0].body)).toHaveProperty('yaw', expect.closeTo(0.2));
    expect(owner.getState().error).toBeNull();
    expect(owner.getState().retryPending).toBe(false);
    // A touch shot queued during the rate limit must keep its aim when the next neutral frame arrives.
    owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 });
    now += 50;
    owner.sendControls({ controls: EMPTY_INPUT, yaw: 0, pitch: 0 });
    await vi.waitFor(() => expect(owner.getState().busy).toBe(false));
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1].body)).toEqual({
        sequence: 9,
        yaw: expect.closeTo(1.2),
        pitch: -0.3,
        controls: { ...EMPTY_INPUT, fire: true }
    });
    snapshot.status = 'cancelled';
    await owner.refresh();
    expect(owner.getState().view?.tournament?.status).toBe('cancelled');
    now += 1000;
    owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 0, pitch: 0 });
    expect(owner.getState().busy).toBe(false);
    expect(writes).toHaveLength(2);
});
