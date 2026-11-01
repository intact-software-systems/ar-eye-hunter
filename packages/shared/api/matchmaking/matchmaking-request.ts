import { requireExactKeys, requireOneOf, requireRecord, requireString } from '../exact-object-decoding.ts';
import type { StateScope } from '../state-types.ts';

export interface MatchmakingRequest {
    readonly action: 'start' | 'confirm' | 'cancel';
    readonly searchId: string;
}

export type MatchmakingRefusal = 'unauthorized' | 'search-not-current' | 'search-capacity' | 'search-ended';

export interface MatchmakingMutationResult {
    readonly scope: StateScope;
    readonly principalId: string;
    readonly requestId: string;
    readonly status: 'applied' | 'refused';
    readonly searchId: string | null;
    readonly code: MatchmakingRefusal | null;
}

export function decodeMatchmakingRequest(value: unknown): MatchmakingRequest {
    const request = requireRecord(value, 'Matchmaking request');
    requireExactKeys(request, ['action', 'searchId'], 'Matchmaking request');
    requireString(request.searchId, 'Search identity');
    if (request.searchId.length > 96) {
        throw new TypeError('Search identity must contain at most 96 characters');
    }
    return {
        action: requireOneOf(request.action, ['start', 'confirm', 'cancel'], 'Matchmaking action'),
        searchId: request.searchId
    };
}

export function decodeMatchmakingScope(value: unknown): StateScope {
    const scope = requireRecord(value, 'Matchmaking scope');
    requireExactKeys(scope, ['applicationId', 'workspaceId'], 'Matchmaking scope');
    requireString(scope.applicationId, 'Matchmaking application');
    requireString(scope.workspaceId, 'Matchmaking workspace');
    return { applicationId: scope.applicationId, workspaceId: scope.workspaceId };
}

export function decodeMatchmakingMutationResult(value: unknown): MatchmakingMutationResult {
    const result = requireRecord(value, 'Matchmaking result');
    requireExactKeys(result, ['scope', 'principalId', 'requestId', 'status', 'searchId', 'code'], 'Matchmaking result');
    const scope = decodeMatchmakingScope(result.scope);
    requireString(result.principalId, 'Matchmaking result account');
    requireString(result.requestId, 'Matchmaking result request');
    if (result.searchId !== null) {
        requireString(result.searchId, 'Matchmaking result search');
    }
    const status = requireOneOf(result.status, ['applied', 'refused'], 'Matchmaking result status');
    const code = result.code === null
        ? null
        : requireOneOf(
            result.code,
            ['unauthorized', 'search-not-current', 'search-capacity', 'search-ended'],
            'Matchmaking refusal'
        );
    if ((status === 'applied') !== (code === null)) {
        throw new TypeError('Matchmaking result and refusal disagree');
    }
    return {
        scope,
        principalId: result.principalId,
        requestId: result.requestId,
        status,
        searchId: result.searchId,
        code
    };
}
