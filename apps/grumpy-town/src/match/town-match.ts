import { Either } from '@shared/resilience/Either.ts';

import { computePracticePlayerTick, type PracticePlayer } from '../practice-rules.ts';
import { computeTownWorld } from '../town/rules.ts';
import { createTownState, type TownState, type TownWorldPlayer } from '../town/state.ts';
import type { TownRoutes } from '../town/town-routes.ts';
import type { TownMatchInput } from './match-input.ts';
import {
    computeTownMatchSeats,
    createTownMatchSeats,
    type TownMatchSeat,
    type TownMatchSeatObservation
} from './match-seats.ts';

import { createTownMatchPlayer, validateTownMatchMembers } from './round-roster.ts';

export {
    computeTownMatchRecovery,
    computeTownMatchRoster,
    type TownMatchRecovery,
    validateTownMatchMembers
} from './round-roster.ts';

export const TOWN_MATCH_RATE = 30;
export const TOWN_MATCH_DURATION = 180;
export const TOWN_MATCH_TARGET = 100;

export interface TownMatchParticipant {
    readonly id: string;
    readonly displayName: string;
}
export interface TownMatchIdentity extends TownMatchParticipant {
    readonly sessionId: string;
}
export interface TownMatchMember extends TownMatchIdentity {
    readonly ready: boolean;
}
export interface TownMatchPlayer extends PracticePlayer, TownWorldPlayer {}
export interface TownMatchResult {
    readonly id: string;
    readonly displayName: string;
    readonly score: number;
    readonly rescues: number;
    readonly qualified: boolean;
}
export interface TownMatchState {
    readonly matchId: string;
    readonly phase: 'lobby' | 'countdown' | 'playing' | 'finished' | 'interrupted';
    readonly tick: number;
    readonly countdownTicks: number;
    readonly remainingTicks: number;
    readonly members: readonly TownMatchMember[];
    readonly participants: readonly TownMatchParticipant[];
    readonly seats: readonly TownMatchSeat[];
    readonly players: readonly TownMatchPlayer[];
    readonly town: TownState;
    readonly results: readonly TownMatchResult[];
    readonly interruption: string | undefined;
}
export interface TownMatchReady extends TownMatchIdentity {
    readonly ready: boolean;
}
export interface TownMatchTick {
    readonly state: TownMatchState;
    readonly routes: TownRoutes;
    readonly clock: TownMatchSeatObservation['clock'];
    readonly inputs: readonly TownMatchInput[];
    readonly now: number;
}
export function createTownMatch(
    matchId: string,
    members: readonly TownMatchIdentity[]
): Either<readonly string[], TownMatchState> {
    const issues = [...validateTownMatchMembers(members, 1)];
    if (!matchId || matchId.length > 128) {
        issues.push('A bounded match identity is required.');
    }
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const ordered = members.toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return Either.ofRight({
        matchId,
        phase: 'lobby',
        tick: 0,
        countdownTicks: 0,
        remainingTicks: TOWN_MATCH_RATE * TOWN_MATCH_DURATION,
        members: ordered.map((member) => ({ ...member, ready: false })),
        participants: ordered.map(({ id, displayName }) => ({ id, displayName })),
        seats: createTownMatchSeats(ordered),
        players: ordered.map(createTownMatchPlayer),
        town: { ...createTownState(), companion: undefined },
        results: [],
        interruption: undefined
    });
}

export function computeTownMatchReady(state: TownMatchState, ready: TownMatchReady): TownMatchState {
    if (
        (state.phase !== 'lobby' && state.participants.some(player => player.id === ready.id)) || !ready.displayName.trim() || ready.displayName.length > 128 ||
        !state.members.some((member) => member.id === ready.id && member.sessionId === ready.sessionId)
    ) {
        return state;
    }
    return {
        ...state,
        members: state.members.map((member) =>
            member.id === ready.id && member.sessionId === ready.sessionId
                ? { ...member, ready: ready.ready, displayName: ready.displayName }
                : member
        ),
        participants: state.participants.map((participant) =>
            participant.id === ready.id ? { ...participant, displayName: ready.displayName } : participant
        )
    };
}

export function computeTownMatchStart(state: TownMatchState): TownMatchState {
    if (state.phase !== 'lobby' || state.members.length < 2 || !state.members.every((member) => member.ready)) {
        return state;
    }
    return { ...state, phase: 'countdown', countdownTicks: TOWN_MATCH_RATE * 3 };
}

export function computeTownMatchRematch(
    state: TownMatchState,
    matchId: string
): Either<readonly string[], TownMatchState> {
    if ((state.phase !== 'finished' && state.phase !== 'interrupted') || matchId === state.matchId) {
        return Either.ofLeft(['A rematch needs a finished or interrupted round and a new match identity.']);
    }
    return createTownMatch(matchId, state.members).mapRight(next => ({
        ...next,
        members: next.members.map(member => ({
            ...member,
            ready: !state.participants.some(player => player.id === member.id) &&
                state.members.some(waiting => waiting.id === member.id && waiting.ready)
        }))
    }));
}

export function computeTownMatchTick(input: TownMatchTick): TownMatchState {
    const { state } = input;
    const seats = computeTownMatchSeats({
        seats: state.seats,
        available: state.members,
        departedIds: [],
        clock: input.clock
    });
    if (state.phase === 'countdown') {
        const countdownTicks = Math.max(0, state.countdownTicks - 1);
        return { ...state, seats, countdownTicks, phase: countdownTicks === 0 ? 'playing' : 'countdown' };
    }
    if (state.phase !== 'playing') {
        return state;
    }
    const tick = state.tick + 1;
    const elapsed = tick / TOWN_MATCH_RATE;
    const moved = state.players.filter((player) =>
        seats.some((seat) => seat.id === player.id && seat.status === 'active')
    )
        .map((player) => advanceTownMatchPlayer(input, player));
    const world = computeTownWorld({
        town: state.town,
        players: moved,
        routes: input.routes,
        now: elapsed,
        step: 1 / TOWN_MATCH_RATE
    });
    const players = state.players.map((player) => {
        const active = moved.find((actor) => actor.id === player.id);
        return active ? { ...active, ...world.players.find((actor) => actor.id === player.id)!, elapsed } : player;
    });
    const remainingTicks = Math.max(0, state.remainingTicks - 1);
    const finished = remainingTicks === 0;
    return {
        ...state,
        tick,
        seats,
        players,
        town: world.town,
        remainingTicks,
        phase: finished ? 'finished' : 'playing',
        results: finished
            ? players.map((player) => ({
                id: player.id,
                displayName: state.participants.find((participant) => participant.id === player.id)!.displayName,
                score: player.score,
                rescues: player.rescues,
                qualified: player.score >= TOWN_MATCH_TARGET
            }))
            : []
    };
}

function advanceTownMatchPlayer(input: TownMatchTick, player: TownMatchPlayer): TownMatchPlayer {
    const member = input.state.members.find((member) => member.id === player.id);
    const sample = input.inputs.find((sample) =>
        sample.playerId === player.id &&
        sample.sessionId === member?.sessionId && sample.matchId === input.state.matchId && sample.expiresAt > input.now
    );
    const controls = sample?.controls ?? { x: 0, z: 0, dash: player.consumedDash };
    const moved = computePracticePlayerTick({
        player: { ...player, elapsed: input.state.tick / TOWN_MATCH_RATE },
        town: input.state.town,
        controls,
        seconds: 1 / TOWN_MATCH_RATE
    });
    return { ...player, ...moved.player, dash: moved.dash };
}
