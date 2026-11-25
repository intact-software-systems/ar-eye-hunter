import { Either } from '@shared/resilience/Either.ts';

import { createPracticePlayer } from '../practice-rules.ts';
import { computeTownMatchSeats, createTownMatchSeats, type TownMatchSeatObservation } from './match-seats.ts';
import type { TownMatchIdentity, TownMatchPlayer, TownMatchState } from './town-match.ts';

export interface TownMatchRecovery {
    readonly state: TownMatchState;
    readonly members: readonly TownMatchIdentity[];
    readonly departedIds: readonly string[];
    readonly clock: TownMatchSeatObservation['clock'];
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
    const participating = members.filter(member => state.participants.some(player => player.id === member.id));
    if (participating.length < 2 && members.length > participating.length) {
        return computeTownMatchRoster(state, members);
    }
    if (participating.length < 2) {
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
    if (
        seats.some((seat) => {
            const present = members.some((member) => member.id === seat.id);
            return (seat.status === 'active' && !present) || (seat.status === 'away' && present);
        })
    ) {
        return Either.ofLeft(['Seat recovery is waiting for a definite deadline decision.']);
    }
    return Either.ofRight({
        ...state,
        seats,
        members: members.toSorted((left, right) => left.id.localeCompare(right.id)).map((member) => ({
            ...member,
            displayName: state.participants.find((participant) => participant.id === member.id)?.displayName ??
                member.displayName,
            ready: state.participants.some(player => player.id === member.id) ||
                state.members.some(previous => previous.id === member.id && previous.ready)
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

export function createTownMatchPlayer(member: TownMatchIdentity, index: number): TownMatchPlayer {
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
