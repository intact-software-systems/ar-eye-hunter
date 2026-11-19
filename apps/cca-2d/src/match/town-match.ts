import { Either } from '@shared/resilience/Either.ts';

import { computePracticePlayerTick, createPracticePlayer, type PracticePlayer } from '../practice-rules.ts';
import type { TownRoutes } from '../town/routes.ts';
import { computeTownWorld } from '../town/rules.ts';
import { createTownState, type TownState, type TownWorldPlayer } from '../town/state.ts';
import type { TownMatchInput } from './match-input.ts';
import { computeTownMatchSeats, createTownMatchSeats, type TownMatchSeat, type TownMatchSeatObservation } from './match-seats.ts';

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
export interface TownMatchRecovery {
    readonly state: TownMatchState;
    readonly members: readonly TownMatchIdentity[];
    readonly departedIds: readonly string[];
    readonly clock: TownMatchSeatObservation['clock'];
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
        state.phase !== 'lobby' || !ready.displayName.trim() || ready.displayName.length > 128 ||
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

export function computeTownMatchRoster(
    state: TownMatchState,
    members: readonly TownMatchIdentity[]
): Either<readonly string[], TownMatchState> {
    const issues = validateTownMatchMembers(members, 0);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const ordered = members.toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const changed = ordered.length !== state.members.length ||
        ordered.some((member) =>
            !state.members.some((previous) => previous.id === member.id && previous.sessionId === member.sessionId)
        );
    const interrupted = changed && (state.phase === 'countdown' || state.phase === 'playing' ||
        (state.phase === 'lobby' && ordered.length === 0));
    const roster = ordered.map((member) => {
        const previous = state.members.find((entry) => entry.id === member.id && entry.sessionId === member.sessionId);
        return { ...member, displayName: previous?.displayName ?? member.displayName, ready: previous?.ready ?? false };
    });
    return Either.ofRight({
        ...state,
        members: roster,
        players: state.phase === 'lobby' ? ordered.map(createTownMatchPlayer) : state.players,
        seats: state.phase === 'lobby' ? createTownMatchSeats(ordered) : state.seats,
        participants: state.phase === 'lobby'
            ? roster.map(({ id, displayName }) => ({ id, displayName }))
            : state.participants,
        phase: interrupted ? 'interrupted' : state.phase,
        interruption: interrupted ? 'The match roster changed. Ready up for a new round.' : state.interruption
    });
}

export function computeTownMatchRecovery(recovery: TownMatchRecovery): Either<readonly string[], TownMatchState> {
    const { state, members } = recovery;
    const issues = [...validateTownMatchMembers(members, 1)];
    if (state.phase !== 'playing' && state.phase !== 'countdown') {
        issues.push('Only an active round can resume from a checkpoint.');
    }
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    if (members.some((member) => !state.participants.some((player) => player.id === member.id))) {
        return computeTownMatchRoster(state, members);
    }
    if (members.length < 2) {
        return Either.ofLeft(['Recovery requires at least two original round participants.']);
    }
    const seats = computeTownMatchSeats({
        seats: state.seats,
        available: members,
        departedIds: recovery.departedIds,
        clock: recovery.clock
    });
    // A returning controller or newly absent player needs a definite timing decision
    // before this roster can become a valid checkpoint.
    if (seats.some(seat => {
        const present = members.some(member => member.id === seat.id);
        return (seat.status === 'active' && !present) || (seat.status === 'away' && present);
    })) {
        return Either.ofLeft(['Seat recovery is waiting for a definite deadline decision.']);
    }
    return Either.ofRight({
        ...state,
        seats,
        members: members.toSorted((left, right) => left.id.localeCompare(right.id)).map((member) => ({
            ...member,
            displayName: state.participants.find((participant) => participant.id === member.id)?.displayName ??
                member.displayName,
            ready: true
        })),
        players: state.players.map((player) => ({
            ...player,
            vx: 0,
            vz: 0,
            dash: false,
            rescueTarget: undefined,
            rescueProgress: 0
        }))
    });
}

export function computeTownMatchRematch(
    state: TownMatchState,
    matchId: string
): Either<readonly string[], TownMatchState> {
    if ((state.phase !== 'finished' && state.phase !== 'interrupted') || matchId === state.matchId) {
        return Either.ofLeft(['A rematch needs a finished or interrupted round and a new match identity.']);
    }
    return createTownMatch(matchId, state.members);
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

export function validateTownMatchMembers(members: readonly TownMatchIdentity[], minimum: 0 | 1): readonly string[] {
    const issues: string[] = [];
    if (members.length < minimum || members.length > 4) {
        issues.push(
            minimum === 1 ? 'A lobby supports one to four members.' : 'A roster supports at most four members.'
        );
    }
    if (
        new Set(members.map((member) => member.id)).size !== members.length ||
        new Set(members.map((member) => member.sessionId)).size !== members.length
    ) {
        issues.push('Each member and session must be distinct.');
    }
    for (const member of members) {
        if (
            !member.id || member.id.startsWith('@') || member.id.length > 128 ||
            !member.sessionId || member.sessionId.length > 128 || !member.displayName || member.displayName.length > 128
        ) {
            issues.push('Members need bounded identities, sessions and display names.');
        }
    }
    return issues;
}

function createTownMatchPlayer(member: TownMatchIdentity, index: number): TownMatchPlayer {
    return {
        ...createPracticePlayer(),
        id: member.id,
        x: (index - 1) * 1.5,
        z: -2,
        dash: false,
        score: 0,
        rescues: 0,
        rescueTarget: undefined,
        rescueProgress: 0,
        rewardedThisRaid: false
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
