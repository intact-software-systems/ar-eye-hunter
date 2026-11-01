import { requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeMatchmakingPolicy, type MatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';
import { assertValidRallarRouteId } from '@shared/api/rallar-validation.ts';
import type { ApiV1MatchmakingConfiguration } from './api-v1-configuration.ts';
import type { ApiV1ConfigurationValueDecoder } from './decode-api-v1-configuration-values.ts';

export function decodeApiV1Matchmaking(decoder: ApiV1ConfigurationValueDecoder): ApiV1MatchmakingConfiguration {
    return {
        defaultPolicy: decodeDefaultPolicy(decoder),
        policiesByApplication: decodeApplicationPolicies(decoder),
        rateLimit: {
            windowMs: decoder.integer('matchmaking.rateLimit.windowMs', 1, 3600000),
            requests: decoder.integer('matchmaking.rateLimit.requests', 1, 10000)
        }
    };
}

function decodeDefaultPolicy(decoder: ApiV1ConfigurationValueDecoder): MatchmakingPolicy {
    const path = 'matchmaking.defaultPolicy';
    const values = Object.fromEntries(
        ['players', 'searchTimeoutMs', 'confirmationTimeoutMs', 'maxSearching'].map((
            field
        ) => [field, decoder.sourceValue(`${path}.${field}`)])
    );
    try {
        return decodeMatchmakingPolicy(values);
    }
    catch {
        decoder.sourceIssue(path, 'invalid-matchmaking-policy', 'An explicit bounded matchmaking policy is required.');
        // Invalid placeholders only support aggregate configuration diagnostics; throwIfIssues prevents startup.
        return { players: 0, searchTimeoutMs: 0, confirmationTimeoutMs: 0, maxSearching: 0 };
    }
}

function decodeApplicationPolicies(
    decoder: ApiV1ConfigurationValueDecoder
): Readonly<Record<string, MatchmakingPolicy>> {
    const path = 'matchmaking.policiesByApplication';
    try {
        const policies = requireRecord(decoder.sourceValue(path), 'Per-application matchmaking policies');
        return Object.fromEntries(
            Object.entries(policies).map((
                [applicationId, policy]
            ) => [assertValidRallarRouteId(applicationId), decodeMatchmakingPolicy(policy)])
        );
    }
    catch {
        decoder.sourceIssue(
            path,
            'invalid-matchmaking-policies',
            'Each application requires a valid route identity and complete bounded matchmaking policy.'
        );
        return {};
    }
}
