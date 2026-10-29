import { describe, expect, it } from 'vitest';
import { finishArenaMatchIfDue, startArenaMatch } from '../../../apps/ar-eye-hunter-v1/src/game/arena-match.ts';
import { createInitialVitalsState } from '../../../apps/ar-eye-hunter-v1/src/game/arena-player-state.ts';
import { applyArenaRematchCommand, createArenaRematch } from '../../../apps/ar-eye-hunter-v1/src/game/arena-rematch.ts';
import { createInitialLoadoutState } from '../../../apps/ar-eye-hunter-v1/src/game/arena-weapons.ts';
import {
    createInitialArenaState,
    upsertPlayerPose
} from '../../../apps/ar-eye-hunter-v1/src/game/simulation.ts';

function completedMatch() {
    let state = createInitialArenaState(12, 1_000);
    for (const sessionId of ['alice', 'bob']) {
        state = upsertPlayerPose(state, {
            sessionId,
            username: sessionId,
            color: '#ffffff',
            position: [0, 1.72, 0],
            rotation: [0, 0, 0],
            vitals: createInitialVitalsState(),
            loadout: createInitialLoadoutState(),
            score: 20,
            seq: 1,
            sentAtEpochMs: 1_000
        }, 1_000);
    }
    const started = startArenaMatch(state, { matchId: 'first', directorSessionId: 'alice', durationMs: 60_000, sentAtEpochMs: 1_000 }, 1_000);
    return finishArenaMatchIfDue(started.state, 61_001);
}
const authority = {
    nowEpochMs: 62_000,
    leaderSessionId: 'alice',
    participants: ['alice', 'bob', 'visitor'].map((sessionId) => ({ sessionId, participationKey: `${sessionId}-member` }))
};
const identity = { completedGameId: 'first', settingsKey: 'duration:60000:0' };
const aliceReady = { ...identity, kind: 'ready' as const, sessionId: 'alice', ready: true, participationKey: 'alice-member' };
const bobReady = { ...aliceReady, sessionId: 'bob', participationKey: 'bob-member' };
const start = { ...identity, kind: 'start' as const, sessionId: 'alice' };

function confirmedMatch() {
    const alice = applyArenaRematchCommand(completedMatch(), aliceReady, authority).right!;
    return applyArenaRematchCommand(alice.state, bobReady, authority).right!.state;
}

describe('AR Eye play again together', () => {
    it('preserves results during preparation, requires both players and explicit director start', () => {
        const completed = completedMatch();
        expect(createArenaRematch(completed.match!).right?.preparation.players.every((player) => !player.ready)).toBe(true);
        const alice = applyArenaRematchCommand(completed, aliceReady, authority).right!;
        expect(alice.state.match?.results).toEqual(completed.match?.results);
        expect(applyArenaRematchCommand(alice.state, start, authority).left?.code).toBe('players-not-ready');
        const prepared = confirmedMatch();
        expect(prepared.match?.status).toBe('complete');
        expect(applyArenaRematchCommand(prepared, { ...start, sessionId: 'bob' }, authority).left?.code).toBe('leader-required');
        const next = applyArenaRematchCommand(prepared, start, authority).right!;
        expect(next.state.match?.status).toBe('active');
        expect(next.state.match?.matchId).not.toBe('first');
        expect(Object.keys(next.state.match!.baseline)).toEqual(['alice', 'bob']);
        expect(next.state.match?.rematch).toBeUndefined();
        expect(applyArenaRematchCommand(next.state, start, authority).left?.code).toBe('stale-preparation');
    });

    it('keeps first-match open enrollment when player poses arrive after a paused renderer starts it', () => {
        const empty = createInitialArenaState(12, 1_000);
        const started = startArenaMatch(empty, { matchId: 'first', directorSessionId: 'alice', durationMs: 60_000, sentAtEpochMs: 1_000 }, 1_000);
        const completed = finishArenaMatchIfDue({ ...started.state, players: completedMatch().players }, 61_001);
        expect(completed.match?.results?.map((entry) => entry.sessionId)).toEqual(['alice', 'bob']);
        expect(createArenaRematch(completed.match!).right?.preparation.players.map((entry) => entry.sessionId)).toEqual(['alice', 'bob']);
    });

    it('cancels readiness, invalidates settings changes, and restores preparation on a new director', () => {
        const prepared = confirmedMatch();
        const cancelled = applyArenaRematchCommand(prepared, { ...bobReady, ready: false }, authority).right!.state;
        expect(applyArenaRematchCommand(cancelled, start, authority).left?.code).toBe('players-not-ready');
        const changed = applyArenaRematchCommand(prepared, { ...start, kind: 'settings', durationMs: 180_000 }, authority).right!.state;
        expect(changed.match?.rematch?.preparation.players.every((player) => !player.ready)).toBe(true);
        expect(applyArenaRematchCommand(changed, aliceReady, authority).left?.code).toBe('stale-preparation');
        const next = applyArenaRematchCommand(prepared, { ...start, sessionId: 'bob' }, { ...authority, leaderSessionId: 'bob' }).right!;
        expect(next.state.match?.directorSessionId).toBe('bob');
    });

    it('excludes departed players and refuses watchers or stale membership consent', () => {
        const prepared = confirmedMatch();
        const solo = applyArenaRematchCommand(prepared, start, {
            ...authority,
            participants: authority.participants.filter((entry) => entry.sessionId !== 'bob')
        }).right!;
        expect(Object.keys(solo.state.match!.baseline)).toEqual(['alice']);
        const ended = finishArenaMatchIfDue(solo.state, 123_000);
        expect(ended.match?.results?.map((player) => player.sessionId)).toEqual(['alice']);
        expect(applyArenaRematchCommand(prepared, { ...bobReady, sessionId: 'watcher' }, authority).left?.code).toBe('player-required');
        expect(applyArenaRematchCommand(prepared, { ...bobReady, participationKey: 'obsolete' }, authority).left?.code).toBe('stale-participation');
    });
});
