import { decodeTournamentGameProfiles } from '@shared-server/rallar-system/tournaments/tournament-game-profile.ts';
import type { ApiV1TournamentConfiguration } from './api-v1-configuration.ts';
import type { ApiV1ConfigurationValueDecoder } from './decode-api-v1-configuration-values.ts';

export function decodeApiV1Tournaments(decoder: ApiV1ConfigurationValueDecoder): ApiV1TournamentConfiguration {
    return {
        profiles: decodeProfiles(decoder),
        rateLimit: {
            windowMs: decoder.integer('tournaments.rateLimit.windowMs', 1, 3600000),
            requests: decoder.integer('tournaments.rateLimit.requests', 1, 10000)
        }
    };
}

function decodeProfiles(decoder: ApiV1ConfigurationValueDecoder): ApiV1TournamentConfiguration['profiles'] {
    try {
        return decodeTournamentGameProfiles(decoder.sourceValue('tournaments.profiles'));
    }
    catch {
        decoder.sourceIssue(
            'tournaments.profiles',
            'invalid-tournament-profiles',
            'Unique scoped tournament profiles with valid rules, grace and game-owner topics are required.'
        );
        // Aggregate startup diagnostics reject this configuration before any services are constructed.
        return [];
    }
}
