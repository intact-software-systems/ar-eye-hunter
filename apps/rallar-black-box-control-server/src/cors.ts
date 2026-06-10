const DEFAULT_ALLOW_ORIGINS = ['*'] as const;
const CORS_ALLOW_METHODS = 'GET,POST,DELETE,OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type,Authorization,X-Rallar-Run-Token';

export function corsOriginsFromAllowedOrigins(
  allowedOrigins: readonly string[],
): readonly string[] {
  return allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ALLOW_ORIGINS;
}

export function resolveCorsAllowOrigin(
  requestOrigin: string | null | undefined,
  allowedOrigins: readonly string[],
): string | undefined {
  const origin = requestOrigin?.trim();
  if (allowedOrigins.includes('*')) {
    return '*';
  }

  if (!origin) {
    return undefined;
  }

  return allowedOrigins.includes(origin) ? origin : undefined;
}

export function createControlResponseHeaders(
  request: Request | undefined,
  options: Readonly<{
    contentType?: string;
    extra?: Readonly<Record<string, string>>;
    corsOrigins?: readonly string[];
  }> = {},
): Headers {
  const headers = new Headers(options.extra);
  applyCorsHeaderValues(headers, request, options.corsOrigins ?? DEFAULT_ALLOW_ORIGINS);

  if (options.contentType) {
    headers.set('Content-Type', options.contentType);
  }

  return headers;
}

export function applyControlCorsHeaders(
  request: Request,
  response: Response,
  corsOrigins: readonly string[] = DEFAULT_ALLOW_ORIGINS,
): Response {
  if (response.status === 101) {
    return response;
  }

  applyCorsHeaderValues(response.headers, request, corsOrigins);
  return response;
}

function applyCorsHeaderValues(
  headers: Headers,
  request: Request | undefined,
  corsOrigins: readonly string[],
): void {
  const allowOrigin = resolveCorsAllowOrigin(
    request?.headers.get('origin'),
    corsOrigins,
  );

  if (allowOrigin) {
    headers.set('Access-Control-Allow-Origin', allowOrigin);
  } else {
    headers.delete('Access-Control-Allow-Origin');
  }

  headers.set('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
  headers.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);

  if (!corsOrigins.includes('*')) {
    appendVaryHeader(headers, 'Origin');
  }
}

function appendVaryHeader(headers: Headers, value: string): void {
  const existing = headers.get('Vary');
  if (!existing) {
    headers.set('Vary', value);
    return;
  }

  const values = existing.split(',').map((item) => item.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) {
    headers.set('Vary', `${existing}, ${value}`);
  }
}
