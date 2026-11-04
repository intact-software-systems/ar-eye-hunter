import {
    requireEpoch,
    requireExactKeys,
    requireRecord
} from '@shared/api/exact-object-decoding.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import { decodeTournamentRef } from '@shared/api/tournaments/decode-tournament-match-binding.ts';
import { decodeTournamentRequest } from '@shared/api/tournaments/tournament-request.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { decodeTournamentGameProfile } from './tournament-game-profile.ts';
import { decodeTournamentActor } from './tournament-repository.ts';
import type { TournamentService } from './tournament-service.ts';

export function decodeTournamentCommand(value: unknown): TournamentService.Command {
    const command = requireRecord(value, 'Tournament command');
    requireExactKeys(command, ['ref', 'requestId', 'actor', 'request', 'materialized'], 'Tournament command');
    const ref = decodeTournamentRef(command.ref);
    const rawRequest = requireRecord(command.request, 'Tournament command request');
    if (rawRequest.type === 'reconcile') {
        requireExactKeys(rawRequest, ['type'], 'Tournament reconciliation');
    }
    const request = rawRequest.type === 'reconcile'
        ? { type: 'reconcile' as const }
        : decodeTournamentRequest(rawRequest);
    const actor = command.actor === null ? null : decodeTournamentActor(command.actor);
    if ((request.type === 'reconcile') !== (actor === null)) {
        throw new TypeError('Only server reconciliation has no tournament actor');
    }
    const materialized = command.materialized === null ? null : decodeMaterialized(command.materialized);
    if (materialized !== null && (request.type === 'schedule') !== (materialized.schedule !== null)) {
        throw new TypeError('Tournament capture differs from its scheduling intent');
    }
    if (
        materialized?.profile &&
        !jsonEquals(materialized.profile.scope, { applicationId: ref.applicationId, workspaceId: ref.workspaceId })
    ) {
        throw new TypeError('Tournament captured profile scope differs');
    }
    return { ref, requestId: assertValidRallarRouteId(command.requestId), actor, request, materialized };
}

function decodeMaterialized(value: unknown): TournamentService.Materialized {
    const facts = requireRecord(value, 'Tournament captured facts');
    requireExactKeys(facts, ['capturedAtEpochMs', 'profile', 'schedule'], 'Tournament captured facts');
    requireEpoch(facts.capturedAtEpochMs, 'Tournament capture time');
    let schedule: TournamentService.ScheduleIdentity | null = null;
    if (facts.schedule !== null) {
        const ids = requireRecord(facts.schedule, 'Tournament schedule identities');
        requireExactKeys(ids, ['attemptId', 'roomId', 'gameId'], 'Tournament schedule identities');
        schedule = {
            attemptId: assertValidRallarRouteId(ids.attemptId),
            roomId: assertValidRallarRouteId(ids.roomId),
            gameId: assertValidRallarRouteId(ids.gameId)
        };
        if (schedule.roomId !== schedule.gameId) {
            throw new TypeError('Tournament game identity must name its fresh room');
        }
    }
    return {
        capturedAtEpochMs: facts.capturedAtEpochMs,
        profile: facts.profile === null ? null : decodeTournamentGameProfile(facts.profile),
        schedule
    };
}
