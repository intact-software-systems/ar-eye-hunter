import assert from 'node:assert/strict';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import { init, resolvePublicServerUrl } from '../src/routes/swagger-routes.ts';

Deno.test('swagger public server URL trusts proxy HTTPS headers', () => {
  const request = new Request('http://internal-api:8080/swagger-ui', {
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'api.rallar.intactss.com',
    },
  });

  assert.equal(resolvePublicServerUrl(request), 'https://api.rallar.intactss.com');
});

Deno.test('swagger public server URL falls back to request origin', () => {
  const request = new Request('http://localhost:8080/swagger-ui');

  assert.equal(resolvePublicServerUrl(request), 'http://localhost:8080');
});

Deno.test('OpenAPI JSON route publishes the forwarded HTTPS server URL', async () => {
  const app = init(new Hono());
  const response = await app.request('/api/openapi.json', {
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'api.rallar.intactss.com',
    },
  });
  const json = await response.json() as { servers?: readonly { url: string }[] };

  assert.equal(json.servers?.[0]?.url, 'https://api.rallar.intactss.com');
});
