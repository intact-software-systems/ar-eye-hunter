export function resolvePublicServerUrl(request: Request): string {
    const requestUrl = new URL(request.url);
    const forwarded = parseForwardedHeader(firstHeaderValue(request.headers.get('forwarded')));
    const protocol = normalizeProtocol(
        firstHeaderValue(request.headers.get('x-forwarded-proto')) ??
            forwarded.proto ??
            requestUrl.protocol
    );
    const host = normalizeHost(
        firstHeaderValue(request.headers.get('x-forwarded-host')) ??
            forwarded.host ??
            request.headers.get('host') ??
            requestUrl.host
    );

    return `${protocol}://${host}`;
}

export function withPublicOpenApiServer(
    spec: unknown,
    request: Request,
    description: string
): unknown {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        return spec;
    }

    return {
        ...spec,
        servers: [
            {
                url: resolvePublicServerUrl(request),
                description
            }
        ]
    };
}

function firstHeaderValue(value: string | null): string | undefined {
    const first = value?.split(',')[0]?.trim();
    return first ? stripQuotes(first) : undefined;
}

function parseForwardedHeader(value: string | undefined): { proto?: string; host?: string; } {
    if (!value) {
        return {};
    }

    const result: { proto?: string; host?: string; } = {};
    for (const segment of value.split(';')) {
        const [rawKey, ...rawValue] = segment.split('=');
        const key = rawKey?.trim().toLowerCase();
        const headerValue = stripQuotes(rawValue.join('=').trim());
        if (!key || !headerValue) {
            continue;
        }
        if (key === 'proto') {
            result.proto = headerValue;
        }
        else if (key === 'host') {
            result.host = headerValue;
        }
    }
    return result;
}

function normalizeProtocol(value: string): string {
    const normalized = stripQuotes(value).trim().replace(/:$/, '').toLowerCase();
    return normalized || 'http';
}

function normalizeHost(value: string): string {
    const normalized = stripQuotes(value).trim();
    if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
        return new URL(normalized).host;
    }
    return normalized;
}

function stripQuotes(value: string): string {
    return value.replace(/^"|"$/g, '');
}
