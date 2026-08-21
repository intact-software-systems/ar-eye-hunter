import assert from 'node:assert/strict';
import { getApiAppInboxServiceOptions } from '../../src/services/timing-service.ts';

Deno.test('API app inbox options are read from environment', () => {
    const original = snapshotEnv([
        'RALLAR_APP_INBOX_PHASE_TIMING',
        'RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS',
        'RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS',
        'RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS',
        'RALLAR_APP_INBOX_WAIT_JITTER_RATIO'
    ]);

    try {
        Deno.env.set('RALLAR_APP_INBOX_PHASE_TIMING', 'true');
        Deno.env.set('RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS', '45000');
        Deno.env.set('RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS', '125');
        Deno.env.set('RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS', '750');
        Deno.env.set('RALLAR_APP_INBOX_WAIT_JITTER_RATIO', '0.05');

        assert.deepEqual(getApiAppInboxServiceOptions(), {
            phaseTiming: true,
            waitMaxElapsedMsecs: 45_000,
            waitRetryIntervalMsecs: 125,
            waitMaxRetryIntervalMsecs: 750,
            waitJitterRatio: 0.05
        });
    }
    finally {
        restoreEnv(original);
    }
});

Deno.test('API app inbox options fall back when environment is unset or invalid', () => {
    const original = snapshotEnv([
        'RALLAR_APP_INBOX_PHASE_TIMING',
        'RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS',
        'RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS',
        'RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS',
        'RALLAR_APP_INBOX_WAIT_JITTER_RATIO'
    ]);

    try {
        Deno.env.delete('RALLAR_APP_INBOX_PHASE_TIMING');
        Deno.env.set('RALLAR_APP_INBOX_WAIT_MAX_ELAPSED_MS', 'not-a-number');
        Deno.env.delete('RALLAR_APP_INBOX_WAIT_RETRY_INTERVAL_MS');
        Deno.env.delete('RALLAR_APP_INBOX_WAIT_MAX_RETRY_INTERVAL_MS');
        Deno.env.delete('RALLAR_APP_INBOX_WAIT_JITTER_RATIO');

        assert.deepEqual(getApiAppInboxServiceOptions(), {
            phaseTiming: false,
            waitMaxElapsedMsecs: 30_000,
            waitRetryIntervalMsecs: 250,
            waitMaxRetryIntervalMsecs: 1_000,
            waitJitterRatio: 0.1
        });
    }
    finally {
        restoreEnv(original);
    }
});

function snapshotEnv(names: string[]): Map<string, string | undefined> {
    return new Map(names.map((name) => [name, Deno.env.get(name)]));
}

function restoreEnv(values: Map<string, string | undefined>): void {
    for (const [name, value] of values.entries()) {
        if (value === undefined) {
            Deno.env.delete(name);
        }
        else {
            Deno.env.set(name, value);
        }
    }
}
