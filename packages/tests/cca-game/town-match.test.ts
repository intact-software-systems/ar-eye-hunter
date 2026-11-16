import { describe, expect, it } from 'vitest';

import { computeTownMatchInput } from '../../../apps/cca-2d/src/match/match-input.ts';
import {
    computeTownMatchReady,
    computeTownMatchRecovery,
    computeTownMatchRematch,
    computeTownMatchRoster,
    computeTownMatchStart,
    computeTownMatchTick,
    createTownMatch,
    type TownMatchState
} from '../../../apps/cca-2d/src/match/town-match.ts';
import { TownRoutes } from '../../../apps/cca-2d/src/town/routes.ts';

const members = [
    { id: 'alice', sessionId: 'alice-session', displayName: 'Alice' },
    { id: 'bob', sessionId: 'bob-session', displayName: 'Bob' }
];

function readyMatch(): TownMatchState {
    const created = createTownMatch('match-one', members);
    expect(created.left).toBeUndefined();
    let state = created.right!;
    for (const member of members) {
        state = computeTownMatchReady(state, { ...member, ready: true });
    }
    return computeTownMatchStart(state);
}

function playingMatch(): TownMatchState {
    let state = readyMatch();
    const routes = new TownRoutes();
    for (let tick = 0; tick < 90; tick++) {
        state = computeTownMatchTick({ state, routes, inputs: [], now: tick * 1000 / 30 });
    }
    return state;
}

describe('Grumpy Town match rules', () => {
    it('recovers surviving controllers while retaining departed scores and excluding absent actors', () => {
        const original = createTownMatch('recovering', [...members, { id: 'carol', sessionId: 'carol-session', displayName: 'Carol' }]).right!;
        const state: TownMatchState = {
            ...original,
            phase: 'playing',
            tick: 5399,
            remainingTicks: 1,
            players: original.players.map((player) => ({ ...player, score: 120, vx: 4, rescueTarget: 'bob', rescueProgress: 0.5 }))
        };
        const recovered = computeTownMatchRecovery(state, original.members.slice(1)).right!;
        expect(recovered.phase).toBe('playing');
        expect(recovered.matchId).toBe('recovering');
        expect(recovered.players[0].score).toBe(120);
        expect(recovered.players[0].vx).toBe(0);
        expect(recovered.players.every((player) => player.rescueTarget === undefined && player.rescueProgress === 0)).toBe(true);
        const finished = computeTownMatchTick({ state: recovered, routes: new TownRoutes(), inputs: [], now: 0 });
        expect(finished.phase).toBe('finished');
        expect(finished.players[0]).toEqual(recovered.players[0]);
        expect(finished.results.map((result) => result.displayName)).toEqual(['Alice', 'Bob', 'Carol']);
        expect(finished.results.map((result) => result.score)).toEqual([120, 120, 120]);
        expect(computeTownMatchRecovery(state, [members[1]]).left).toBeDefined();
        expect(computeTownMatchRecovery(state, [members[1], { id: 'outsider', sessionId: 'outsider', displayName: 'Outsider' }]).left).toBeDefined();
    });

    it('requires two to four distinct ready members and counts down without advancing the town', () => {
        expect(createTownMatch('invalid', [members[0], members[0]]).left).toBeDefined();
        expect(
            createTownMatch(
                'crowded',
                Array.from({ length: 5 }, (_, index) => ({
                    id: String(index),
                    sessionId: String(index),
                    displayName: String(index)
                }))
            ).left
        ).toBeDefined();
        const lone = createTownMatch('lone', [members[0]]).right!;
        expect(computeTownMatchStart(computeTownMatchReady(lone, { ...members[0], ready: true })).phase).toBe('lobby');
        const lobby = createTownMatch('match-one', members).right!;
        const forged = computeTownMatchReady(lobby, { ...members[0], sessionId: 'wrong-session', ready: true });
        expect(forged.members[0].ready).toBe(false);
        expect(computeTownMatchStart(lobby).phase).toBe('lobby');
        const countdown = readyMatch();
        expect(countdown.phase).toBe('countdown');
        expect(countdown.countdownTicks).toBe(90);
        const playing = playingMatch();
        expect(playing.phase).toBe('playing');
        expect(playing.tick).toBe(0);
        expect(playing.remainingTicks).toBe(180 * 30);
        expect(playing.town).toEqual(countdown.town);
        expect(playing.town.companion).toBeUndefined();
    });

    it('validates session, sequence and input bounds, moves players independently and expires held input', () => {
        const state = playingMatch();
        const input = { state, previous: undefined, playerId: 'alice', sessionId: 'alice-session', sequence: 1, controls: { x: 1, z: 0, dash: 1 }, now: 1000 };
        const accepted = computeTownMatchInput(input);
        expect(accepted.left).toBeUndefined();
        expect(computeTownMatchInput({ ...input, sessionId: 'bob-session' }).left).toBeDefined();
        expect(computeTownMatchInput({ ...input, previous: accepted.right }).left).toBeDefined();
        expect(computeTownMatchInput({ ...input, controls: { x: Infinity, z: 0, dash: 1 } }).left).toBeDefined();
        expect(computeTownMatchInput({ ...input, controls: { x: 2, z: 0, dash: 1 } }).left).toBeDefined();
        const routes = new TownRoutes();
        const moved = computeTownMatchTick({ state, routes, inputs: [accepted.right!], now: 1001 });
        expect(moved.players[0].x).toBeGreaterThan(state.players[0].x);
        expect(moved.players[1].x).toBe(state.players[1].x);
        expect(moved.players[0].pranks).toBe(1);
        const repeated = computeTownMatchTick({ state: moved, routes, inputs: [accepted.right!], now: 1034 });
        expect(repeated.players[0].pranks).toBe(1);
        const stale = computeTownMatchTick({ state, routes, inputs: [accepted.right!], now: 1251 });
        expect(stale.players[0].x).toBe(state.players[0].x);
        expect(stale.players[0].pranks).toBe(0);
        expect(state.tick).toBe(0);
        expect(moved.tick).toBe(1);
        expect(moved.remainingTicks).toBe(5399);
    });

    it('ends on the final tick with several qualifiers and rematches under a new identity', () => {
        const playing = playingMatch();
        let state: TownMatchState = { ...playing, players: playing.players.map((player) => ({ ...player, score: 100 })) };
        const routes = new TownRoutes();
        for (let tick = 0; tick < 5399; tick++) {
            state = computeTownMatchTick({ state, routes, inputs: [], now: 1000 + tick * 1000 / 30 });
        }
        expect(state.phase).toBe('playing');
        expect(state.remainingTicks).toBe(1);
        const finished = computeTownMatchTick({ state, routes, inputs: [], now: 181000 });
        expect(finished.tick).toBe(5400);
        expect(finished.remainingTicks).toBe(0);
        expect(finished.phase).toBe('finished');
        expect(finished.results.map((result) => result.qualified)).toEqual([true, true]);
        expect(computeTownMatchTick({ state: finished, routes: new TownRoutes(), inputs: [], now: 2000 })).toBe(finished);
        expect(computeTownMatchRematch(finished, finished.matchId).left).toBeDefined();
        const rematch = computeTownMatchRematch(finished, 'match-two').right!;
        expect(rematch.phase).toBe('lobby');
        expect(rematch.members.every((member) => !member.ready)).toBe(true);
        expect(rematch.players.every((player) => player.score === 0)).toBe(true);
        expect(rematch.results).toHaveLength(0);
        expect(rematch.matchId).toBe('match-two');
    });

    it('resets readiness for a new session and interrupts an active round on a membership change', () => {
        const ready = readyMatch();
        const changed = computeTownMatchRoster(ready, [members[0]]).right!;
        expect(changed.phase).toBe('interrupted');
        expect(changed.interruption).toBeTruthy();
        expect(changed.players).toEqual(ready.players);
        const lobby = createTownMatch('match-two', members).right!;
        const marked = computeTownMatchReady(lobby, { ...members[0], ready: true });
        const reconnected = computeTownMatchRoster(marked, [{ ...members[0], sessionId: 'new-session' }, members[1]]).right!;
        expect(reconnected.members[0].ready).toBe(false);
        expect(reconnected.members[0].sessionId).toBe('new-session');
    });

    it('interrupts countdown and play when the room becomes empty, preserving the last world', () => {
        for (const state of [readyMatch(), playingMatch()]) {
            const empty = computeTownMatchRoster(state, []);
            expect(empty.left).toBeUndefined();
            expect(empty.right?.phase).toBe('interrupted');
            expect(empty.right?.town).toBe(state.town);
            expect(computeTownMatchTick({ state: empty.right!, routes: new TownRoutes(), inputs: [], now: 2000 }))
                .toBe(empty.right);
            expect(computeTownMatchRematch(empty.right!, 'new-match').left).toBeDefined();
        }
        expect(createTownMatch('empty', []).left).toBeDefined();
    });
});
