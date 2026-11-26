import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

test('temporary rooms require an application opt-in and resolve bounded per-app settings at startup', () => {
    const input = validDecodeApiV1ConfigurationInput();
    assert.deepEqual(decodeApiV1Configuration(input).group.temporaryRoomPoliciesByApplication, {});
    const enabled = decodeApiV1Configuration({ ...input, environmentSource: { group: {
        temporaryRoomPoliciesByApplication: { casual: {}, league: { maximumCapacity: 8, defaultCapacity: 6, lifetimeMs: 20_000, emptyReturnWindowMs: 5_000 } }
    } } });
    assert.deepEqual(enabled.group.temporaryRoomPoliciesByApplication.casual, {
        defaultCapacity: 4, maximumCapacity: 4, lifetimeMs: 14_400_000, emptyReturnWindowMs: 900_000,
        creationLimit: 10, creationWindowMs: 60_000
    });
    assert.equal(enabled.group.temporaryRoomPoliciesByApplication.league.defaultCapacity, 6);
    for (const invalid of [{ defaultCapacity: 5 }, { maximumCapacity: 0 }, { creationLimit: null }, { lifetimeMs: Number.MAX_SAFE_INTEGER },
        { lifetimeMs: 20, emptyReturnWindowMs: 21 }, { maxCapacity: 8 }]) {
        assert.throws(() => decodeApiV1Configuration({ ...input, environmentSource: {
            group: { temporaryRoomPoliciesByApplication: { league: invalid } }
        } }));
    }
});
