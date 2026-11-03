import { requireExactKeys, requireOneOf, requireRecord, requireString } from '../exact-object-decoding.ts';
import { assertValidRallarRouteId } from '../rallar-validation.ts';
import { decodeStateScope } from '../state-types.ts';
import type { TournamentMatchBinding } from './tournament-types.ts';

export function decodeTournamentMatchBinding(value: unknown): TournamentMatchBinding {
    const binding = requireRecord(value, 'Tournament match binding');
    requireExactKeys(
        binding,
        ['tournamentRef', 'slot', 'attemptId', 'roomRef', 'gameId', 'rulesId', 'principalIds'],
        'Tournament match binding'
    );
    const ref = requireRecord(binding.tournamentRef, 'Tournament reference');
    requireExactKeys(ref, ['applicationId', 'workspaceId', 'tournamentId'], 'Tournament reference');
    const scope = decodeStateScope({ applicationId: ref.applicationId, workspaceId: ref.workspaceId });
    requireString(ref.tournamentId, 'Tournament identity');
    const room = requireRecord(binding.roomRef, 'Tournament room');
    requireExactKeys(room, ['applicationId', 'workspaceId', 'groupId'], 'Tournament room');
    requireString(room.groupId, 'Tournament room identity');
    if (room.applicationId !== scope.applicationId || room.workspaceId !== scope.workspaceId) {
        throw new TypeError('Tournament room scope differs');
    }
    requireString(binding.attemptId, 'Tournament attempt');
    requireString(binding.gameId, 'Tournament game');
    requireString(binding.rulesId, 'Tournament rules');
    const principals = binding.principalIds;
    if (!Array.isArray(principals) || principals.length !== 2) {
        throw new TypeError('Tournament match needs exactly two accounts');
    }
    const [first, second] = principals;
    requireString(first, 'First tournament account');
    requireString(second, 'Second tournament account');
    if (first === second) {
        throw new TypeError('Tournament accounts must differ');
    }
    return {
        tournamentRef: { ...scope, tournamentId: assertValidRallarRouteId(ref.tournamentId) },
        slot: requireOneOf(binding.slot, ['semifinal-1', 'semifinal-2', 'final'], 'Tournament slot'),
        attemptId: assertValidRallarRouteId(binding.attemptId),
        roomRef: { ...scope, groupId: assertValidRallarRouteId(room.groupId) },
        gameId: assertValidRallarRouteId(binding.gameId),
        rulesId: assertValidRallarRouteId(binding.rulesId),
        principalIds: [assertValidRallarRouteId(first), assertValidRallarRouteId(second)]
    };
}
