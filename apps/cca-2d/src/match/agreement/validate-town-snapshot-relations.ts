import { TOWN_MATCH_EXTENSION_TICKS, TOWN_MATCH_MAX_TICKS } from '../match-extension.ts';
import {
    TOWN_MATCH_DURATION,
    TOWN_MATCH_RATE,
    TOWN_MATCH_TARGET,
    validateTownMatchMembers,
    type TownMatchState
} from '../town-match.ts';

export function validateTownSnapshotRelations(state: TownMatchState): readonly string[] {
    const issues = [
        ...validateTownMatchMembers(state.members, state.phase === 'interrupted' || state.phase === 'finished' ? 0 : 1)
    ];
    const playerIds = state.players.map((player) => player.id);
    const participantIds = state.participants.map((participant) => participant.id);
    if (
        new Set(participantIds).size !== participantIds.length || participantIds.length !== playerIds.length ||
        participantIds.some((id) => !playerIds.includes(id))
    ) {
        issues.push('Snapshot participants must match the retained round players.');
    }
    if (new Set(playerIds).size !== playerIds.length || (playerIds.length === 0 && state.phase !== 'interrupted')) {
        issues.push('Snapshot players must have distinct identities.');
    }
    if (
        state.phase !== 'interrupted' && state.phase !== 'finished' &&
        ((state.phase === 'lobby' && state.members.length !== playerIds.length) ||
            state.members.some((member) => !playerIds.includes(member.id)))
    ) {
        issues.push('Snapshot players do not match the round roster.');
    }
    const duration = state.tick + state.remainingTicks;
    const added = duration - TOWN_MATCH_DURATION * TOWN_MATCH_RATE;
    if (
        added < 0 || duration > TOWN_MATCH_MAX_TICKS || added % TOWN_MATCH_EXTENSION_TICKS !== 0 ||
        ((state.phase === 'lobby' || state.phase === 'countdown') && added !== 0) ||
        (state.phase === 'finished' && (state.remainingTicks !== 0 || state.results.length !== playerIds.length))
    ) {
        issues.push('Snapshot clock or results are inconsistent.');
    }
    if (state.phase !== 'finished' && state.results.length > 0) {
        issues.push('Only a finished round can have results.');
    }
    if (
        state.results.some((result, index) => {
            const player = state.players[index];
            return result.id !== player?.id || result.score !== player.score || result.rescues !== player.rescues ||
                result.qualified !== (player.score >= TOWN_MATCH_TARGET);
        })
    ) {
        issues.push('Snapshot results do not describe the players.');
    }
    return [
        ...issues,
        ...validateTownSnapshotSeats(state),
        ...validateTownSnapshotClock(state)
    ];
}

function validateTownSnapshotSeats(state: TownMatchState): readonly string[] {
    const issues: string[] = [];
    if (
        state.seats.length !== state.participants.length ||
        new Set(state.seats.map((seat) => seat.id)).size !== state.seats.length ||
        new Set(state.seats.map((seat) => seat.sessionId)).size !== state.seats.length ||
        state.seats.some((seat) => !state.participants.some((participant) => participant.id === seat.id))
    ) {
        issues.push('Round seats must uniquely identify the retained participants and their controllers.');
    }
    const activeRound = state.phase === 'lobby' || state.phase === 'countdown' || state.phase === 'playing';
    for (const seat of state.seats) {
        if ((seat.status === 'away') !== (seat.expiresAtEpochMs > 0)) {
            issues.push('Only an away seat may have a grace deadline.');
        }
        const controller = state.members.find((member) => member.id === seat.id);
        if (activeRound && seat.status === 'active' && controller?.sessionId !== seat.sessionId) {
            issues.push('An active seat must name its current controller.');
        }
        if (activeRound && seat.status === 'away' && controller) {
            issues.push('An away seat cannot have a current controller.');
        }
        if (state.phase === 'lobby' && seat.status !== 'active') {
            issues.push('A fresh lobby resets all round seats.');
        }
    }
    return issues;
}

function validateTownSnapshotClock(state: TownMatchState): readonly string[] {
    if ((state.phase === 'lobby' || state.phase === 'countdown') && state.tick !== 0) {
        return ['A lobby or countdown cannot contain elapsed round time.'];
    }
    if (state.phase === 'countdown' && state.countdownTicks === 0) {
        return ['A countdown must still have ticks remaining.'];
    }
    if (
        (state.phase === 'lobby' || state.phase === 'playing' || state.phase === 'finished') &&
        state.countdownTicks !== 0
    ) {
        return ['Only a countdown or interrupted countdown may retain countdown ticks.'];
    }
    if (state.phase === 'playing' && state.remainingTicks === 0) {
        return ['A round with no time remaining must be finished.'];
    }
    return [];
}
