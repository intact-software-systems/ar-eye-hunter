import assert from 'node:assert/strict';

import {
    groupStateDisseminationStartupLogLine,
    readApiGroupStateDisseminationConfig
} from '../src/runtime/group-formation/group-state-dissemination-config.ts';

Deno.test('group-state dissemination defaults to delta-primary', () => {
    assert.deepEqual(
        readApiGroupStateDisseminationConfig(fakeEnv({})),
        { dissemination: 'delta-primary' }
    );
});

Deno.test('group-state dissemination accepts only the two explicit modes and trims input', () => {
    assert.deepEqual(
        readApiGroupStateDisseminationConfig(
            fakeEnv({ RALLAR_GROUP_STATE_DISSEMINATION: ' delta-primary ' })
        ),
        { dissemination: 'delta-primary' }
    );
    assert.deepEqual(
        readApiGroupStateDisseminationConfig(
            fakeEnv({ RALLAR_GROUP_STATE_DISSEMINATION: 'dual-emit' })
        ),
        { dissemination: 'dual-emit' }
    );
    // The retired mode is rejected like any other unknown value rather than
    // silently accepted or mapped onto a survivor.
    for (const rejected of ['delta', 'snapshot-per-change']) {
        assert.throws(
            () =>
                readApiGroupStateDisseminationConfig(
                    fakeEnv({ RALLAR_GROUP_STATE_DISSEMINATION: rejected })
                ),
            /RALLAR_GROUP_STATE_DISSEMINATION must be one of dual-emit, delta-primary/
        );
    }
});

Deno.test('group-state dissemination startup log exposes the active mode', () => {
    assert.equal(
        groupStateDisseminationStartupLogLine({ dissemination: 'dual-emit' }),
        'Rallar API-v1 group-state dissemination: dual-emit'
    );
});

function fakeEnv(values: Readonly<Record<string, string | undefined>>) {
    return {
        get(name: string): string | undefined {
            return values[name];
        }
    };
}
