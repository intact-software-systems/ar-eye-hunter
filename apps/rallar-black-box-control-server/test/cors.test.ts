import {
  applyControlCorsHeaders,
  corsOriginsFromAllowedOrigins,
  createControlResponseHeaders,
  resolveCorsAllowOrigin,
} from '../src/cors.ts';

function assertEquals<T>(actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`,
    );
  }
}

Deno.test('control CORS origins default to wildcard when no request policy origins are configured', () => {
  assertEquals(corsOriginsFromAllowedOrigins([]), ['*']);
});

Deno.test('control CORS origins reuse existing request policy origins', () => {
  const origins = ['http://localhost:5176'];

  assertEquals(corsOriginsFromAllowedOrigins(origins), origins);
});

Deno.test('control CORS resolves configured origins from the request origin', () => {
  const origins = ['http://localhost:5176'];

  assertEquals(
    resolveCorsAllowOrigin('http://localhost:5176', origins),
    'http://localhost:5176',
  );
  assertEquals(
    resolveCorsAllowOrigin('http://127.0.0.1:5176', origins),
    undefined,
  );
});

Deno.test('control wildcard CORS uses a literal wildcard response', () => {
  const request = new Request('http://localhost:5180/health', {
    headers: {
      origin: 'http://localhost:5176',
    },
  });
  const response = new Response('{}', {
    headers: createControlResponseHeaders(undefined, {
      contentType: 'application/json',
      corsOrigins: ['*'],
    }),
  });

  applyControlCorsHeaders(request, response, ['*']);

  assertEquals(response.headers.get('access-control-allow-origin'), '*');
  assertEquals(response.headers.get('vary'), null);
});

Deno.test('control response headers use request policy origins when request origin is allowed', () => {
  const request = new Request('http://localhost:5180/health', {
    headers: {
      origin: 'http://localhost:5176',
    },
  });

  const response = new Response('{}', {
    headers: createControlResponseHeaders(undefined, {
      contentType: 'application/json',
      corsOrigins: ['*'],
    }),
  });

  applyControlCorsHeaders(request, response, ['http://localhost:5176']);

  assertEquals(
    response.headers.get('access-control-allow-origin'),
    'http://localhost:5176',
  );
  assertEquals(response.headers.get('vary'), 'Origin');
});

Deno.test('control response headers omit allow-origin when configured origins reject request origin', () => {
  const request = new Request('http://localhost:5180/health', {
    headers: {
      origin: 'http://127.0.0.1:5176',
    },
  });
  const response = new Response('{}', {
    headers: createControlResponseHeaders(undefined, {
      contentType: 'application/json',
      corsOrigins: ['*'],
    }),
  });

  applyControlCorsHeaders(request, response, ['http://localhost:5176']);

  assertEquals(response.headers.get('access-control-allow-origin'), null);
  assertEquals(response.headers.get('vary'), 'Origin');
});

Deno.test('control CORS leaves websocket upgrade responses untouched', () => {
  const request = new Request('http://localhost:5180/control', {
    headers: {
      origin: 'http://localhost:5176',
    },
  });
  const response = {
    status: 101,
    headers: new Headers({
      upgrade: 'websocket',
    }),
  } as Response;

  applyControlCorsHeaders(request, response, ['http://localhost:5176']);

  assertEquals(response.headers.get('access-control-allow-origin'), null);
});
