import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { DEFAULT_SERVER_SHUTDOWN_DEADLINE_MS } from '@shared-server/process/default-server-shutdown-deadline-ms.ts';

import defaultsSource from '../../resources/configuration/defaults-config.json' with { type: 'json' };

import { computeHttpIdleTimeoutSeconds } from '@shared-server/http/compute-http-idle-timeout-seconds.ts';
import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import { computeApiShutdownGraceMs } from '../../src/configuration/compute-api-shutdown-grace-ms.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { readApiV1ConfigurationEnvironment } from '../../src/configuration/read-api-v1-configuration-environment.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

function decodeWithEnvironment(values: Record<string, string>) {
    const environment = readApiV1ConfigurationEnvironment(values);
    return decodeApiV1Configuration({
        ...validDecodeApiV1ConfigurationInput(),
        defaultsSource,
        environmentSource: { ...environment.environmentSource, group: { roomOwnedAppDataBindings: [] } }
    });
}

test('the shutdown deadline defaults to the shared server deadline and leaves the drain room for a full completion wait', () => {
    const configuration = decodeWithEnvironment({});

    assert.equal(configuration.http.shutdownDeadlineMs, DEFAULT_SERVER_SHUTDOWN_DEADLINE_MS);
    assert.ok(
        computeApiShutdownGraceMs(configuration.http) >=
            computeHttpIdleTimeoutSeconds(configuration.appInbox.completionWait.maxElapsedMs) * 1000
    );
    assert.ok(computeApiShutdownGraceMs(configuration.http) < configuration.http.shutdownDeadlineMs);
});

test('RALLAR_SHUTDOWN_DEADLINE_MS sets the deadline a systemd unit pairs with its TimeoutStopSec', () => {
    assert.equal(decodeWithEnvironment({ RALLAR_SHUTDOWN_DEADLINE_MS: '90000' }).http.shutdownDeadlineMs, 90_000);
});

test('a deadline whose drain cannot outlast the HTTP idle bound is a configuration error', () => {
    assert.throws(
        () => decodeWithEnvironment({ RALLAR_SHUTDOWN_DEADLINE_MS: '30000' }),
        (error) =>
            error instanceof ApiV1ConfigurationError &&
            error.issues.some((issue) => issue.path === 'http.shutdownDeadlineMs')
    );
});
