import {
    changeRallarGameRematchSettings,
    createRallarGameRematch,
    evaluateRallarGameRematchStart,
    isRallarGameRematch,
    setRallarGameRematchReady,
    type RallarGameParticipant,
    type RallarGameRematch
} from '@shared/rallar-game/rematch.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { ArenaMatchDurationMs, ArenaMatchState, MatchStartedAccepted } from './arena-contracts.ts';
import { type ArenaSimulationState } from './arena-contracts.ts';
import { startArenaMatch } from './arena-match.ts';

export interface ArenaRematch {
    readonly preparation: RallarGameRematch;
    readonly durationMs: ArenaMatchDurationMs;
}

export type ArenaRematchCommand =
    & Readonly<{ completedGameId: string; settingsKey: string; sessionId: string; }>
    & (
        | Readonly<{ kind: 'ready'; ready: boolean; participationKey: string; }>
        | Readonly<{ kind: 'settings'; durationMs: ArenaMatchDurationMs; }>
        | Readonly<{ kind: 'start'; }>
    );

export interface ArenaRematchAuthority {
    readonly nowEpochMs: number;
    readonly leaderSessionId: string | undefined;
    readonly participants: readonly RallarGameParticipant[];
}

export interface ArenaRematchRefusal {
    readonly code: string;
    readonly message: string;
}

export interface ArenaRematchResult {
    readonly state: ArenaSimulationState;
    readonly acceptedMatch?: MatchStartedAccepted;
}

export function createArenaRematch(match: ArenaMatchState): Either<ArenaRematchRefusal, ArenaRematch> {
    return createRallarGameRematch({
        completedGameId: match.matchId,
        settingsKey: `duration:${match.durationMs}:0`,
        participantSessionIds: match.results?.map((standing) => standing.sessionId) ?? Object.keys(match.baseline),
        // The room service owns player capacity; preparation never admits room membership.
        capacity: Number.MAX_SAFE_INTEGER
    }).mapRight((preparation) => ({ preparation, durationMs: match.durationMs }));
}

export function applyArenaRematchCommand(
    state: ArenaSimulationState,
    command: ArenaRematchCommand,
    authority: ArenaRematchAuthority
): Either<ArenaRematchRefusal, ArenaRematchResult> {
    const match = state.match;
    if (!match || match.status !== 'complete' || command.completedGameId !== match.matchId) {
        return Either.ofLeft({ code: 'stale-preparation', message: 'That match is no longer awaiting a rematch.' });
    }
    const prepared = match.rematch
        ? Either.ofRight<ArenaRematchRefusal, ArenaRematch>(match.rematch)
        : createArenaRematch(match);
    return prepared.flatMap<ArenaRematchRefusal, ArenaRematchResult>(Either.ofLeft, (rematch) => {
        if (command.settingsKey !== rematch.preparation.settingsKey) {
            return Either.ofLeft({ code: 'stale-preparation', message: 'The next match settings changed.' });
        }
        if (command.kind === 'start') {
            return startPreparedArenaMatch(state, rematch, { command, authority });
        }
        if (command.kind === 'ready') {
            return setRallarGameRematchReady({
                preparation: rematch.preparation,
                assignment: command,
                participants: authority.participants,
                capacity: Number.MAX_SAFE_INTEGER
            })
                .mapRight((preparation) => ({
                    state: {
                        ...state,
                        revision: state.revision + 1,
                        match: { ...match, rematch: { ...rematch, preparation } }
                    }
                }));
        }
        return changeArenaRematchSettings({ state, rematch, command, authority });
    });
}

interface ArenaRematchStart {
    readonly command: Extract<ArenaRematchCommand, { kind: 'start'; }>;
    readonly authority: ArenaRematchAuthority;
}

function startPreparedArenaMatch(
    state: ArenaSimulationState,
    rematch: ArenaRematch,
    { command, authority }: ArenaRematchStart
): Either<ArenaRematchRefusal, ArenaRematchResult> {
    return evaluateRallarGameRematchStart(rematch.preparation, {
        ...command,
        actorSessionId: command.sessionId,
        leaderSessionId: authority.leaderSessionId,
        participants: authority.participants
    }).flatMap<ArenaRematchRefusal, ArenaRematchResult>(Either.ofLeft, (participants) => {
        const players = state.players.filter((player) => participants.includes(player.sessionId));
        if (players.length !== participants.length) {
            return Either.ofLeft({
                code: 'player-state-missing',
                message: 'Waiting for every ready player to synchronize.'
            });
        }
        const result = startArenaMatch({ ...state, players }, {
            matchId: `match:${command.completedGameId}:${state.revision + 1}`,
            directorSessionId: command.sessionId,
            durationMs: rematch.durationMs,
            sentAtEpochMs: authority.nowEpochMs
        }, authority.nowEpochMs);
        if (!result.accepted) {
            return Either.ofLeft({ code: result.reason, message: 'The next match could not start.' });
        }
        const match = { ...result.acceptedMatch.match, enrollment: 'confirmed' as const };
        return Either.ofRight({
            state: { ...result.state, match, players: state.players },
            acceptedMatch: { ...result.acceptedMatch, match }
        });
    });
}

export function isArenaRematchCommand(value: unknown): value is ArenaRematchCommand {
    if (!value || typeof value !== 'object') {
        return false;
    }
    if (
        !('completedGameId' in value) || typeof value.completedGameId !== 'string' || !value.completedGameId ||
        !('settingsKey' in value) || typeof value.settingsKey !== 'string' || !value.settingsKey ||
        !('sessionId' in value) || typeof value.sessionId !== 'string' || !value.sessionId || !('kind' in value)
    ) {
        return false;
    }
    const keys = Object.keys(value).length;
    return value.kind === 'start' && keys === 4 ||
        value.kind === 'ready' && keys === 6 && 'ready' in value && typeof value.ready === 'boolean' &&
            'participationKey' in value && typeof value.participationKey === 'string' &&
            value.participationKey.length > 0 ||
        value.kind === 'settings' && keys === 5 && 'durationMs' in value && typeof value.durationMs === 'number' &&
            [60_000, 180_000, 300_000].includes(value.durationMs);
}

/** A present preparation is a complete wire contract, never a sparse patch. */
export function hasValidArenaRematch(match: ArenaMatchState | undefined): boolean {
    if (match?.rematch === undefined) {
        return true;
    }
    const rematch = match.rematch;
    return match.status === 'complete' && rematch !== null && typeof rematch === 'object' &&
        Object.keys(rematch).length === 2 && [60_000, 180_000, 300_000].includes(rematch.durationMs) &&
        isRallarGameRematch(rematch.preparation, Number.MAX_SAFE_INTEGER) &&
        rematch.preparation.completedGameId === match.matchId;
}
interface ArenaRematchSettingsInput {
    readonly state: ArenaSimulationState;
    readonly rematch: ArenaRematch;
    readonly command: Extract<ArenaRematchCommand, { kind: 'settings'; }>;
    readonly authority: ArenaRematchAuthority;
}
function changeArenaRematchSettings(
    { state, rematch, command, authority }: ArenaRematchSettingsInput
): Either<ArenaRematchRefusal, ArenaRematchResult> {
    if (
        command.sessionId !== authority.leaderSessionId ||
        !authority.participants.some((entry) => entry.sessionId === command.sessionId)
    ) {
        return Either.ofLeft({
            code: 'leader-required',
            message: 'Only the present director can change the next match.'
        });
    }
    if (![60_000, 180_000, 300_000].includes(command.durationMs)) {
        return Either.ofLeft({ code: 'invalid-duration', message: 'Choose a one, three or five minute match.' });
    }
    if (rematch.durationMs === command.durationMs) {
        return Either.ofRight({ state });
    }
    const preparation = changeRallarGameRematchSettings(
        rematch.preparation,
        `duration:${command.durationMs}:${state.revision + 1}`
    );
    return Either.ofRight({
        state: {
            ...state,
            revision: state.revision + 1,
            match: { ...state.match!, rematch: { preparation, durationMs: command.durationMs } }
        }
    });
}
