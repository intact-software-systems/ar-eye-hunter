import {
    computeTournamentAttemptFence,
    computeTournamentResultPublication,
    type TournamentResultRepository
} from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { createTournamentResult } from '@shared-server/rallar-system/tournaments/tournament-result.ts';
import { toRelicRoomGroupRef } from '../mod.ts';
import type { RelicGameState } from '../mod.ts';
import type { RelicTournamentParticipation } from '../src/relic-tournament-participation.ts';
import { RELIC_TOURNAMENT_RULES_ID, relicPlayerId } from '../src/relic-tournament-participation.ts';
import type { RelicGameMutationService } from './relic-game-mutation-service.ts';

const tournamentScope = toRelicRoomGroupRef('scope');
export const RELIC_TOURNAMENT_GAME_PROFILE = {
    scope: { applicationId: tournamentScope.applicationId, workspaceId: tournamentScope.workspaceId },
    rulesId: RELIC_TOURNAMENT_RULES_ID,
    gameLifecycleTopic: 'app:relic:tournament-lifecycle'
};

/** A tournament hunter is an account; casual expeditions retain their session-owned participation. */
export function relicMutationPlayerId(read: RelicGameMutationService.Read): string {
    const actor = read.ingress.command.actor;
    if (actor === null) {
        throw new TypeError('A server clock has no player identity');
    }
    return relicPlayerId(read.tournament?.binding ?? null, actor);
}

export function relicTournamentMutationRefusal(
    read: RelicGameMutationService.Read
): RelicGameMutationService.RefusalReason | null {
    const tournament = read.tournament;
    if (tournament === null) {
        return null;
    }
    const { command } = read.ingress;
    if (tournament.binding.rulesId !== RELIC_TOURNAMENT_RULES_ID || tournament.binding.gameId !== command.gameId) {
        return {
            code: 'unsupported-tournament-rules',
            message: 'This attempt does not authorize this expedition.',
            httpStatus: 409
        };
    }
    const commandRefusal = relicTournamentCommandRefusal(read);
    if (commandRefusal !== null || command.operation === 'tournament-clock' && command.clock.phase === 'cancelled') {
        return commandRefusal;
    }
    if (tournament.attempt?.status === 'finished' && command.operation === 'ensure') {
        return null;
    }
    if (
        tournament.attempt?.status !== 'playing' || tournament.attempt.startedAtEpochMs === null ||
        tournament.attempt.startedAtEpochMs > read.attemptAtEpochMs
    ) {
        return {
            code: 'inactive-tournament-attempt',
            message: 'This tournament attempt is no longer playing.',
            httpStatus: 409
        };
    }
    if (command.actor !== null && !tournament.binding.principalIds.includes(command.actor.clientId)) {
        return {
            code: 'tournament-competitor-required',
            message: 'Only this match’s two competitors can play.',
            httpStatus: 403
        };
    }
    if (
        tournament.binding.principalIds.some((principalId) =>
            !read.group?.snapshot.members.some((member) =>
                member.principalId === principalId && member.status === 'active' && member.role !== 'spectator'
            )
        )
    ) {
        return {
            code: 'tournament-competitor-unavailable',
            message: 'Both tournament competitors must remain eligible.',
            httpStatus: 409
        };
    }
    return null;
}

/** Tournament configuration and withdrawal belong to the bracket, never to an in-room command. */
function relicTournamentCommandRefusal(
    read: RelicGameMutationService.Read
): RelicGameMutationService.RefusalReason | null {
    const { command } = read.ingress;
    if (command.operation === 'tournament-clock' && command.clock.phase === 'cancelled') {
        return read.tournament?.attempt?.status === 'cancelled' ? null : {
            code: 'tournament-not-cancelled',
            message: 'This attempt has not been cancelled.',
            httpStatus: 409
        };
    }
    if (
        command.operation === 'reset' || command.move && [
                'start-expedition',
                'set-round-limit',
                'set-rematch-round-limit',
                'set-rematch-ready',
                'start-rematch'
            ].includes(command.move.kind)
    ) {
        return {
            code: 'tournament-settings-frozen',
            message: 'Tournament settings are fixed. Start a replay from the bracket.',
            httpStatus: 409
        };
    }
    if (command.move?.kind === 'leave-expedition') {
        return {
            code: 'tournament-withdrawal-required',
            message: 'Withdraw from the tournament to leave this match.',
            httpStatus: 409
        };
    }
    return null;
}

/** Native state and the exact private attempt/result commit in one AppInbox transaction. */
export function computeRelicTournamentWrite(
    read: RelicGameMutationService.Read,
    next: RelicGameState
): TournamentResultRepository.Write | null {
    const tournament = read.tournament;
    if (tournament === null) {
        return null;
    }
    if (next.maxRounds !== 10 || next.roundTimeLimitMs !== 60000 || next.gameId !== tournament.binding.gameId) {
        throw new TypeError('Relic tournament state differs from its frozen rules');
    }
    if (next.players.some((player) => !tournament.binding.principalIds.includes(player.playerId))) {
        throw new TypeError('Relic tournament contains an unbound hunter');
    }
    if (next.phase !== 'finished') {
        return { storage: computeTournamentAttemptFence(tournament, 'playing'), outbox: [] };
    }
    const scores = tournament.binding.principalIds.map((principalId) => {
        const player = next.players.find((candidate) => candidate.playerId === principalId);
        if (!player) {
            throw new TypeError('Relic tournament completion lacks a bound hunter');
        }
        return player.score;
    });
    const startedAtEpochMs = tournament.attempt?.startedAtEpochMs;
    if (startedAtEpochMs == null) {
        throw new TypeError('Relic completion lacks an authorized start');
    }
    const result = createTournamentResult({
        binding: tournament.binding,
        authority: { kind: 'server', id: read.ingress.serverPeerId, epoch: 1 },
        startedAtEpochMs,
        finishedAtEpochMs: next.updatedAtEpochMs,
        scores: [scores[0], scores[1]]
    });
    const publication = computeTournamentResultPublication(
        tournament,
        result,
        Math.max(read.attemptAtEpochMs, next.updatedAtEpochMs)
    );
    if (publication.kind !== 'publish') {
        throw new TypeError('Relic completion lacks a new authorized result');
    }
    return publication.write;
}

/** Public participation carries cancellation so clients can leave without reviving an obsolete attempt. */
export function toRelicTournamentParticipation(
    tournament: TournamentResultRepository.Read | null
): RelicTournamentParticipation | null {
    if (tournament === null) {
        return null;
    }
    if (tournament.attempt === null || tournament.attempt.status === 'scheduled') {
        throw new TypeError('Relic tournament attempt is missing');
    }
    return { binding: tournament.binding, status: tournament.attempt.status };
}
