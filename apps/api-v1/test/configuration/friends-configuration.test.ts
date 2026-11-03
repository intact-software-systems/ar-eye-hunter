import assert from 'node:assert/strict';

import defaultsSource from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

Deno.test('friend capacity, invitation lifetime and mutation quota are explicit bounded configuration', () => {
    const input = { ...validDecodeApiV1ConfigurationInput(), defaultsSource };
    assert.deepEqual(decodeApiV1Configuration(input).friends, {
        maxContacts: 200,
        maxInvitations: 100,
        invitationLifetimeMs: 604_800_000,
        rateLimit: { windowMs: 60_000, requests: 60 }
    });
    input.environmentSource = { friends: { maxContacts: 20, maxInvitations: 10, invitationLifetimeMs: 600_000, rateLimit: { requests: 5 } } };
    assert.deepEqual(decodeApiV1Configuration(input).friends, {
        maxContacts: 20,
        maxInvitations: 10,
        invitationLifetimeMs: 600_000,
        rateLimit: { windowMs: 60_000, requests: 5 }
    });
});

Deno.test('friend configuration rejects invalid bounds and unknown settings', () => {
    for (
        const friends of [
            { maxContacts: 0 },
            { maxContacts: 1001 },
            { maxInvitations: 1.5 },
            { maxInvitations: 1001 },
            { invitationLifetimeMs: 2_592_000_001 },
            { rateLimit: { requests: 0 } },
            { rateLimit: { windowMs: -1 } },
            { discoverEveryone: true }
        ]
    ) {
        const input = validDecodeApiV1ConfigurationInput();
        input.environmentSource = { friends };
        assert.throws(
            () => decodeApiV1Configuration(input),
            (error) => error instanceof ApiV1ConfigurationError && error.issues.some((issue) => issue.path.startsWith('friends.'))
        );
    }
});
