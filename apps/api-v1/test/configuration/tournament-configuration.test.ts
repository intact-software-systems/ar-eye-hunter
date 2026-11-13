import { test } from 'bun:test';
import assert from 'node:assert/strict';
import defaultsSource from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { readApiV1ConfigurationEnvironment } from '../../src/configuration/read-api-v1-configuration-environment.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

const profile = {
    scope: { applicationId: 'game', workspaceId: 'default' },
    rulesId: 'native-v1',
    noShowGraceMs: 600000,
    gameLifecycleTopic: 'app:game:tournament-start'
};

test('tournament profiles are explicitly configured and retain their per-game no-show grace', () => {
    const input = { ...validDecodeApiV1ConfigurationInput(), defaultsSource };
    const defaults = decodeApiV1Configuration(input);
    assert.deepEqual(defaults.tournaments, { profiles: [], rateLimit: { windowMs: 60000, requests: 60 } });
    const configured = decodeApiV1Configuration({ ...input, environmentSource: { tournaments: { profiles: [profile] } } });
    assert.deepEqual(configured.tournaments.profiles, [profile]);
});

test('tournament configuration rejects ambiguous ownership and malformed profiles before startup', () => {
    for (
        const tournaments of [
            { profiles: [profile, profile] },
            { profiles: [{ ...profile, noShowGraceMs: 0 }] },
            { profiles: [{ ...profile, gameLifecycleTopic: 'public-room' }] },
            { profiles: [{ ...profile, extra: true }] },
            { rateLimit: { requests: 0 } }
        ]
    ) {
        assert.throws(
            () => decodeApiV1Configuration({ ...validDecodeApiV1ConfigurationInput(), defaultsSource, environmentSource: { tournaments } }),
            (error) => error instanceof ApiV1ConfigurationError && error.issues.some((issue) => issue.path.startsWith('tournaments'))
        );
    }
});

test('tournament profiles can be supplied by deployment environment without game-specific API code', () => {
    const environment = readApiV1ConfigurationEnvironment({
        RALLAR_TOURNAMENT_PROFILES_JSON: JSON.stringify([profile])
    });
    assert.deepEqual(environment.environmentSource.tournaments, { profiles: [profile] });
});
