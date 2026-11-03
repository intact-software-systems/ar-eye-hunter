import assert from 'node:assert/strict';
import defaultsSource from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

Deno.test('matchmaking defaults and per-application overrides are explicit bounded configuration', () => {
    const input = { ...validDecodeApiV1ConfigurationInput(), defaultsSource };
    const configuration = decodeApiV1Configuration(input);
    assert.ok('matchmaking' in configuration);
    assert.deepEqual(configuration.matchmaking, {
        defaultPolicy: { players: 2, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 },
        policiesByApplication: {},
        rateLimit: { windowMs: 60000, requests: 30 }
    });
    input.environmentSource = {
        matchmaking: {
            defaultPolicy: { searchTimeoutMs: 60000 },
            policiesByApplication: { 'another-game': { players: 4, searchTimeoutMs: 90000, confirmationTimeoutMs: 20000, maxSearching: 128 } }
        }
    };
    const changed = decodeApiV1Configuration(input);
    assert.ok('matchmaking' in changed);
    assert.deepEqual(changed.matchmaking, {
        defaultPolicy: { players: 2, searchTimeoutMs: 60000, confirmationTimeoutMs: 30000, maxSearching: 256 },
        policiesByApplication: { 'another-game': { players: 4, searchTimeoutMs: 90000, confirmationTimeoutMs: 20000, maxSearching: 128 } },
        rateLimit: { windowMs: 60000, requests: 30 }
    });
});

Deno.test('matchmaking configuration rejects invalid bounds, incomplete game policies and unknown settings', () => {
    for (
        const matchmaking of [
            { defaultPolicy: { players: 1 } },
            { defaultPolicy: { searchTimeoutMs: 600001 } },
            { defaultPolicy: { confirmationTimeoutMs: 0 } },
            { defaultPolicy: { maxSearching: 1025 } },
            { policiesByApplication: { game: { players: 2 } } },
            { policiesByApplication: { '../game': { players: 2, searchTimeoutMs: 1000, confirmationTimeoutMs: 1000, maxSearching: 16 } } },
            { rateLimit: { requests: 0 } },
            { automaticRequeue: true }
        ]
    ) {
        const input = { ...validDecodeApiV1ConfigurationInput(), defaultsSource, environmentSource: { matchmaking } };
        assert.throws(
            () => decodeApiV1Configuration(input),
            (error) => error instanceof ApiV1ConfigurationError && error.issues.some((issue) => issue.path.startsWith('matchmaking'))
        );
    }
});
