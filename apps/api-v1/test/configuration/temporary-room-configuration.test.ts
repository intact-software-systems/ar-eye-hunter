import type { ApiV1ConfigurationSourceValue } from '../../src/configuration/decode-api-v1-configuration-source.ts';
import { readApiV1ConfigurationEnvironment } from '../../src/configuration/read-api-v1-configuration-environment.ts';
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

test('event organizers can be granted authority per application', () => {
    const input = validDecodeApiV1ConfigurationInput();
    const decode = (grants: ApiV1ConfigurationSourceValue) => decodeApiV1Configuration({ ...input,
        environmentSource: { group: { eventOrganizerIdsByApplication: grants } } }).group;
    assert.deepEqual(decode({ league: ['official'] }).eventOrganizerIdsByApplication, { league: ['official'] });
    for (const invalid of [{ league: 'official' }, { league: ['invalid/id'] }, { league: ['official', 'official'] }]) {
        assert.throws(() => decode(invalid));
    }
});

test('organizer handover uses a ten-minute window and accepts a positive deployment override', () => {
    const input = validDecodeApiV1ConfigurationInput();
    assert.equal(decodeApiV1Configuration(input).group.eventHandoverWindowMs, 600_000);
    const decode = (eventHandoverWindowMs: number) => decodeApiV1Configuration({ ...input, environmentSource: { group: { eventHandoverWindowMs } } });
    const { environmentSource } = readApiV1ConfigurationEnvironment({ RALLAR_EVENT_HANDOVER_WINDOW_MS: '2500' });
    assert.equal(decodeApiV1Configuration({ ...input, environmentSource }).group.eventHandoverWindowMs, 2500);
    assert.equal(decode(3000).group.eventHandoverWindowMs, 3000);
    assert.throws(() => decode(0));
});
