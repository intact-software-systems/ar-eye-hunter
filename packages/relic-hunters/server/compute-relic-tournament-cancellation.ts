import { computeTournamentAttemptFence } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { computeRelicGamePublications } from './compute-relic-game-publications.ts';
import type { RelicGameMutationService } from './relic-game-mutation-service.ts';
import { toRelicTournamentParticipation } from './relic-tournament.ts';

/** Cancellation publishes terminal participation; the accepted native save and scores remain unchanged. */
export function computeRelicTournamentCancellation(
    decision: RelicGameMutationService.Decision
): RelicGameMutationService.Computed {
    const { read, previous, guard, admissionNamespace } = decision;
    if (read.tournament === null) {
        throw new TypeError('Cancellation requires a private tournament attempt');
    }
    return {
        result: { status: 'applied', gameId: read.ingress.command.gameId },
        guard,
        save: null,
        tournamentWrite: { storage: computeTournamentAttemptFence(read.tournament, 'cancelled'), outbox: [] },
        ...computeRelicGamePublications({
            read,
            admissionNamespace,
            participation: toRelicTournamentParticipation(read.tournament),
            previous,
            next: previous,
            refusal: null
        })
    };
}
