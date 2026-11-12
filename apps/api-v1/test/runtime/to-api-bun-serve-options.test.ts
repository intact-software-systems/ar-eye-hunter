import { test } from 'bun:test';
import assert from 'node:assert/strict';

import defaultsSource from '../../resources/configuration/defaults-config.json' with { type: 'json' };

import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { toApiBunServeOptions } from '../../src/runtime/to-api-bun-serve-options.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';

const BUN_DEFAULT_IDLE_TIMEOUT_SECONDS = 10;

const handlers = {
    fetch: () => new Response('ok'),
    websocket: { message: () => undefined }
};

function decodeWithCompletionWait(maxElapsedMs: number | undefined) {
    const input = { ...validDecodeApiV1ConfigurationInput(), defaultsSource };
    input.environmentSource = {
        group: { roomOwnedAppDataBindings: [] },
        ...(maxElapsedMs === undefined ? {} : { appInbox: { completionWait: { maxElapsedMs } } })
    };
    return decodeApiV1Configuration(input);
}

test('the HTTP idle bound outlasts the default AppInbox completion wait that a mutation request holds open', () => {
    const configuration = decodeWithCompletionWait(undefined);
    const options = toApiBunServeOptions(configuration, handlers);

    assert.equal(configuration.appInbox.completionWait.maxElapsedMs, 30_000);
    assert.ok(options.idleTimeout > BUN_DEFAULT_IDLE_TIMEOUT_SECONDS);
    assert.ok(options.idleTimeout * 1000 > configuration.appInbox.completionWait.maxElapsedMs);
    assert.equal(options.port, configuration.http.port);
});

test('the HTTP idle bound follows a configured completion wait instead of a second constant', () => {
    const short = toApiBunServeOptions(decodeWithCompletionWait(5_000), handlers).idleTimeout;
    const long = toApiBunServeOptions(decodeWithCompletionWait(120_000), handlers).idleTimeout;

    assert.ok(short * 1000 > 5_000);
    assert.ok(long * 1000 > 120_000);
    assert.equal(long - short, 115);
});

test('a completion wait that no Bun idle bound can outlast is a configuration error', () => {
    assert.throws(
        () => decodeWithCompletionWait(250_000),
        (error) =>
            error instanceof ApiV1ConfigurationError &&
            error.issues.some((issue) => issue.path === 'appInbox.completionWait.maxElapsedMs')
    );
});

test('a WebSocket past its backpressure limit closes instead of silently dropping frames into an open stream', () => {
    const options = toApiBunServeOptions(decodeWithCompletionWait(undefined), handlers);

    assert.equal(options.websocket.closeOnBackpressureLimit, true);
    assert.equal(options.websocket.message, handlers.websocket.message);
});
