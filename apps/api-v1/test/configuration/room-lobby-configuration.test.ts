import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

test('ordinary rooms are the default and lobby settings apply only to named applications', () => {
    const input = validDecodeApiV1ConfigurationInput();
    const ordinary = decodeApiV1Configuration(input);
    assert.ok('group' in ordinary);
    assert.deepEqual(ordinary.group.roomLobbyPoliciesByApplication, {});
    const policy = { returnWindowMs: 120000, claimWindowMs: 60000 };
    const enabled = decodeApiV1Configuration({ ...input, environmentSource: {
        group: { roomLobbyPoliciesByApplication: { sports: policy } }
    } });
    assert.ok('group' in enabled);
    assert.deepEqual(enabled.group.roomLobbyPoliciesByApplication, { sports: policy });
    assert.throws(() => decodeApiV1Configuration({ ...input, environmentSource: {
        group: { roomLobbyPoliciesByApplication: { sports: { ...policy, returnWindowMs: 0 } } }
    } }));
});
