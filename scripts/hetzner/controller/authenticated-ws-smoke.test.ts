import assert from 'node:assert/strict';
import {
    buildAuthenticatedWsUrl,
    readAuthenticatedWsSmokeConfig,
    validateAuthenticatedWsConfig,
} from './authenticated-ws-smoke.ts';

Deno.test('authenticated WS smoke config is disabled until credentials are configured', () => {
    const config = readAuthenticatedWsSmokeConfig(fakeEnv({}));

    assert.equal(config.enabled, false);
    assert.match(config.reason ?? '', /RALLAR_SMOKE_USERNAME/);
});

Deno.test('authenticated WS smoke config reads public API and blackbox defaults', () => {
    const config = readAuthenticatedWsSmokeConfig(
        fakeEnv({
            RALLAR_API_HOST: 'api.example.test',
            RALLAR_BLACKBOX_HOST: 'blackbox.example.test',
            RALLAR_SMOKE_USERNAME: 'alice',
            RALLAR_SMOKE_PASSWORD: 'secret',
        }),
    );

    assert.deepEqual(config, {
        enabled: true,
        apiBaseUrl: 'https://api.example.test',
        origin: 'https://blackbox.example.test',
        username: 'alice',
        password: 'secret',
        timeoutMs: 10_000,
    });
});

Deno.test('authenticated WS smoke rejects insecure ws for an HTTPS API', () => {
    assert.throws(
        () =>
            validateAuthenticatedWsConfig(
                {
                    enabled: true,
                    apiBaseUrl: 'https://api.example.test',
                    origin: 'https://blackbox.example.test',
                    username: 'alice',
                    password: 'secret',
                    timeoutMs: 10_000,
                },
                {
                    apiBaseUrl: 'https://api.example.test',
                    wsBaseUrl: 'ws://api.example.test',
                },
            ),
        /CONFIG: apiBaseUrl is HTTPS but wsBaseUrl is not WSS/,
    );
});

Deno.test('authenticated WS smoke builds the ticketed websocket URL', () => {
    assert.equal(
        buildAuthenticatedWsUrl(
            {
                enabled: true,
                apiBaseUrl: 'https://api.example.test',
                origin: 'https://blackbox.example.test',
                username: 'alice',
                password: 'secret',
                timeoutMs: 10_000,
            },
            {
                apiBaseUrl: 'https://api.example.test',
                wsBaseUrl: 'wss://api.example.test/',
            },
            {
                sessionId: 'session/a',
                ticket: 'ticket?b',
            },
        ),
        'wss://api.example.test/api/ws/session%2Fa?ticket=ticket%3Fb',
    );
});

function fakeEnv(values: Readonly<Record<string, string | undefined>>): {
    get(name: string): string | undefined;
} {
    return {
        get(name: string): string | undefined {
            return values[name];
        },
    };
}
