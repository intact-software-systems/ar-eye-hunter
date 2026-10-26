import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { readApiConfig } from '@shared-web/browser/connection/connection-http-api.ts';

const SERVED = {
    apiBaseUrl: 'https://api.example.test',
    wsBaseUrl: 'wss://api.example.test',
    endpoints: { createWs: '/api/ws/:id' },
    serverPeerId: 'default-qbox-server'
};

afterEach(() => {
    configureApiClient({ apiBaseUrl: '' });
    vi.unstubAllGlobals();
});

describe('connection configuration request authority', () => {
    it('uses the API host when the SPA is hosted elsewhere', async () => {
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
        vi.stubGlobal('location', { href: 'https://game.example.test/play/' });
        vi.stubGlobal('fetch', async () => Response.json(SERVED));

        await expect(readApiConfig({ authSession: null })).resolves.toEqual(SERVED);
    });

    it.each(['', '/gateway', 'gateway'])('resolves the relative API base %s against the page URL', async (apiBaseUrl) => {
        configureApiClient({ apiBaseUrl });
        vi.stubGlobal('location', { href: 'https://game.example.test/play/' });
        const served = { ...SERVED, wsBaseUrl: 'wss://game.example.test' };
        vi.stubGlobal('fetch', async () => Response.json(served));

        await expect(readApiConfig({ authSession: null })).resolves.toEqual(served);
    });

    it('uses the document base authority for relative fetch requests', async () => {
        configureApiClient({ apiBaseUrl: '/gateway' });
        vi.stubGlobal('location', { href: 'https://game.example.test/play/' });
        vi.stubGlobal('document', { baseURI: 'https://proxy.example.test/game/' });
        const served = { ...SERVED, wsBaseUrl: 'wss://proxy.example.test' };
        vi.stubGlobal('fetch', async () => Response.json(served));

        await expect(readApiConfig({ authSession: null })).resolves.toEqual(served);
    });

    it('retains the requested authority when configuration changes during the response', async () => {
        const entered = Promise.withResolvers<void>();
        const response = Promise.withResolvers<Response>();
        configureApiClient({ apiBaseUrl: 'https://original.example.test' });
        vi.stubGlobal('fetch', async () => {
            entered.resolve();
            return response.promise;
        });
        const pending = readApiConfig({ authSession: null });
        const rejected = expect(pending).rejects.toThrow(
            'WebSocket host "replacement.example.test" does not match API host "original.example.test".'
        );
        await entered.promise;
        configureApiClient({ apiBaseUrl: 'https://replacement.example.test' });
        response.resolve(Response.json({ ...SERVED, wsBaseUrl: 'wss://replacement.example.test' }));

        await rejected;
    });

    it('rejects invalid API configuration without exposing embedded secrets', async () => {
        configureApiClient({ apiBaseUrl: 'https://user:hidden@[invalid' });
        vi.stubGlobal('fetch', async () => Response.json(SERVED));

        await expect(readApiConfig({ authSession: null })).rejects.toThrow('The configured Rallar API base URL is invalid.');
    });
});
