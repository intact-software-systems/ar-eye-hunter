import assert from 'node:assert/strict';
import { createLocalIceConfig, readIceMode } from '../src/routes/ice-route.ts';

Deno.test('ICE mode defaults to Metered credentials', () => {
    assert.equal(readIceMode(fakeEnv({})), 'metered');
});

Deno.test('ICE mode accepts local no-cost configuration', () => {
    assert.equal(readIceMode(fakeEnv({ RALLAR_ICE_MODE: 'local' })), 'local');

    assert.deepEqual(createLocalIceConfig(1_000), {
        iceServers: [],
        expiresAtEpochMs: 301_000,
    });
});

Deno.test('ICE mode rejects unknown values', () => {
    assert.throws(
        () => readIceMode(fakeEnv({ RALLAR_ICE_MODE: 'paid-magic' })),
        /RALLAR_ICE_MODE must be one of metered, local/,
    );
});

function fakeEnv(
    values: Readonly<Record<string, string | undefined>>,
): { get(name: string): string | undefined } {
    return {
        get(name: string): string | undefined {
            return values[name];
        },
    };
}
