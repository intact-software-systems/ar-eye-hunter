import { requireExactKeys, requireRecord } from '../exact-object-decoding.ts';

export interface MatchmakingPolicy {
    readonly players: number;
    readonly searchTimeoutMs: number;
    readonly confirmationTimeoutMs: number;
    readonly maxSearching: number;
}

export function decodeMatchmakingPolicy(value: unknown): MatchmakingPolicy {
    const policy = requireRecord(value, 'Matchmaking policy');
    requireExactKeys(
        policy,
        ['players', 'searchTimeoutMs', 'confirmationTimeoutMs', 'maxSearching'],
        'Matchmaking policy'
    );
    return {
        players: decodeBoundedInteger(policy.players, [2, 16], 'Matchmaking players'),
        searchTimeoutMs: decodeBoundedInteger(policy.searchTimeoutMs, [1000, 600_000], 'Search timeout'),
        confirmationTimeoutMs: decodeBoundedInteger(
            policy.confirmationTimeoutMs,
            [1000, 120_000],
            'Confirmation timeout'
        ),
        maxSearching: decodeBoundedInteger(policy.maxSearching, [16, 1024], 'Search capacity')
    };
}

function decodeBoundedInteger(value: unknown, range: readonly [number, number], label: string): number {
    const [minimum, maximum] = range;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
}
