import {
    ArenaSimulationState,
    type ArenaMatchDurationMs,
    type ArenaMatchPlayerBaseline,
    type ArenaMatchStanding,
    type ArenaMatchState,
    type MatchStartedAccepted,
    type MatchStartIntent,
    type PlayerArenaState
} from './arena-contracts.ts';
import { createSystemEvent } from './arena-events.ts';
import { round2 } from './arena-math.ts';

export type ArenaMatchStartResolution =
    | Readonly<{ accepted: false; state: ArenaSimulationState; reason: string; }>
    | Readonly<{ accepted: true; state: ArenaSimulationState; acceptedMatch: MatchStartedAccepted; }>;

export function startArenaMatch(
    state: ArenaSimulationState,
    intent: MatchStartIntent,
    nowEpochMs: number
): ArenaMatchStartResolution {
    if (!isArenaMatchDuration(intent.durationMs)) {
        return { accepted: false, state, reason: 'invalid-duration' };
    }
    if (state.match?.status === 'active' && state.match.endsAtEpochMs > nowEpochMs) {
        return { accepted: false, state, reason: 'match-active' };
    }
    if (Math.abs(nowEpochMs - intent.sentAtEpochMs) > 5_000) {
        return { accepted: false, state, reason: 'stale-match-intent' };
    }

    const baseline = createArenaMatchBaseline(state.players);
    const revision = state.revision + 1;
    const match: ArenaMatchState = {
        matchId: intent.matchId,
        status: 'active',
        enrollment: 'open',
        durationMs: intent.durationMs,
        directorSessionId: intent.directorSessionId,
        startedAtEpochMs: nowEpochMs,
        endsAtEpochMs: nowEpochMs + intent.durationMs,
        baseline
    };
    const event = createSystemEvent({
        kind: 'match-started',
        revision,
        nowEpochMs,
        position: [0, 1.2, 0],
        headline: `Arena match armed for ${Math.round(intent.durationMs / 60_000)} minute${
            intent.durationMs === 60_000 ? '' : 's'
        }`
    });
    const nextState: ArenaSimulationState = {
        ...state,
        revision,
        match,
        events: [...state.events.slice(-23), event],
        activeEvent: event
    };
    return {
        accepted: true,
        state: nextState,
        acceptedMatch: {
            intent,
            match,
            revision,
            acceptedAtEpochMs: nowEpochMs
        }
    };
}

export function finishArenaMatchIfDue(
    state: ArenaSimulationState,
    nowEpochMs: number
): ArenaSimulationState {
    const match = state.match;
    if (!match || match.status !== 'active' || nowEpochMs < match.endsAtEpochMs) {
        return state;
    }

    const results = rankArenaMatchPlayers(match, state.players);
    const revision = state.revision + 1;
    const winner = results[0];
    const completed: ArenaMatchState = {
        ...match,
        status: 'complete',
        completedAtEpochMs: nowEpochMs,
        results
    };
    const event = createSystemEvent({
        kind: 'match-ended',
        revision,
        nowEpochMs,
        position: winner
            ? state.players.find((player) => player.sessionId === winner.sessionId)?.position
            : [0, 1.2, 0],
        headline: winner
            ? `${winner.username} wins the audit sprint`
            : 'Arena match ended with nobody pleasing the metrics'
    });
    return {
        ...state,
        revision,
        match: completed,
        events: [...state.events.slice(-23), event],
        activeEvent: event
    };
}

function isArenaMatchDuration(value: number): value is ArenaMatchDurationMs {
    return value === 60_000 || value === 180_000 || value === 300_000;
}

function createArenaMatchBaseline(
    players: readonly PlayerArenaState[]
): Readonly<Record<string, ArenaMatchPlayerBaseline>> {
    return Object.fromEntries(players.map((player, index) => [
        player.sessionId,
        {
            sessionId: player.sessionId,
            username: player.username,
            score: round2(player.score ?? 0),
            kills: player.vitals.kills,
            deaths: player.vitals.deaths,
            joinedOrder: index
        }
    ]));
}

function rankArenaMatchPlayers(
    match: ArenaMatchState,
    players: readonly PlayerArenaState[]
): readonly ArenaMatchStanding[] {
    const active = players.filter((player) =>
        match.enrollment === 'open' || Object.hasOwn(match.baseline, player.sessionId)
    ).map((player, index) => {
        const baseline = match.baseline[player.sessionId] ?? {
            sessionId: player.sessionId,
            username: player.username,
            score: 0,
            kills: 0,
            deaths: 0,
            joinedOrder: index
        };
        return {
            sessionId: player.sessionId,
            username: player.username,
            scoreDelta: round2((player.score ?? 0) - baseline.score),
            killsDelta: player.vitals.kills - baseline.kills,
            deathsDelta: player.vitals.deaths - baseline.deaths,
            joinedOrder: baseline.joinedOrder
        };
    });
    const historical = Object.values(match.baseline)
        .filter((baseline) => !players.some((player) => player.sessionId === baseline.sessionId))
        .map((baseline) => ({
            sessionId: baseline.sessionId,
            username: baseline.username,
            scoreDelta: 0,
            killsDelta: 0,
            deathsDelta: 0,
            joinedOrder: baseline.joinedOrder
        }));
    return [...active, ...historical]
        .sort((a, b) =>
            b.scoreDelta - a.scoreDelta ||
            b.killsDelta - a.killsDelta ||
            a.deathsDelta - b.deathsDelta ||
            a.joinedOrder - b.joinedOrder ||
            a.username.localeCompare(b.username)
        )
        .map(({ joinedOrder: _joinedOrder, ...standing }, index) => ({
            ...standing,
            rank: index + 1
        }));
}
