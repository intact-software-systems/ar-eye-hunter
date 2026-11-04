import { requireEpoch, requireExactKeys, requireOneOf, requireRecord } from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { decodeTournamentTitle } from './decode-tournament.ts';
import type { TournamentMatchBinding } from './tournament-types.ts';

/** HTTP intent: the owner materializes room/game identities and policy after admission. */
export type TournamentRequest =
    | { readonly type: 'create'; readonly title: string; }
    | { readonly type: 'register' | 'withdraw' | 'launch' | 'cancel'; }
    | {
        readonly type: 'check-in' | 'start';
        readonly slot: TournamentMatchBinding['slot'];
        readonly attemptId: string;
    }
    | {
        readonly type: 'schedule';
        readonly slot: TournamentMatchBinding['slot'];
        readonly scheduledAtEpochMs: number;
    };

export function decodeTournamentRequest(value: unknown): TournamentRequest {
    const request = requireRecord(value, 'Tournament request');
    if (request.type === 'create') {
        requireExactKeys(request, ['type', 'title'], 'Tournament creation');
        return { type: 'create', title: decodeTournamentTitle(request.title) };
    }
    if (request.type === 'schedule') {
        requireExactKeys(request, ['type', 'slot', 'scheduledAtEpochMs'], 'Tournament scheduling');
        requireEpoch(request.scheduledAtEpochMs, 'Tournament schedule');
        return {
            type: 'schedule',
            slot: requireOneOf(request.slot, ['semifinal-1', 'semifinal-2', 'final'], 'Tournament slot'),
            scheduledAtEpochMs: request.scheduledAtEpochMs
        };
    }
    if (request.type === 'check-in' || request.type === 'start') {
        requireExactKeys(request, ['type', 'slot', 'attemptId'], 'Tournament match request');
        return {
            type: request.type,
            slot: requireOneOf(request.slot, ['semifinal-1', 'semifinal-2', 'final'], 'Tournament slot'),
            attemptId: assertValidRallarRouteId(request.attemptId)
        };
    }
    requireExactKeys(request, ['type'], 'Tournament request');
    return {
        type: requireOneOf(request.type, ['register', 'withdraw', 'launch', 'cancel'], 'Tournament request type')
    };
}
