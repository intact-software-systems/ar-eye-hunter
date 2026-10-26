import assert from 'node:assert/strict';

import { ApiV1ConfigurationError } from '../../src/configuration/api-v1-configuration-error.ts';
import type { ApiV1Configuration } from '../../src/configuration/api-v1-configuration.ts';
import { readApiV1Configuration } from '../../src/configuration/read-api-v1-configuration.ts';
import { reportApiV1Configuration } from '../../src/configuration/report-api-v1-configuration.ts';
import { validConfigurationEnvironment } from './api-v1-configuration-test-fixture.ts';

Deno.test('hardened startup rejects an advertised WebSocket host outside the public API authority', async () => {
    try {
        await readConfiguration({
            ...validConfigurationEnvironment('prod-hardened'),
            RALLAR_API_BASE_URL: 'https://login.example.test',
            RALLAR_WS_BASE_URL: 'wss://elsewhere.example.test'
        });
        assert.fail('Expected a configuration error for different API and WebSocket hosts.');
    }
    catch (error) {
        assert.ok(error instanceof ApiV1ConfigurationError);
        assert.deepEqual(
            error.issues.map(({ path, code }) => ({ path, code })),
            [{ path: 'publicApi.wsBaseUrl', code: 'websocket-host-mismatch' }]
        );
        assert.match(error.message, /login\.example\.test/);
        assert.match(error.message, /elsewhere\.example\.test/);
    }
});

Deno.test('hardened startup accepts the same public authority despite URL spelling and a separate SPA origin', async () => {
    const configuration = await readConfiguration({
        ...validConfigurationEnvironment('prod-hardened'),
        RALLAR_API_BASE_URL: 'https://API.example.test:443/base',
        RALLAR_WS_BASE_URL: 'wss://api.example.test/socket',
        CORS_ORIGINS: 'https://game.example.test'
    });

    assert.equal(configuration.profile.productionHardening, true);
    assert.deepEqual(configuration.http.corsOrigins, ['https://game.example.test']);
});

Deno.test('non-hardened startup emits a safe actionable warning while allowing configuration', async () => {
    for (const profile of ['dev', 'prod', 'prod-in-memory'] as const) {
        const configuration = await readConfiguration({
            ...validConfigurationEnvironment(profile),
            RALLAR_API_BASE_URL: 'https://login.example.test',
            RALLAR_WS_BASE_URL: 'wss://elsewhere.example.test'
        });
        const summaries: string[] = [];
        const warnings: string[] = [];

        reportApiV1Configuration(configuration, {
            log: (message: string) => summaries.push(message),
            warn: (message: string) => warnings.push(message)
        });

        assert.equal(JSON.parse(summaries[0]).profile, profile);
        assert.equal(warnings.length, 1);
        const warning = JSON.parse(warnings[0]);
        assert.equal(warning.event, 'api-v1.configuration-warning');
        assert.equal(warning.code, 'websocket-host-mismatch');
        assert.match(warning.message, /login\.example\.test/);
        assert.match(warning.message, /elsewhere\.example\.test/);
        assert.equal(warnings.join('').includes(configuration.authentication.credentialSecret), false);
    }
});

Deno.test('matching public hosts produce a startup summary without a mismatch warning', async () => {
    const configuration = await readConfiguration(validConfigurationEnvironment());
    const summaries: string[] = [];
    const warnings: string[] = [];

    reportApiV1Configuration(configuration, {
        log: (message: string) => summaries.push(message),
        warn: (message: string) => warnings.push(message)
    });

    assert.equal(JSON.parse(summaries[0]).event, 'api-v1.configuration');
    assert.deepEqual(warnings, []);
});

function readConfiguration(environment: Readonly<Record<string, string>>): Promise<ApiV1Configuration> {
    return readApiV1Configuration({
        environment: { get: (name) => environment[name] },
        hardwareConcurrency: 4,
        readTextFile: Deno.readTextFile,
        defaultsUrl: new URL('../../resources/configuration/defaults-config.json', import.meta.url),
        profileUrls: {
            dev: new URL('../../resources/configuration/dev-config.json', import.meta.url),
            prod: new URL('../../resources/configuration/prod-config.json', import.meta.url),
            'prod-hardened': new URL('../../resources/configuration/prod-hardened-config.json', import.meta.url),
            'prod-in-memory': new URL('../../resources/configuration/prod-in-memory-config.json', import.meta.url)
        },
        staticClientsUrl: new URL('../../resources/authorised-clients.json', import.meta.url)
    });
}
