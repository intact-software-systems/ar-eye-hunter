import assert from 'node:assert/strict';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { readApiV1ConfigurationEnvironment } from '../../src/configuration/read-api-v1-configuration-environment.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

Deno.test('room-owned catalog is mandatory even when every other configuration field is valid', () => {
    const input = validDecodeApiV1ConfigurationInput();
    const defaults = input.defaultsSource;
    if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults) || !('group' in defaults)) {
        throw new Error('Expected a group configuration fixture');
    }
    const group = defaults.group;
    if (group === null || typeof group !== 'object' || Array.isArray(group)) {
        throw new Error('Expected a group configuration fixture');
    }
    Reflect.deleteProperty(group, 'roomOwnedAppDataBindings');
    input.environmentSource = {};
    assert.throws(() => decodeApiV1Configuration(input), /roomOwnedAppDataBindings/);
});

Deno.test('room-owned catalog preserves exact database-wide identities and freezes resolved values', () => {
    const binding = { applicationId: 'inventory', workspaceId: 'primary', namespace: 'stock-room-data', storeName: 'saves' };
    const environment = readApiV1ConfigurationEnvironment({
        get: (name) => name === 'RALLAR_ROOM_OWNED_APP_DATA_BINDINGS_JSON' ? JSON.stringify([binding]) : undefined
    });
    const configuration = decodeApiV1Configuration({ ...validDecodeApiV1ConfigurationInput(), environmentSource: environment.environmentSource });
    assert.deepEqual(configuration.group.roomOwnedAppDataBindings, [binding]);
    assert(Object.isFrozen(configuration.group.roomOwnedAppDataBindings));
    assert(Object.isFrozen(configuration.group.roomOwnedAppDataBindings[0]));
});

Deno.test('room-owned catalog rejects malformed and duplicate store ownership and accepts explicit empty ownership', () => {
    const binding = { applicationId: 'inventory', workspaceId: 'primary', namespace: 'stock-room-data', storeName: 'saves' };
    for (const catalog of [null, {}, [binding, { ...binding, workspaceId: 'other' }], [{ ...binding, namespace: ' padded ' }], [{ ...binding, extra: true }]]) {
        assert.throws(
            () => decodeApiV1Configuration({ ...validDecodeApiV1ConfigurationInput(), environmentSource: { group: { roomOwnedAppDataBindings: catalog } } }),
            /roomOwnedAppDataBindings/
        );
    }
    assert.deepEqual(
        decodeApiV1Configuration({ ...validDecodeApiV1ConfigurationInput(), environmentSource: { group: { roomOwnedAppDataBindings: [] } } }).group
            .roomOwnedAppDataBindings,
        []
    );
});
