import assert from 'node:assert/strict';

import type { ApiConfig } from '@shared/api/api-config.ts';
import type { ApiV1PublicApiConfiguration } from '../../src/configuration/api-v1-configuration.ts';
import { toApiV1PublicConfiguration } from '../../src/configuration/to-api-v1-public-configuration.ts';

Deno.test('public configuration projection returns exactly the browser contract', () => {
    const publicApi: ApiV1PublicApiConfiguration = {
        apiBaseUrl: 'https://api.example.test',
        wsBaseUrl: 'wss://api.example.test'
    };
    const projected: ApiConfig = toApiV1PublicConfiguration(publicApi);

    assert.deepEqual(projected, {
        apiBaseUrl: 'https://api.example.test',
        wsBaseUrl: 'wss://api.example.test',
        endpoints: {
            createWs: '/api/ws/:id'
        }
    });
    assert.deepEqual(Object.keys(projected).sort(), ['apiBaseUrl', 'endpoints', 'wsBaseUrl']);
});

Deno.test('public configuration projection input cannot contain a secret field', () => {
    const publicApi: ApiV1PublicApiConfiguration = {
        apiBaseUrl: 'https://api.example.test',
        wsBaseUrl: 'wss://api.example.test',
        // @ts-expect-error Secrets are not part of the projection input contract.
        credentialSecret: 'must-not-compile-as-public-input'
    };

    assert.equal(Object.hasOwn(toApiV1PublicConfiguration(publicApi), 'credentialSecret'), false);
});
