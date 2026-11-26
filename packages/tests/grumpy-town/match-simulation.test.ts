import {
    describe,
    expect,
    it
} from 'vitest';

import {
    TOWN_MATCH_BUILD,
    TOWN_MATCH_PROTOCOL,
    type TownMatchAction,
    type TownMatchFrame
} from '../../../apps/grumpy-town/src/match/match-protocol.ts';
import { TownMatchSimulation } from '../../../apps/grumpy-town/src/match/town-match-simulation.ts';
import {
    computeTownMatchReady,
    computeTownMatchStart,
    createTownMatch
} from '../../../apps/grumpy-town/src/match/town-match.ts';
import { seatDeadlineClock } from './seat-deadline-clock.ts';

const members = [
    { id: 'alice', sessionId: 'alice-session', displayName: 'Alice' },
    { id: 'bob', sessionId: 'bob-session', displayName: 'Bob' }
];

function createCountdown(): TownMatchSimulation {
    let state = createTownMatch('round', members).right!;
    for (const member of members) {
        state = computeTownMatchReady(state, { ...member, ready: true });
    }
    return new TownMatchSimulation(computeTownMatchStart(state), 0);
}

function createFrame(sequence: number, action: TownMatchAction): TownMatchFrame {
    return {
        protocol: TOWN_MATCH_PROTOCOL,
        build: TOWN_MATCH_BUILD,
        roomRef: { applicationId: 'grumpy-town', workspaceId: 'default', groupId: 'town' },
        epoch: 1,
        matchId: 'round',
        sequence,
        action
    };
}

describe('director clock and control admission', () => {
    it('accepts each authenticated ready name for its own seat and retains names after starting', () => {
        const original = createTownMatch('round', members.map((member) => ({ ...member, displayName: member.id })))
            .right!;
        const simulation = new TownMatchSimulation(original, 0);
        simulation.accept(createFrame(1, { kind: 'ready', ready: true, displayName: 'Alice' }), 'alice-session', 0);
        simulation.accept(createFrame(1, { kind: 'ready', ready: true, displayName: 'Bob' }), 'bob-session', 0);
        const named = simulation.getState();
        expect(named.participants.map((participant) => participant.displayName)).toEqual(['Alice', 'Bob']);
        expect(named.members.every((member) => member.ready)).toBe(true);
        expect(named.seats).toEqual(original.seats);
        expect(named.players).toEqual(original.players);
        simulation.accept(createFrame(2, { kind: 'ready', ready: true, displayName: 'Intruder' }), 'other-session', 0);
        expect(simulation.getState().participants[0].displayName).toBe('Alice');
        simulation.accept(createFrame(2, { kind: 'start' }), 'alice-session', 0);
        simulation.accept(createFrame(3, { kind: 'ready', ready: true, displayName: 'Changed during play' }), 'bob-session', 0);
        expect(simulation.getState().participants).toEqual(named.participants);
        simulation.stop();
    });

    it('keeps fractional time and advances a three-second countdown while confirmations arrive at 10 Hz', () => {
        const simulation = createCountdown();
        let committed = simulation.getState();
        for (let now = 16; now <= 3008; now += 16) {
            simulation.advance(now, committed, seatDeadlineClock(now));
            if (now % 112 === 0) {
                committed = simulation.getState();
            }
        }
        expect(simulation.getState().phase).toBe('playing');
        expect(simulation.getState().countdownTicks).toBe(0);
        expect(simulation.getState().tick).toBe(0);
        simulation.stop();
    });

    it('advances at round time when confirmations arrive on delayed host pumps', () => {
        const simulation = createCountdown();
        for (let now = 251; now <= 6001; now += 250) {
            simulation.advance(now, simulation.getState(), seatDeadlineClock(now));
        }
        expect(simulation.getState().tick).toBe(90);
        simulation.stop();
    });

    it('limits a long wake even without a checkpoint and keeps the bounded WAN agreement lead', () => {
        const countdown = createCountdown().getState();
        const simulation = new TownMatchSimulation({ ...countdown, phase: 'playing', countdownTicks: 0 }, 0);
        const start = simulation.getState();
        simulation.advance(1950, start, seatDeadlineClock(1950));
        simulation.advance(60000, start, seatDeadlineClock(60000));
        expect(simulation.getState().tick).toBe(135);
        simulation.advance(60001, undefined, seatDeadlineClock(60001));
        expect(simulation.getState().tick).toBe(135);
        simulation.advance(120000, undefined, seatDeadlineClock(120000));
        expect(simulation.getState().tick).toBe(270);
        simulation.stop();
    });

    it('caps unconfirmed progress and expires movement even if a duplicate input is redelivered', () => {
        const countdown = createCountdown().getState();
        const simulation = new TownMatchSimulation({ ...countdown, phase: 'playing', countdownTicks: 0 }, 0);
        const committed = simulation.getState();
        const movement = createFrame(1, { kind: 'controls', x: 1, z: 0, dash: 0 });
        simulation.accept(movement, 'bob-session', 0);
        for (let now = 16; now <= 5000; now += 16) {
            simulation.accept(movement, 'bob-session', now);
            simulation.advance(now, committed, seatDeadlineClock(now));
        }
        const state = simulation.getState();
        expect(state.tick).toBe(135);
        expect(Math.abs(state.players[1].vx)).toBeLessThan(0.01);
        expect(state.players[1].x).toBeLessThan(3);
        simulation.stop();
    });

    it.each([4000, 60000])('a movement received at wake time %i only affects subsequent ticks', (wake) => {
        const state = { ...createCountdown().getState(), phase: 'playing' as const, countdownTicks: 0 };
        const simulation = new TownMatchSimulation(state, 0);
        const movement = createFrame(1, { kind: 'controls', x: 1, z: 0, dash: 0 });
        simulation.accept(movement, 'bob-session', wake);
        simulation.advance(wake, state, seatDeadlineClock(wake));
        const atWake = simulation.getState();
        expect(atWake.players[1].x).toBe(state.players[1].x);
        simulation.advance(wake + 34, atWake, seatDeadlineClock(wake + 34));
        expect(simulation.getState().players[1].x).toBeGreaterThan(atWake.players[1].x);
        simulation.stop();
    });

    it('uses the recent playable interval when a long wake exceeds the catch-up limit', () => {
        const state = { ...createCountdown().getState(), phase: 'playing' as const, countdownTicks: 0 };
        const simulation = new TownMatchSimulation(state, 0);
        const dash = createFrame(1, { kind: 'controls', x: 1, z: 0, dash: 1 });
        simulation.accept(dash, 'alice-session', 0);
        simulation.accept(dash, 'bob-session', 59900);
        simulation.advance(60000, state, seatDeadlineClock(60000));
        const [alice, bob] = simulation.getState().players;
        expect(alice.consumedDash).toBe(0);
        expect(bob.consumedDash).toBe(1);
        expect(bob.x - state.players[1].x).toBeLessThan(2);
        simulation.stop();
    });

    it('replays changes of direction and input expiry identically on delayed and regular pumps', () => {
        const state = { ...createCountdown().getState(), phase: 'playing' as const, countdownTicks: 0 };
        const delayed = new TownMatchSimulation(state, 0);
        const regular = new TownMatchSimulation(state, 0);
        const right = createFrame(1, { kind: 'controls', x: 1, z: 0, dash: 0 });
        const turnAndDash = createFrame(2, { kind: 'controls', x: 0, z: 1, dash: 1 });
        delayed.accept(right, 'bob-session', 0);
        delayed.accept(turnAndDash, 'bob-session', 200);
        delayed.advance(1000, state, seatDeadlineClock(1000));

        regular.accept(right, 'bob-session', 0);
        regular.advance(200, state, seatDeadlineClock(200));
        regular.accept(turnAndDash, 'bob-session', 200);
        regular.advance(400, state, seatDeadlineClock(400));
        regular.advance(1000, state, seatDeadlineClock(1000));
        expect(delayed.getState().players[1]).toEqual(regular.getState().players[1]);
        expect(delayed.getState().players[1].consumedDash).toBe(1);
        delayed.stop();
        regular.stop();
    });

    it('rejects another session and an old round before they can move a player', () => {
        const countdown = createCountdown().getState();
        const simulation = new TownMatchSimulation({ ...countdown, phase: 'playing', countdownTicks: 0 }, 0);
        const before = simulation.getState();
        const movement = createFrame(1, { kind: 'controls', x: 1, z: 0, dash: 0 });
        simulation.accept(movement, 'outsider', 0);
        simulation.accept({ ...movement, matchId: 'old-round' }, 'bob-session', 0);
        simulation.advance(100, before, seatDeadlineClock(100));
        expect(simulation.getState().players.map((player) => player.x)).toEqual(before.players.map((player) => player.x));
        simulation.stop();
    });
});
