import { test } from 'bun:test';
import assert from 'node:assert/strict';

import defaultsSource from '../../resources/configuration/defaults-config.json' with { type: 'json' };

import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { readApiV1ConfigurationEnvironment } from '../../src/configuration/read-api-v1-configuration-environment.ts';
import { toApiBunServeOptions } from '../../src/runtime/to-api-bun-serve-options.ts';
import { validDecodeApiV1ConfigurationInput } from './api-v1-configuration-test-fixture.ts';

function decodeWithEnvironment(values: Record<string, string>) {
    const environment = readApiV1ConfigurationEnvironment(values);
    return decodeApiV1Configuration({
        ...validDecodeApiV1ConfigurationInput(),
        defaultsSource,
        environmentSource: { ...environment.environmentSource, group: { roomOwnedAppDataBindings: [] } }
    });
}

const handlers = {
    fetch: () => new Response('ok'),
    websocket: { message: () => undefined }
};

test('the server listens on every interface unless a host names its bind address, as local dev, CI and containers need', () => {
    const configuration = decodeWithEnvironment({});

    assert.equal(configuration.http.hostname, '0.0.0.0');
    assert.equal(toApiBunServeOptions(configuration, handlers).hostname, '0.0.0.0');
});

test('RALLAR_HTTP_HOSTNAME binds the server to the address a fronting proxy reaches, and Bun.serve receives it', () => {
    const configuration = decodeWithEnvironment({ RALLAR_HTTP_HOSTNAME: '127.0.0.1' });

    assert.equal(configuration.http.hostname, '127.0.0.1');
    assert.equal(toApiBunServeOptions(configuration, handlers).hostname, '127.0.0.1');
});

test('an empty bind address is a configuration error', () => {
    assert.throws(
        () => decodeWithEnvironment({ RALLAR_HTTP_HOSTNAME: ' ' }),
        (error) =>
            error instanceof ApiV1ConfigurationError &&
            error.issues.some((issue) => issue.path === 'http.hostname')
    );
});
