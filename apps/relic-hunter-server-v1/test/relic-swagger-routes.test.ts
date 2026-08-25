import { expect } from '@std/expect';
import { Hono } from 'hono';

import { initRelicSwaggerRoutes } from '../src/relic-swagger-routes.ts';

Deno.test('Relic OpenAPI route publishes the forwarded public server URL', async () => {
    const app = initRelicSwaggerRoutes(new Hono());

    const response = await app.request('/api/relic/openapi.json', {
        headers: {
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'relic.rallar.example'
        }
    });
    const document = await response.json() as {
        readonly servers?: readonly { readonly url?: string; }[];
    };

    expect(response.status).toBe(200);
    expect(document.servers?.[0]?.url).toBe('https://relic.rallar.example');
});

Deno.test('Relic docs load the server-published OpenAPI document directly', async () => {
    const app = initRelicSwaggerRoutes(new Hono());

    const response = await app.request('/api/relic/docs');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('url: \'/api/relic/openapi.json\'');
    expect(html).not.toContain('requestInterceptor');
});
