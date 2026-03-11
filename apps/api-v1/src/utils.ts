const ALLOWED_ORIGINS =
    new Set<string>([
            'http://localhost:5173',
            'https://ar-eye-hunter.pages.dev'
        ]
    );

export function toCorsHeaders(req: Request): Headers {
    const headers = new Headers();

    const origin = req.headers.get('origin') ?? '';

    if (ALLOWED_ORIGINS.has(origin)) {
        headers.set('access-control-allow-origin', origin);
        headers.set('vary', 'origin');
    }

    headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
    headers.set('access-control-allow-headers', 'content-type, x-client-id, authorization');
    headers.set('access-control-max-age', '86400');

    return headers;
}

export function withCors(req: Request, res: Response): Response {
    const headers = new Headers(res.headers);

    toCorsHeaders(req)
        .forEach(
            (v, k) => headers.set(k, v)
        );

    return new Response(res.body, { status: res.status, headers: headers });
}
