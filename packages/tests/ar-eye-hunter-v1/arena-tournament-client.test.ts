import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { finishArenaMatchIfDue } from '@ar-eye-hunter/arena-match.ts';
import { EMPTY_INPUT } from '@ar-eye-hunter/arena-player-state.ts';
import type { ArenaTournamentSnapshot } from '@ar-eye-hunter/arena-tournament-snapshot.ts';
import { ARENA_TOURNAMENT_SNAPSHOT_SENDER, ARENA_TOURNAMENT_SNAPSHOT_TOPIC, encodeArenaTournamentFrame } from '@ar-eye-hunter/arena-tournament-stream.ts';
import { createTournamentArena, type TournamentArenaInput } from '@ar-eye-hunter/tournament-arena.ts';
import type { RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';

import { ArenaTournamentClient } from '../../../apps/ar-eye-hunter-v1/src/game/tournament/arena-tournament-client.ts';
import { ViewPushBrowser } from '../shared-web/api/view-push-browser.ts';
import { createManualTimers } from '../shared/resilience/manual-timers.ts';

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

it('resumes native input sequence and sends only controls with the captured shot ray', async () => {
    const test = new TournamentBrowser();
    await test.owner.start();
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: Math.PI * 4 + 0.2, pitch: 0 });
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    expect(test.writes).toHaveLength(1);
    expect(test.writes[0].body).toEqual({ sequence: 8, yaw: expect.closeTo(0.2), pitch: 0, controls: { ...EMPTY_INPUT, fire: true } });
    expect(test.owner.getState()).toMatchObject({ error: null, retryPending: false });
    test.snapshot = { ...test.snapshot, status: 'cancelled' };
    await test.owner.refresh();
    await test.timers.advance(1000);
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 0, pitch: 0 });
    expect(test.owner.getState().busy).toBe(false);
    expect(test.writes).toHaveLength(1);
});

it('dispatches one captured shot after a held input without reading another snapshot', async () => {
    const test = new TournamentBrowser();
    await test.owner.start();
    const post = Promise.withResolvers<Response>();
    test.heldPost = post;
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, moveX: 1 }, yaw: 0, pitch: 0 });
    const shot = { controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 };
    test.owner.sendControls(shot);
    shot.controls.fire = false;
    shot.yaw = 2.5;
    shot.pitch = 0.8;
    await test.timers.advance(50);
    expect(test.writes).toHaveLength(1);
    post.resolve(test.applied());
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    await test.timers.advance(0);
    await vi.waitFor(() => expect(test.writes).toHaveLength(2));
    expect(test.writes[1].body).toEqual({ sequence: 9, yaw: expect.closeTo(1.2), pitch: -0.3, controls: { ...EMPTY_INPUT, fire: true } });
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(2);
    expect(test.reads).toBe(1);
});

it('keeps the newer authorized frame when an older reconnect GET finishes and ignores a different attempt', async () => {
    const test = new TournamentBrowser();
    await test.owner.start();
    const next = { ...test.snapshot, attemptRevision: 3 };
    const held = Promise.withResolvers<Response>();
    test.heldRead = held;
    test.browser.reopen();
    await vi.waitFor(() => expect(test.reads).toBe(2));
    await test.push(next);
    await vi.waitFor(() => expect(test.owner.getState().view?.tournament?.attemptRevision).toBe(3));
    held.resolve(Response.json(test.snapshot));
    await test.push({ ...next, attemptRevision: 4, binding: { ...next.binding, attemptId: 'other' } });
    await test.push({ ...next, status: 'cancelled', attemptRevision: 5 }, 'mallory');
    const terminal = { ...next, status: 'finished' as const, attemptRevision: 6 };
    await test.push(terminal);
    await vi.waitFor(() => expect(test.owner.getState().view?.tournament?.status).toBe('finished'));
    await test.push({ ...next, attemptRevision: 7 });
    await test.timers.advance(1000);
    expect(test.owner.getState().view?.tournament).toEqual(terminal);
    expect(test.reads).toBe(2);
});

it('retains the final revision received before the initial authorized GET without accepting a delayed older frame', async () => {
    const test = new TournamentBrowser();
    const held = Promise.withResolvers<Response>();
    test.heldRead = held;
    const started = test.owner.start();
    const terminal = { ...test.snapshot, attemptRevision: 4, status: 'cancelled' as const };
    await test.push(terminal);
    await test.push({ ...test.snapshot, attemptRevision: 2 });
    expect(test.owner.getState().view).toBeNull();
    held.resolve(Response.json(test.snapshot));
    await started;
    await vi.waitFor(() => expect(test.owner.getState().view?.tournament).toEqual(terminal));
    expect(test.reads).toBe(1);
});

it.each([503, 403])('a newer frame survives an unavailable read, but never an authority refusal (%s)', async (status) => {
    const test = new TournamentBrowser();
    await test.owner.start();
    const held = Promise.withResolvers<Response>();
    test.heldRead = held;
    const reading = test.owner.refresh();
    await vi.waitFor(() => expect(test.reads).toBe(2));
    const terminal = { ...test.snapshot, attemptRevision: 4, status: 'cancelled' as const };
    await test.push(terminal);
    await vi.waitFor(() => expect(test.owner.getState().view?.tournament).toEqual(terminal));
    test.readFailure = status;
    held.resolve(Response.json({ message: 'Read failed' }, { status }));
    await reading;
    expect(test.owner.getState().view?.tournament ?? null).toEqual(status === 503 ? terminal : null);
});

it('defers a reconnect read queued behind hydration while hidden and recovers on foreground return', async () => {
    const test = new TournamentBrowser();
    const held = Promise.withResolvers<Response>();
    test.heldRead = held;
    const start = test.owner.start();
    await vi.waitFor(() => expect(test.reads).toBe(1));
    test.browser.reopen();
    test.active = false;
    test.activity.publishLatest();
    held.resolve(Response.json(test.snapshot));
    await start;
    await test.timers.advance(1000);
    expect(test.reads).toBe(1);
    test.active = true;
    test.activity.publishLatest();
    await vi.waitFor(() => expect(test.reads).toBe(2));
});

it('dispatches spacing-blocked fire at 50ms without a frame and never repeats stale movement', async () => {
    const test = new TournamentBrowser();
    await test.owner.start();
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, moveX: 1 }, yaw: 0, pitch: 0 });
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    await test.timers.advance(10);
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 });
    await test.timers.advance(39);
    expect(test.writes).toHaveLength(1);
    await test.timers.advance(1);
    await vi.waitFor(() => expect(test.writes).toHaveLength(2));
    expect(test.writes[1]).toMatchObject({
        atMs: 1050,
        body: { sequence: 9, yaw: expect.closeTo(1.2), pitch: -0.3, controls: { ...EMPTY_INPUT, fire: true } }
    });
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(2);
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, moveZ: 1 }, yaw: 0.4, pitch: 0 });
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(3);
    expect(test.writes[2].body.controls).toEqual({ ...EMPTY_INPUT, moveZ: 1 });
});

it.each(['busy', 'spacing'] as const)('uses the latest real controls while preserving a %s-queued fire ray', async (blockedBy) => {
    const test = new TournamentBrowser();
    await test.owner.start();
    const post = Promise.withResolvers<Response>();
    if (blockedBy === 'busy') {
        test.heldPost = post;
    }
    test.owner.sendControls({ controls: EMPTY_INPUT, yaw: 0, pitch: 0 });
    if (blockedBy === 'spacing') {
        await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    }
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, moveX: 1, fire: true }, yaw: 1.2, pitch: -0.3 });
    test.owner.sendControls({ controls: EMPTY_INPUT, yaw: 2.5, pitch: 0.8 });
    await test.timers.advance(50);
    if (blockedBy === 'busy') {
        post.resolve(test.applied());
        await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
        await test.timers.advance(0);
    }
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    expect(test.writes).toHaveLength(2);
    expect(test.writes[1].body).toEqual({ sequence: 9, yaw: expect.closeTo(1.2), pitch: -0.3, controls: { ...EMPTY_INPUT, fire: true } });
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(2);
});

it('sends queued fire once when a synchronous busy-clear subscriber supplies newer controls', async () => {
    const test = new TournamentBrowser();
    await test.owner.start();
    let armed = false;
    const unsubscribe = test.owner.onChange((state) => {
        if (armed && !state.busy) {
            armed = false;
            test.owner.sendControls({ controls: { ...EMPTY_INPUT, moveZ: 1 }, yaw: 2.5, pitch: 0.8 });
        }
    });
    const post = Promise.withResolvers<Response>();
    test.heldPost = post;
    test.owner.sendControls({ controls: EMPTY_INPUT, yaw: 0, pitch: 0 });
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 });
    await test.timers.advance(50);
    armed = true;
    post.resolve(test.applied());
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(2);
    expect(test.writes[1].body).toEqual({ sequence: 9, yaw: expect.closeTo(1.2), pitch: -0.3, controls: { ...EMPTY_INPUT, moveZ: 1, fire: true } });
    unsubscribe();
});

it('keeps the queued ray when a frame wins the wakeup race and sends updated movement once', async () => {
    const test = new TournamentBrowser();
    await test.owner.start();
    const post = Promise.withResolvers<Response>();
    test.heldPost = post;
    test.owner.sendControls({ controls: EMPTY_INPUT, yaw: 0, pitch: 0 });
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 });
    await test.timers.advance(50);
    post.resolve(test.applied());
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, moveZ: 1 }, yaw: 2.5, pitch: 0.8 });
    await test.timers.advance(0);
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    expect(test.writes).toHaveLength(2);
    expect(test.writes[1].body).toEqual({ sequence: 9, yaw: expect.closeTo(1.2), pitch: -0.3, controls: { ...EMPTY_INPUT, moveZ: 1, fire: true } });
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(2);
});

it('fences a late mutation from a stopped lifetime after the client restarts', async () => {
    const test = new TournamentBrowser();
    await test.owner.start();
    const post = Promise.withResolvers<Response>();
    test.heldPost = post;
    test.owner.sendControls({ controls: EMPTY_INPUT, yaw: 0, pitch: 0 });
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 });
    test.owner.stop();
    expect(test.timers.pendingCount()).toBe(0);
    await test.owner.start();
    post.resolve(test.applied());
    await test.timers.advance(1000);
    expect(test.owner.getState()).toMatchObject({ busy: false, error: null });
    expect(test.writes).toHaveLength(1);
});

it('discards queued fire when stopped and does not carry it into a restarted client', async () => {
    const test = new TournamentBrowser();
    await test.queueSpacingShot();
    test.owner.stop();
    await test.owner.start();
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(1);
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 0.8, pitch: 0.1 });
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    expect(test.writes).toHaveLength(2);
    expect(test.writes[1].body).toMatchObject({ yaw: expect.closeTo(0.8), pitch: 0.1 });
});

it('keeps a stopped room client from releasing fire after its replacement starts', async () => {
    const old = new TournamentBrowser();
    await old.queueSpacingShot();
    old.owner.stop();
    const replacement = new TournamentBrowser('replacement');
    await replacement.owner.start();
    await old.timers.advance(1000);
    await replacement.timers.advance(1000);
    expect(old.writes).toHaveLength(1);
    expect(replacement.writes).toHaveLength(0);
    replacement.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 0.8, pitch: 0.1 });
    await vi.waitFor(() => expect(replacement.owner.getState().busy).toBe(false));
    expect(replacement.writes).toHaveLength(1);
    expect(replacement.writes[0].url).toContain('/rooms/replacement/tournament/inputs/requests/');
});

it.each([true, false])('fences same-account session replacement with auth notification=%s', async (notify) => {
    const test = new TournamentBrowser();
    await test.queueSpacingShot();
    test.session = { ...test.session, sessionId: 'replacement-session' };
    if (notify) {
        test.auth.publishLatest({ authenticated: true, reason: 'login', session: test.session });
        await test.owner.refresh();
    }
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(1);
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 0.8, pitch: 0.1 });
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    expect(test.writes).toHaveLength(2);
    expect(test.writes[1].body).toMatchObject({ yaw: expect.closeTo(0.8), pitch: 0.1 });
});

it('drops queued fire on inactivity even when the browser resumes before its deadline', async () => {
    const test = new TournamentBrowser();
    await test.queueSpacingShot();
    test.active = false;
    test.activity.publishLatest();
    test.active = true;
    test.activity.publishLatest();
    await test.owner.refresh();
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(1);
});

it.each(['player', 'tournament', 'match'] as const)('drops queued fire when %s authority is lost and restored', async (loss) => {
    const test = new TournamentBrowser();
    await test.queueSpacingShot();
    const original = test.snapshot;
    if (original.state === null) {
        throw new Error('Playing fixture requires an active match');
    }
    if (loss === 'player') {
        test.session = { ...test.session, clientId: 'charlie' };
    }
    else if (loss === 'tournament') {
        test.snapshot = { ...original, status: 'cancelled' };
    }
    else {
        test.snapshot = {
            ...original,
            state: {
                ...original.state,
                simulatedAtEpochMs: original.state.endsAtEpochMs,
                arena: finishArenaMatchIfDue(original.state.arena, original.state.endsAtEpochMs)
            }
        };
    }
    await test.owner.refresh();
    expect(test.owner.getState().error).toBeNull();
    test.session = { ...test.session, clientId: 'alice' };
    test.snapshot = original;
    await test.owner.refresh();
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(1);
});

it.each([403, new Error('Read unavailable')])('drops queued fire when refresh loses its view (%s)', async (failure) => {
    const test = new TournamentBrowser();
    await test.queueSpacingShot();
    test.readFailure = failure;
    await test.owner.refresh();
    expect(test.owner.getState().view).toBeNull();
    test.readFailure = null;
    await test.owner.refresh();
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(1);
});

it('retains the exact uncertain request for explicit retry without autonomous retry or queued fire', async () => {
    const test = new TournamentBrowser();
    await test.owner.start();
    const post = Promise.withResolvers<Response>();
    test.heldPost = post;
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, moveX: 1 }, yaw: 0.4, pitch: 0 });
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 });
    test.postFailure = new Error('Response lost');
    post.reject(test.postFailure);
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    expect(test.owner.getState()).toMatchObject({ retryPending: true, error: 'Response lost' });
    expect(test.writes).toHaveLength(2);
    expect(test.writes[1].url).toBe(test.writes[0].url);
    expect(test.writes[1].body).toEqual(test.writes[0].body);
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(2);
    test.postFailure = null;
    test.owner.sendControls({ controls: EMPTY_INPUT, yaw: 2, pitch: 0.8 });
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    expect(test.owner.getState()).toMatchObject({ retryPending: false, error: null });
    expect(test.writes).toHaveLength(3);
    expect(test.writes[2].url).toBe(test.writes[0].url);
    expect(test.writes[2].body).toEqual(test.writes[0].body);
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(3);
});

it.each([400, 403])('discards queued fire after an HTTP mutation failure even when a later read succeeds (%s)', async (status) => {
    const test = new TournamentBrowser();
    await test.owner.start();
    const post = Promise.withResolvers<Response>();
    test.heldPost = post;
    test.owner.sendControls({ controls: EMPTY_INPUT, yaw: 0, pitch: 0 });
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 });
    test.postFailure = status;
    post.resolve(Response.json({ message: 'Refused' }, { status }));
    await vi.waitFor(() => expect(test.owner.getState().busy).toBe(false));
    expect(test.owner.getState().retryPending).toBe(false);
    expect(test.owner.getState().error).toContain(String(status));
    const attempts = test.writes.length;
    test.postFailure = null;
    await test.owner.refresh();
    expect(test.owner.getState().error).toBeNull();
    await test.timers.advance(1000);
    expect(test.writes).toHaveLength(attempts);
});

it('never sends tournament controls for a casual room', async () => {
    const test = new TournamentBrowser();
    test.casualRoom = true;
    await test.owner.start();
    test.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 });
    await test.timers.advance(1000);
    expect(test.owner.getState().view).toEqual({ tournament: null });
    expect(test.writes).toHaveLength(0);
});

namespace TournamentBrowser {
    export interface Write {
        readonly url: string;
        readonly body: TournamentArenaInput;
        readonly atMs: number;
    }
}
class TournamentBrowser {
    readonly timers = createManualTimers(1000);
    readonly writes: TournamentBrowser.Write[] = [];
    readonly auth = new SynchronousNotifications<RallarAuthState>((error) => {
        throw error;
    });
    readonly activity = new SynchronousNotifications<void>((error) => {
        throw error;
    });
    readonly owner: ArenaTournamentClient;
    readonly browser = new ViewPushBrowser(() => this.session);
    snapshot = createSnapshot();
    session: AuthSession = { clientId: 'alice', sessionId: 'session', username: 'alice', accessToken: 'test-only', expiresAtEpochMs: 9999999999999 };
    active = true;
    reads = 0;
    casualRoom = false;
    postFailure: Error | number | null = null;
    readFailure: Error | number | null = null;
    heldPost: ReturnType<typeof Promise.withResolvers<Response>> | null = null;
    heldRead: ReturnType<typeof Promise.withResolvers<Response>> | null = null;

    constructor(roomId = 'room') {
        this.snapshot = createSnapshot(roomId);
        vi.stubGlobal('fetch', vi.fn<typeof fetch>((url, options) => this.request(String(url), options)));
        this.owner = new ArenaTournamentClient({
            browser: this.browser,
            auth: { session: () => this.session, onChange: (listener) => this.auth.subscribe(listener).unsubscribe },
            activity: { isActive: () => this.active, onChange: (listener) => this.activity.subscribe(listener).unsubscribe },
            timers: this.timers,
            createId: () => crypto.randomUUID()
        }, roomId);
        owners.push(this.owner);
    }

    async push(snapshot: ArenaTournamentSnapshot, sender = ARENA_TOURNAMENT_SNAPSHOT_SENDER): Promise<void> {
        const encoded = await encodeArenaTournamentFrame(snapshot);
        this.browser.deliver(newALBroadcastMessage(
            sender,
            newALRoute(ARENA_TOURNAMENT_SNAPSHOT_TOPIC, snapshot.binding.roomRef.groupId, snapshot.binding.gameId),
            'room',
            ARENA_TOURNAMENT_SNAPSHOT_TOPIC,
            encoded,
            { groupRef: snapshot.binding.roomRef, ttlMs: 2500 }
        ));
    }

    async queueSpacingShot(): Promise<void> {
        await this.owner.start();
        this.owner.sendControls({ controls: EMPTY_INPUT, yaw: 0, pitch: 0 });
        await vi.waitFor(() => expect(this.owner.getState().busy).toBe(false));
        this.owner.sendControls({ controls: { ...EMPTY_INPUT, fire: true }, yaw: 1.2, pitch: -0.3 });
    }

    applied(): Response {
        return Response.json({ status: 'applied', roomRef: this.snapshot.binding.roomRef, reason: null, simulatedAtEpochMs: 1000, complete: false });
    }

    private request(url: string, options: RequestInit | undefined): Promise<Response> {
        if (options?.method === 'POST') {
            this.writes.push({ url, body: JSON.parse(String(options.body)), atMs: this.timers.nowMs() });
            const held = this.heldPost;
            this.heldPost = null;
            return held?.promise ?? this.respond(this.postFailure, this.applied());
        }
        this.reads++;
        const held = this.heldRead;
        this.heldRead = null;
        return held?.promise ?? this.respond(this.readFailure, Response.json(this.casualRoom ? null : this.snapshot));
    }

    private respond(failure: Error | number | null, response: Response): Promise<Response> {
        if (failure instanceof Error) {
            return Promise.reject(failure);
        }
        return Promise.resolve(failure === null ? response : Response.json({ message: 'Refused' }, { status: failure }));
    }
}

function createSnapshot(roomId = 'room'): ArenaTournamentSnapshot {
    const roomRef = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: roomId };
    const state = createTournamentArena({ gameId: roomId, principalIds: ['alice', 'bob'], seed: 1, startedAtEpochMs: 1000, durationMs: 60000 });
    return {
        binding: {
            tournamentRef: { applicationId: roomRef.applicationId, workspaceId: roomRef.workspaceId, tournamentId: 'cup' },
            roomRef,
            slot: 'semifinal-1',
            attemptId: 'attempt',
            gameId: roomId,
            rulesId: 'ar-eye-native-60s-v1',
            principalIds: ['alice', 'bob']
        },
        status: 'playing',
        attemptRevision: 1,
        observedAtEpochMs: 1000,
        state: { ...state, players: state.players.map((player) => ({ ...player, input: { ...player.input, sequence: 7 } })) }
    };
}
