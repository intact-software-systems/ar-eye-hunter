import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';

import { readRelicHunterServerConfiguration } from '../src/relic-hunter-server-configuration.ts';

const AUTHENTICATION_SECRET = 'relic-configuration-test-secret-at-least-32-characters';

describe('Relic Hunter server configuration', () => {
    it('resolves one immutable Relic and embedded API-v1 snapshot', async () => {
        const values: Record<string, string | undefined> = {
            RALLAR_API_CONFIGURATION_PROFILE: 'dev',
            RALLAR_AUTH_CREDENTIAL_SECRET: AUTHENTICATION_SECRET,
            PORT: '8090',
            CORS_ORIGINS: 'http://localhost:5175,https://relic.example.test',
            RALLAR_API_BASE_URL: 'https://relic.example.test',
            RALLAR_WS_BASE_URL: 'wss://relic.example.test',
            RELIC_REST_AUTH_MODE: 'group-policy',
            RELIC_AI_EXPEDITION_MODE: 'ollama',
            RELIC_AI_EXPEDITION_TIMEOUT_MS: '2500',
            RELIC_AI_EXPEDITION_OLLAMA_BASE_URL: 'http://ollama.internal:11434',
            RELIC_AI_EXPEDITION_OLLAMA_MODEL: 'llama3.2'
        };
        const reads = new Map<string, number>();
        const configuration = await readRelicHunterServerConfiguration({
            environment: {
                get(name) {
                    reads.set(name, (reads.get(name) ?? 0) + 1);
                    return values[name];
                }
            },
            readTextFile: Deno.readTextFile,
            defaultsUrl: apiV1ResourceUrl('defaults-config.json'),
            profileUrls: {
                dev: apiV1ResourceUrl('dev-config.json'),
                prod: apiV1ResourceUrl('prod-config.json'),
                'prod-hardened': apiV1ResourceUrl('prod-hardened-config.json'),
                'prod-in-memory': apiV1ResourceUrl('prod-in-memory-config.json')
            },
            staticClientsUrl: new URL('../../api-v1/resources/authorised-clients.json', import.meta.url),
            relicDefaultsUrl: relicResourceUrl('defaults-config.json'),
            relicProfileUrls: {
                prod: relicResourceUrl('prod-config.json'),
                'prod-hardened': relicResourceUrl('prod-hardened-config.json')
            }
        });

        expect(configuration.http).toBe(configuration.apiV1.http);
        expect(configuration.http).toEqual({
            port: 8090,
            corsOrigins: ['http://localhost:5175', 'https://relic.example.test'],
            preflightMaxAgeSeconds: 600
        });
        expect(configuration.restAuthorization).toEqual({ mode: 'group-policy' });
        expect(configuration.expeditionAi).toEqual({
            mode: 'ollama',
            timeoutMs: 2500,
            ollamaBaseUrl: 'http://ollama.internal:11434',
            ollamaModel: 'llama3.2'
        });
        expect(configuration.browser).toEqual({
            apiBaseUrl: 'https://relic.example.test',
            wsBaseUrl: 'wss://relic.example.test',
            endpoints: { createWs: '/api/ws/:id' }
        });
        expect(reads.get('RALLAR_API_CONFIGURATION_PROFILE')).toBe(1);
        expect(reads.get('PORT')).toBe(1);
        expect(reads.get('CORS_ORIGINS')).toBe(1);
        expect(reads.get('RALLAR_API_BASE_URL')).toBe(1);
        expect(reads.get('RALLAR_WS_BASE_URL')).toBe(1);
        expect(reads.get('RELIC_REST_AUTH_MODE')).toBe(1);
        expect(reads.get('RELIC_AI_EXPEDITION_MODE')).toBe(1);
        expect(reads.get('RELIC_AI_EXPEDITION_TIMEOUT_MS')).toBe(1);
        expect(reads.get('RELIC_AI_EXPEDITION_OLLAMA_BASE_URL')).toBe(1);
        expect(reads.get('RELIC_AI_EXPEDITION_OLLAMA_MODEL')).toBe(1);

        values.PORT = '9999';
        values.RELIC_REST_AUTH_MODE = 'authenticated';
        values.RELIC_AI_EXPEDITION_MODE = 'off';
        expect(configuration.http.port).toBe(8090);
        expect(configuration.restAuthorization.mode).toBe('group-policy');
        expect(configuration.expeditionAi.mode).toBe('ollama');
        expect(Object.isFrozen(configuration)).toBe(true);
        expect(Object.isFrozen(configuration.expeditionAi)).toBe(true);
    });

    it('projects only public API values into the browser configuration', async () => {
        const configuration = await readConfiguration({});
        const serializedBrowserConfiguration = JSON.stringify(configuration.browser);

        expect(Object.keys(configuration.browser).sort()).toEqual([
            'apiBaseUrl',
            'endpoints',
            'wsBaseUrl'
        ]);
        expect(serializedBrowserConfiguration).not.toContain(AUTHENTICATION_SECRET);
        expect(serializedBrowserConfiguration).not.toContain('credentialSecret');
        expect(serializedBrowserConfiguration).not.toContain('database');
        expect(serializedBrowserConfiguration).not.toContain('ollama');
    });

    it('rejects invalid Relic-only settings at the application boundary', async () => {
        await expect(readConfiguration({ RELIC_REST_AUTH_MODE: 'Group-Policy' }))
            .rejects.toThrow('RELIC_REST_AUTH_MODE');
        await expect(readConfiguration({ RELIC_AI_EXPEDITION_MODE: 'enabled' }))
            .rejects.toThrow('RELIC_AI_EXPEDITION_MODE');
        await expect(readConfiguration({ RELIC_AI_EXPEDITION_TIMEOUT_MS: '0' }))
            .rejects.toThrow('RELIC_AI_EXPEDITION_TIMEOUT_MS');
        await expect(readConfiguration({
            RELIC_AI_EXPEDITION_OLLAMA_BASE_URL: 'file:///tmp/model'
        })).rejects.toThrow('RELIC_AI_EXPEDITION_OLLAMA_BASE_URL');
    });

    it('defaults production profiles to group-policy without a Relic environment override', async () => {
        const production = await readConfiguration(productionOverrides('prod'));
        const hardened = await readConfiguration(productionOverrides('prod-hardened'));

        expect(production.restAuthorization).toEqual({ mode: 'group-policy' });
        expect(hardened.restAuthorization).toEqual({ mode: 'group-policy' });
    });

    it('applies an explicit Relic policy after the convenient production profile', async () => {
        const configuration = await readConfiguration({
            ...productionOverrides('prod'),
            RELIC_REST_AUTH_MODE: 'authenticated'
        });

        expect(configuration.restAuthorization).toEqual({ mode: 'authenticated' });
    });

    it('requires group policy when the embedded API enables production hardening', async () => {
        await expect(readConfiguration({
            ...productionOverrides('prod-hardened'),
            RELIC_REST_AUTH_MODE: 'authenticated'
        })).rejects.toThrow(
            'RELIC_REST_AUTH_MODE must be group-policy when production hardening is enabled.'
        );
    });
});

async function readConfiguration(
    overrides: Readonly<Record<string, string>>
) {
    const values: Readonly<Record<string, string>> = {
        RALLAR_API_CONFIGURATION_PROFILE: 'dev',
        RALLAR_AUTH_CREDENTIAL_SECRET: AUTHENTICATION_SECRET,
        ...overrides
    };
    return await readRelicHunterServerConfiguration({
        environment: { get: (name) => values[name] },
        readTextFile: Deno.readTextFile,
        defaultsUrl: apiV1ResourceUrl('defaults-config.json'),
        profileUrls: {
            dev: apiV1ResourceUrl('dev-config.json'),
            prod: apiV1ResourceUrl('prod-config.json'),
            'prod-hardened': apiV1ResourceUrl('prod-hardened-config.json'),
            'prod-in-memory': apiV1ResourceUrl('prod-in-memory-config.json')
        },
        staticClientsUrl: new URL('../../api-v1/resources/authorised-clients.json', import.meta.url),
        relicDefaultsUrl: relicResourceUrl('defaults-config.json'),
        relicProfileUrls: {
            prod: relicResourceUrl('prod-config.json'),
            'prod-hardened': relicResourceUrl('prod-hardened-config.json')
        }
    });
}

function apiV1ResourceUrl(fileName: string): URL {
    return new URL(`../../api-v1/resources/configuration/${fileName}`, import.meta.url);
}

function relicResourceUrl(fileName: string): URL {
    return new URL(`../resources/configuration/${fileName}`, import.meta.url);
}

function productionOverrides(profile: 'prod' | 'prod-hardened'): Readonly<Record<string, string>> {
    return {
        RALLAR_API_CONFIGURATION_PROFILE: profile,
        AUTH_ADMIN_CLIENT_IDS: 'production-operator',
        DATABASE_URL: 'postgres://configuration-test@database.example.test/rallar',
        METERED_APP_NAME: 'rallar-production',
        METERED_API_KEY: 'metered-configuration-test-secret',
        METERED_REGION: 'eu',
        RALLAR_BLACK_BOX_OPERATOR_CLIENT_IDS: 'production-operator',
        RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET: 'operator-configuration-test-secret'
    };
}
