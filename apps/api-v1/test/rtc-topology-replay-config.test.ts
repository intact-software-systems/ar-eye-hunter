import assert from 'node:assert/strict';

import {
    readApiRtcTopologyReplayConfig,
    rtcTopologyReplayStartupLogLine,
    shouldStartApiQueueWorkers
} from '../src/runtime/rtc-topology/rtc-topology-replay-config.ts';

Deno.test('RTC topology replay and queue workers default enabled after cutover', () => {
    assert.deepEqual(
        readApiRtcTopologyReplayConfig(fakeEnv({}), { sqlBackend: 'postgres' }),
        { replay: 'enabled', queueWorkers: 'enabled' }
    );
});

Deno.test('RTC topology replay configuration accepts only explicit enabled or disabled values', () => {
    assert.deepEqual(
        readApiRtcTopologyReplayConfig(
            fakeEnv({
                RALLAR_RTC_TOPOLOGY_REPLAY: ' enabled ',
                RALLAR_API_QUEUE_WORKERS: 'disabled'
            }),
            { sqlBackend: 'postgres' }
        ),
        { replay: 'enabled', queueWorkers: 'disabled' }
    );
    assert.throws(
        () =>
            readApiRtcTopologyReplayConfig(
                fakeEnv({ RALLAR_RTC_TOPOLOGY_REPLAY: 'true' }),
                { sqlBackend: 'postgres' }
            ),
        /RALLAR_RTC_TOPOLOGY_REPLAY must be one of disabled, enabled/
    );
    assert.throws(
        () =>
            readApiRtcTopologyReplayConfig(
                fakeEnv({ RALLAR_API_QUEUE_WORKERS: '' }),
                { sqlBackend: 'postgres' }
            ),
        /RALLAR_API_QUEUE_WORKERS must be one of enabled, disabled/
    );
});

Deno.test('queue-worker-disabled mode is rejected outside PostgreSQL', () => {
    assert.throws(
        () =>
            readApiRtcTopologyReplayConfig(
                fakeEnv({ RALLAR_API_QUEUE_WORKERS: 'disabled' }),
                { sqlBackend: 'pglite-memory' }
            ),
        /RALLAR_API_QUEUE_WORKERS=disabled requires RALLAR_SQL_BACKEND=postgres/
    );
});

Deno.test('queue worker startup follows only the validated queue-worker mode', () => {
    assert.equal(
        shouldStartApiQueueWorkers({ replay: 'disabled', queueWorkers: 'enabled' }),
        true
    );
    assert.equal(
        shouldStartApiQueueWorkers({ replay: 'enabled', queueWorkers: 'disabled' }),
        false
    );
});

Deno.test('RTC topology replay startup log exposes both non-secret modes', () => {
    assert.equal(
        rtcTopologyReplayStartupLogLine({ replay: 'disabled', queueWorkers: 'enabled' }),
        'Rallar API-v1 RTC topology replay: disabled; queue workers: enabled'
    );
});

function fakeEnv(values: Readonly<Record<string, string | undefined>>) {
    return {
        get(name: string): string | undefined {
            return values[name];
        }
    };
}
