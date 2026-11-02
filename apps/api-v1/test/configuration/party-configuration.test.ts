import assert from 'node:assert/strict';
import defaultsSource from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

Deno.test('party invitation lifetime and quotas are explicit bounded configuration', () => {
    const input = { ...validDecodeApiV1ConfigurationInput(), defaultsSource };
    const configuration = decodeApiV1Configuration(input);
    assert.ok('parties' in configuration);
    assert.deepEqual(configuration.parties, { maxInvitations: 16, invitationLifetimeMs: 600000, rateLimit: { windowMs: 60000, requests: 60 } });
    const changed = decodeApiV1Configuration({ ...input, environmentSource: { parties: { maxInvitations: 8, invitationLifetimeMs: 120000 } } });
    assert.ok('parties' in changed);
    assert.deepEqual(changed.parties, { maxInvitations: 8, invitationLifetimeMs: 120000, rateLimit: { windowMs: 60000, requests: 60 } });
});

Deno.test('party configuration rejects unbounded invitations and independent mismatched player capacity', () => {
    for (
        const parties of [{ maxInvitations: 0 }, { maxInvitations: 257 }, { invitationLifetimeMs: 999 }, { invitationLifetimeMs: 86400001 }, {
            rateLimit: { requests: 0 }
        }, { maxMembers: 4 }]
    ) {
        assert.throws(
            () => decodeApiV1Configuration({ ...validDecodeApiV1ConfigurationInput(), defaultsSource, environmentSource: { parties } }),
            (error) => error instanceof ApiV1ConfigurationError && error.issues.some((issue) => issue.path.startsWith('parties'))
        );
    }
});
