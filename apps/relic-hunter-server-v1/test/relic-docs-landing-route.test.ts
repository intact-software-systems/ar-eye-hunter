import { expect } from '@std/expect';
import { Hono } from 'hono';

import { initRelicDocsLandingRoute } from '../src/relic-docs-landing-route.ts';

Deno.test('Landing page links to both the Relic and Rallar API docs', async () => {
    const app = initRelicDocsLandingRoute(new Hono());

    for (const path of ['/', '/index.html']) {
        const response = await app.request(path);
        const html = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(html).toContain('href="/api/relic/docs"');
        expect(html).toContain('href="/api/docs"');
    }
});
