import { jsonEquals } from '../../repository/state-utils.ts';
import { requireExactKeys, requireOneOf, requireRecord, requireString } from '../exact-object-decoding.ts';
import type { TournamentRef } from './tournament-types.ts';

export interface TournamentMutationResult {
    readonly ref: TournamentRef;
    readonly requestId: string;
    readonly status: 'applied' | 'refused';
    readonly code: string | null;
}

export function decodeTournamentMutationResult(
    value: unknown,
    expected: Pick<TournamentMutationResult, 'ref' | 'requestId'>
): TournamentMutationResult {
    const result = requireRecord(value, 'Tournament mutation result');
    requireExactKeys(result, ['ref', 'requestId', 'status', 'code'], 'Tournament mutation result');
    const status = requireOneOf(result.status, ['applied', 'refused'], 'Tournament result status');
    if (result.code !== null) {
        requireString(result.code, 'Tournament refusal');
    }
    if (
        !jsonEquals(result.ref, expected.ref) || result.requestId !== expected.requestId ||
        (status === 'applied') !== (result.code === null)
    ) {
        throw new TypeError('Tournament result differs from its command or status');
    }
    return { ref: expected.ref, requestId: expected.requestId, status, code: result.code };
}
